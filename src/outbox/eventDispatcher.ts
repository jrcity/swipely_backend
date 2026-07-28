import type { Knex } from "knex";
import { Queue, Worker, Job } from "bullmq";
import { logger } from "../utils/logger.js";
import { OutboxProducer, OutboxEventRecord } from "./eventProducer.js";
import { config } from "../config/index.js";

export interface DispatcherConfig {
  batchSize: number;
  pollIntervalMs: number;
  maxRetries: number;
  concurrency: number;
  queueName: string;
}

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  batchSize: 100,
  pollIntervalMs: 1000,
  maxRetries: 5,
  concurrency: 10,
  queueName: "outbox-dispatcher",
};

export class OutboxDispatcher {
  private outboxProducer: OutboxProducer;
  private dispatchQueue: Queue;
  private dispatchWorker: Worker;
  private pollingTimer: NodeJS.Timeout | null = null;
  private pollingPromise: Promise<void> | null = null;
  private isRunning = false;
  private isDraining = false;

  constructor(
    private db: Knex,
    private dispatcherConfig: DispatcherConfig = DEFAULT_DISPATCHER_CONFIG
  ) {
    this.outboxProducer = new OutboxProducer(db);
    
    // Initialize BullMQ queue for event dispatch
    this.dispatchQueue = new Queue(dispatcherConfig.queueName, {
      connection: {
        host: (config as any).REDIS_HOST ?? "localhost",
        port: (config as any).REDIS_PORT ?? 6379,
        password: (config as any).REDIS_PASSWORD || undefined,
      },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 1, // Retries handled by outbox pattern, not BullMQ
      },
    });

    // Initialize worker for processing dispatch jobs
    this.dispatchWorker = new Worker(
      dispatcherConfig.queueName,
      this.processDispatchJob.bind(this),
      {
        connection: {
          host: (config as any).REDIS_HOST ?? "localhost",
          port: (config as any).REDIS_PORT ?? 6379,
          password: (config as any).REDIS_PASSWORD || undefined,
        },
        concurrency: dispatcherConfig.concurrency,
      }
    );

    this.setupWorkerEventHandlers();
  }

  /**
   * Start the outbox dispatcher
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Outbox dispatcher is already running");
      return;
    }

    this.isRunning = true;
    this.isDraining = false;
    logger.info("Starting outbox dispatcher");

    // Start polling for pending events
    this.pollingTimer = setInterval(
      () => { this.pollingPromise = this.pollAndDispatch(); },
      this.dispatcherConfig.pollIntervalMs
    );

    logger.info(
      {
        batchSize: this.dispatcherConfig.batchSize,
        pollIntervalMs: this.dispatcherConfig.pollIntervalMs,
        concurrency: this.dispatcherConfig.concurrency,
      },
      "Outbox dispatcher started"
    );
  }

  /**
   * Stop the outbox dispatcher
   */
  async stop(): Promise<void> {
    if (!this.isRunning && !this.isDraining) {
      return;
    }

    await this.beginDrain();
    logger.info("Draining outbox dispatcher");

    // Close worker and queue
    await this.dispatchWorker.close();
    await this.dispatchQueue.close();

    logger.info("Outbox dispatcher stopped");
  }

  async beginDrain(): Promise<void> {
    if (this.isDraining) return;

    this.isDraining = true;
    this.isRunning = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    await this.dispatchWorker.pause();
    await this.pollingPromise;
    logger.info("Outbox dispatcher intake paused");
  }

  /**
   * Poll for pending events and dispatch them
   */
  private async pollAndDispatch(): Promise<void> {
    try {
      if (!this.isRunning || this.isDraining) return;
      const pendingEvents = await this.outboxProducer.getPendingEvents(
        this.dispatcherConfig.batchSize,
        true // skipLocked to prevent duplicate processing
      );

      if (pendingEvents.length === 0 || this.isDraining) {
        return;
      }

      logger.debug(
        { count: pendingEvents.length },
        "Found pending events to dispatch"
      );

      // Queue each event for processing
      const jobs = pendingEvents.map(event => ({
        name: "dispatch-event",
        data: { eventId: event.id },
        opts: {
          jobId: `outbox-${event.id}`, // Prevent duplicate jobs
        },
      }));

      await this.dispatchQueue.addBulk(jobs);

    } catch (error) {
      logger.error({ error }, "Error polling for pending events");
    }
  }

  /**
   * Process a single dispatch job
   */
  private async processDispatchJob(job: Job): Promise<void> {
    const { eventId } = job.data;
    
    try {
      await this.db.transaction(async (tx) => {
        // Get event details with row lock
        const [event] = await tx("outbox_events")
          .select("*")
          .where({ id: eventId })
          .forUpdate();

        if (!event) {
          logger.warn({ eventId }, "Event not found, skipping");
          return;
        }

        // Double-check event is still pending (race condition protection)
        if (event.status !== "pending") {
          logger.debug(
            { eventId, status: event.status },
            "Event no longer pending, skipping"
          );
          return;
        }

        // Mark as processing
        const marked = await tx("outbox_events")
          .where({ id: eventId, status: "pending" })
          .update({ status: "processing" });
        if (marked === 0) {
          logger.debug({ eventId }, "Event already being processed, skipping");
          return;
        }

        // Dispatch the event
        await this.dispatchEvent(event);

        // Mark as delivered
        await tx("outbox_events")
          .where({ id: eventId })
          .update({ status: "delivered", delivered_at: new Date() });

        logger.debug(
          {
            eventId,
            eventType: event.event_type,
            aggregateId: event.aggregate_id,
          },
          "Event dispatched successfully"
        );
      });

    } catch (error) {
      logger.error(
        { eventId, error: error.message },
        "Failed to dispatch event"
      );

      // Mark for retry
      await this.outboxProducer.markForRetry(
        eventId,
        error.message,
        this.dispatcherConfig.maxRetries
      );
    }
  }

  /**
   * Dispatch a single event to the appropriate handler
   */
  private async dispatchEvent(event: any): Promise<void> {
    const eventRecord: OutboxEventRecord = {
      id: event.id.toString(),
      aggregateType: event.aggregate_type,
      aggregateId: event.aggregate_id,
      sequenceNo: event.sequence_no.toString(),
      eventType: event.event_type,
      payload: typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload,
      metadata: typeof event.metadata === "string" ? JSON.parse(event.metadata) : event.metadata,
      status: event.status,
      retryCount: event.retry_count,
      retryAfter: event.retry_after,
      deliveredAt: event.delivered_at,
      errorMessage: event.error_message,
      createdAt: event.created_at,
    };

    // Route to appropriate handler based on event type
    switch (eventRecord.eventType) {
      case "webhook.delivery":
      case "webhook.batch_delivery":
        await this.dispatchWebhookEvent(eventRecord);
        break;
      
      case "alert.triggered":
      case "alert.resolved":
      case "alert.acknowledged":
      case "alert.closed":
        await this.dispatchAlertEvent(eventRecord);
        break;
      
      case "discord.alert":
        await this.dispatchDiscordEvent(eventRecord);
        break;
      
      case "digest.scheduled":
        await this.dispatchDigestEvent(eventRecord);
        break;
      
      default:
        // For unknown event types, dispatch to generic handler
        await this.dispatchGenericEvent(eventRecord);
    }
  }

  /**
   * Dispatch webhook events to existing webhook service
   */
  private async dispatchWebhookEvent(event: OutboxEventRecord): Promise<void> {
    // Import webhook service dynamically to avoid circular dependencies
    const { WebhookService } = await import("../services/webhook.service.js");
    const webhookService = WebhookService.getInstance();

    if (event.eventType === "webhook.delivery") {
      // Queue individual webhook delivery
      await webhookService.queueDelivery({
        webhookEndpointId: event.payload.webhookEndpointId,
        eventType: event.payload.eventType,
        payload: event.payload.payload,
        scheduledAt: event.payload.scheduledAt,
      });
    } else if (event.eventType === "webhook.batch_delivery") {
      // Queue batch webhook delivery
      await webhookService.queueBatchDelivery({
        webhookEndpointId: event.payload.webhookEndpointId,
        eventType: event.payload.eventType,
        events: event.payload.events,
      });
    }
  }

  /**
   * Dispatch alert events (for external integrations)
   */
  private async dispatchAlertEvent(event: OutboxEventRecord): Promise<void> {
    // This could dispatch to external monitoring systems, Slack, etc.
    logger.info(
      {
        eventType: event.eventType,
        alertId: event.payload.alertId,
        assetCode: event.payload.assetCode,
      },
      "Alert event dispatched"
    );
    
    // Example: Send to external monitoring system
    // await this.sendToExternalMonitoring(event);
  }

  /**
   * Dispatch Discord events
   */
  private async dispatchDiscordEvent(event: OutboxEventRecord): Promise<void> {
    const { DiscordService } = await import("../services/discord.service.js");
    const discordService = new DiscordService();

    await discordService.sendAlert({
      id: event.id,
      type: event.payload.alertData?.type ?? "bridge",
      severity: event.payload.alertData?.severity ?? "medium",
      title: event.payload.embed?.title ?? "Alert",
      description: event.payload.embed?.description ?? "",
      metadata: event.payload.alertData ?? {},
      timestamp: new Date(),
    });
  }

  /**
   * Dispatch digest events
   */
  private async dispatchDigestEvent(event: OutboxEventRecord): Promise<void> {
    const { DigestSchedulerService } = await import("../services/digestScheduler.service.js");
    const digestService = DigestSchedulerService.getInstance();

    // generateDigests processes all eligible subscriptions for a given type
    if (event.payload.digestType) {
      await digestService.generateDigests(event.payload.digestType);
    }
  }

  /**
   * Generic event dispatcher for unknown event types
   */
  private async dispatchGenericEvent(event: OutboxEventRecord): Promise<void> {
    logger.info(
      {
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
      },
      "Generic event dispatched"
    );
    
    // Could implement plugin system here for custom event handlers
  }

  /**
   * Setup worker event handlers for monitoring
   */
  private setupWorkerEventHandlers(): void {
    this.dispatchWorker.on("completed", (job) => {
      logger.debug(
        { jobId: job.id, eventId: job.data.eventId },
        "Dispatch job completed"
      );
    });

    this.dispatchWorker.on("failed", (job, err) => {
      logger.error(
        {
          jobId: job?.id,
          eventId: job?.data?.eventId,
          error: err.message,
        },
        "Dispatch job failed"
      );
    });

    this.dispatchWorker.on("error", (err) => {
      logger.error({ error: err.message }, "Dispatch worker error");
    });
  }

  /**
   * Get dispatcher statistics
   */
  async getStats(): Promise<{
    pending: number;
    processing: number;
    delivered: number;
    failed: number;
    queueWaiting: number;
    queueActive: number;
  }> {
    const [pendingResult] = await this.db("outbox_events")
      .count("* as count")
      .where("status", "pending");
    
    const [processingResult] = await this.db("outbox_events")
      .count("* as count")
      .where("status", "processing");
    
    const [deliveredResult] = await this.db("outbox_events")
      .count("* as count")
      .where("status", "delivered");
    
    const [failedResult] = await this.db("outbox_events")
      .count("* as count")
      .where("status", "failed");

    const queueWaiting = await this.dispatchQueue.getWaiting();
    const queueActive = await this.dispatchQueue.getActive();

    return {
      pending: parseInt(pendingResult.count as string),
      processing: parseInt(processingResult.count as string),
      delivered: parseInt(deliveredResult.count as string),
      failed: parseInt(failedResult.count as string),
      queueWaiting: queueWaiting.length,
      queueActive: queueActive.length,
    };
  }
}
