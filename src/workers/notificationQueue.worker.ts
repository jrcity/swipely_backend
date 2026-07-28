import { Queue, Worker, Job } from "bullmq";
import { ConnectionOptions } from "bullmq";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { retryPolicyService } from "../services/retryPolicy.service.js";
import { getMetricsService } from "../utils/metrics.js";
import { getCustomBackoffStrategies, getCustomBackoffStrategy, DeliveryDLQ } from "./queue.js";

// =============================================================================
// NOTIFICATION QUEUE WORKER
// =============================================================================

const NOTIFICATION_QUEUE_NAME = "notification-delivery";

const notificationConnection: ConnectionOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD,
};

const NOTIFICATION_RETRY_POLICY = retryPolicyService.getPolicy({
  operation: "notification:delivery",
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 900_000,
});

export type NotificationChannel = "email" | "webhook" | "in_app";
export type NotificationPriority = "critical" | "high" | "medium" | "low";

export interface NotificationJobData {
  notificationId: string;
  channel: NotificationChannel;
  priority: NotificationPriority;
  payload: Record<string, any>;
  metadata?: Record<string, any>;
}

export type NotificationDeliveryStatus =
  | "queued"
  | "processing"
  | "delivered"
  | "failed"
  | "dead_letter";

const PRIORITY_MAP: Record<NotificationPriority, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

let notificationQueue: Queue | null = null;
let notificationWorker: Worker | null = null;

/**
 * Enqueue a notification for delivery.
 */
export async function enqueueNotification(
  data: NotificationJobData
): Promise<string> {
  const queue = getNotificationQueue();
  const job = await queue.add("notification-delivery", data, {
    priority: PRIORITY_MAP[data.priority] ?? PRIORITY_MAP.medium,
    attempts: NOTIFICATION_RETRY_POLICY.maxRetries + 1,
    backoff: retryPolicyService.getBullMQBackoff({
      operation: "notification:delivery",
    }),
  });

  const metrics = getMetricsService();
  metrics.recordCustomMetric("notification_delivery_total", 1, "count", {
    channel: data.channel,
    priority: data.priority,
    status: "queued",
  });

  logger.info(
    {
      jobId: job.id,
      notificationId: data.notificationId,
      channel: data.channel,
      priority: data.priority,
    },
    "Notification enqueued for delivery"
  );

  return job.id!;
}

/**
 * Initialize the notification queue worker.
 */
export async function initNotificationQueueWorker(): Promise<void> {
  if (notificationWorker) {
    logger.warn("Notification queue worker already initialized");
    return;
  }

  notificationWorker = new Worker(
    NOTIFICATION_QUEUE_NAME,
    async (job: Job<NotificationJobData>) => {
      const startTime = Date.now();
      const { channel, notificationId } = job.data;

      logger.info(
        { jobId: job.id, notificationId, channel, attempt: job.attemptsMade + 1 },
        "Processing notification delivery"
      );

      try {
        await deliverNotification(job);

        const duration = Date.now() - startTime;
        const metrics = getMetricsService();
        metrics.recordQueueJob("notification-delivery", duration, "success");
        metrics.recordCustomMetric("notification_delivery_total", 1, "count", {
          channel,
          priority: job.data.priority,
          status: "delivered",
        });

        return { delivered: true, channel, notificationId };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        const duration = Date.now() - startTime;
        const metrics = getMetricsService();
        metrics.recordQueueJob("notification-delivery", duration, "failure");

        const delay = retryPolicyService.getDelayMs(job.attemptsMade + 1, {
          operation: "notification:delivery",
          ...NOTIFICATION_RETRY_POLICY,
        });

        logger.error(
          {
            jobId: job.id,
            notificationId,
            channel,
            attempt: job.attemptsMade + 1,
            error: errorMessage,
            nextRetryIn: delay,
          },
          "Notification delivery failed, will retry"
        );

        throw new Error(`Notification delivery failed: ${errorMessage}`);
      }
    },
    {
      connection: notificationConnection,
      concurrency: 10,
      limiter: {
        max: 100,
        duration: 1000,
      },
      settings: {
        backoffStrategy: getCustomBackoffStrategy(),
      },
    }
  );

  // Event handlers
  notificationWorker.on("completed", (job: Job<NotificationJobData>) => {
    logger.info(
      {
        jobId: job.id,
        notificationId: job.data.notificationId,
        channel: job.data.channel,
      },
      "Notification delivery job completed"
    );
  });

  notificationWorker.on(
    "failed",
    async (job: Job<NotificationJobData> | undefined, err: Error) => {
      if (!job) return;

      if (job.attemptsMade >= NOTIFICATION_RETRY_POLICY.maxRetries) {
        logger.error(
          {
            jobId: job.id,
            notificationId: job.data.notificationId,
            channel: job.data.channel,
            attempts: job.attemptsMade,
            error: err.message,
          },
          "Notification moved to dead letter after max retries"
        );

        const metrics = getMetricsService();
        metrics.recordCustomMetric(
          "notification_dead_letter_total",
          1,
          "count",
          {
            channel: job.data.channel,
            priority: job.data.priority,
          }
        );

        try {
          await DeliveryDLQ.getInstance().moveToDLQ({
            queue_name: NOTIFICATION_QUEUE_NAME,
            job_name: job.name || NOTIFICATION_QUEUE_NAME,
            payload: job.data,
            attempts: job.attemptsMade,
            last_error: err.message,
            last_response: job.returnvalue || null,
          });
        } catch (dlqErr) {
          logger.error({ jobId: job.id, err: dlqErr }, "Failed to move notification to DLQ after max retries");
        }
      }
    }
  );

  notificationWorker.on("error", (err: Error) => {
    logger.error({ error: err.message }, "Notification queue worker error");
  });

  notificationWorker.on("stalled", (jobId: string) => {
    logger.warn({ jobId }, "Notification delivery job stalled");
  });

  logger.info("Notification queue worker initialized");
}

/**
 * Stop the notification queue worker.
 */
export async function stopNotificationQueueWorker(): Promise<void> {
  if (notificationWorker) {
    await notificationWorker.pause();
    await notificationWorker.close();
    notificationWorker = null;
    logger.info("Notification queue worker stopped");
  }
  if (notificationQueue) {
    await notificationQueue.close();
    notificationQueue = null;
  }
}

export async function pauseNotificationQueueWorker(): Promise<void> {
  await notificationWorker?.pause();
}

/**
 * Get or create the notification queue instance.
 */
export function getNotificationQueue(): Queue {
  if (!notificationQueue) {
    notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
      connection: notificationConnection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }
  return notificationQueue;
}

// =============================================================================
// CHANNEL DISPATCH
// =============================================================================

async function deliverNotification(
  job: Job<NotificationJobData>
): Promise<void> {
  const { channel, payload, metadata } = job.data;

  switch (channel) {
    case "email":
      await deliverEmail(payload, metadata);
      break;
    case "webhook":
      await deliverWebhook(payload, metadata);
      break;
    case "in_app":
      await deliverInApp(payload, metadata);
      break;
    default:
      logger.warn(
        { channel, jobId: job.id },
        "Unknown notification channel, skipping"
      );
  }
}

async function deliverEmail(
  payload: Record<string, any>,
  metadata?: Record<string, any>
): Promise<void> {
  const { emailNotificationService } = await import(
    "../services/email.service.js"
  );
  await emailNotificationService.sendAlertEmail(
    payload.recipient,
    payload.alertPayload,
    payload.context
  );
}

async function deliverWebhook(
  payload: Record<string, any>,
  metadata?: Record<string, any>
): Promise<void> {
  const { webhookService } = await import("../services/webhook.service.js");
  await webhookService.processDelivery({
    id: payload.deliveryId,
    data: payload,
    attemptsMade: 0,
  } as any);
}

async function deliverInApp(
  payload: Record<string, any>,
  metadata?: Record<string, any>
): Promise<void> {
  const { wsServer } = await import("../api/websocket/websocket.server.js");
  await wsServer.broadcastToChannel("alerts", {
    type: "alert_triggered",
    channel: "alerts",
    data: {
      ruleId: payload.ruleId || "unknown",
      assetCode: payload.assetCode || "ALL",
      alertType: payload.alertType || "notification",
      priority: payload.priority || "medium",
      triggeredValue: payload.triggeredValue || 0,
      threshold: payload.threshold || 0,
      metric: payload.metric || "custom",
      timestamp: payload.timestamp || new Date().toISOString(),
      ...payload,
    },
    timestamp: new Date().toISOString(),
  } as any);
}
