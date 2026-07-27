import { Worker, Job, Queue } from "bullmq";
import { ConnectionOptions } from "bullmq";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { webhookService } from "../services/webhook.service.js";
import { retryPolicyService } from "../services/retryPolicy.service.js";
import { getCustomBackoffStrategies, getCustomBackoffStrategy, DeliveryDLQ } from "./queue.js";

// =============================================================================
// WEBHOOK DELIVERY WORKER
// =============================================================================

const WEBHOOK_QUEUE_NAME = "webhook-delivery";

const webhookConnection: ConnectionOptions = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD,
};

const WEBHOOK_RETRY_POLICY = retryPolicyService.getPolicy({
  operation: "webhook:delivery",
  maxRetries: 7,
  baseDelayMs: 1000,
  maxDelayMs: 3_600_000,
});

let webhookWorker: Worker | null = null;
let webhookQueue: Queue | null = null;

export async function initWebhookWorker(): Promise<void> {
  if (webhookWorker) {
    logger.warn("Webhook worker already initialized");
    return;
  }

  webhookWorker = new Worker(
    WEBHOOK_QUEUE_NAME,
    async (job: Job) => {
      logger.info(
        { jobId: job.id, attempt: job.attemptsMade + 1 },
        "Processing webhook delivery"
      );

      try {
        const result = await webhookService.processDelivery(job);
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        // Estimate next retry delay for observability.
        const delay = retryPolicyService.getDelayMs(job.attemptsMade + 1, {
          operation: "webhook:delivery",
          ...WEBHOOK_RETRY_POLICY,
        });

        logger.error(
          { jobId: job.id, attempt: job.attemptsMade + 1, error: errorMessage, nextRetryIn: delay },
          "Webhook delivery failed, will retry"
        );

        // Throw error to trigger BullMQ retry with backoff
        throw new Error(`Webhook delivery failed: ${errorMessage}`);
      }
    },
    {
      connection: webhookConnection,
      concurrency: 10, // Process up to 10 deliveries concurrently
      limiter: {
        max: 100, // Max 100 jobs per second across all endpoints
        duration: 1000,
      },
      settings: {
        backoffStrategy: getCustomBackoffStrategy(),
      },
    }
  );

  // Event handlers
  webhookWorker.on("completed", (job: Job) => {
    logger.info(
      { jobId: job.id, webhookEndpointId: job.data.webhookEndpointId },
      "Webhook delivery job completed"
    );
  });

  webhookWorker.on("failed", async (job: Job | undefined, err: Error) => {
    if (!job) return;

    const errorMessage = err.message;

    // Check if we've exceeded max attempts
    if (job.attemptsMade >= WEBHOOK_RETRY_POLICY.maxRetries) {
      logger.error(
        { jobId: job.id, webhookEndpointId: job.data.webhookEndpointId, attempts: job.attemptsMade },
        "Webhook delivery failed permanently after max retries"
      );

      // Update delivery status to failed
      try {
        const { webhookService } = await import("../services/webhook.service.js");
        await webhookService.updateDeliveryStatus(job.data.deliveryId, "failed", undefined, errorMessage);
      } catch (updateError) {
        logger.error({ jobId: job.id }, "Failed to update delivery status after max retries");
      }

      // Move to Dead-Letter Queue
      try {
        await DeliveryDLQ.getInstance().moveToDLQ({
          queue_name: WEBHOOK_QUEUE_NAME,
          job_name: job.name || WEBHOOK_QUEUE_NAME,
          payload: job.data,
          attempts: job.attemptsMade,
          last_error: errorMessage,
          last_response: job.returnvalue || null,
        });
      } catch (dlqError) {
        logger.error({ jobId: job.id, err: dlqError }, "Failed to move webhook delivery to DLQ after max retries");
      }
    }
  });

  webhookWorker.on("error", (err: Error) => {
    logger.error({ error: err.message }, "Webhook worker error");
  });

  webhookWorker.on("stalled", (jobId: string) => {
    logger.warn({ jobId }, "Webhook delivery job stalled");
  });

  logger.info("Webhook delivery worker initialized");
}

export async function stopWebhookWorker(): Promise<void> {
  if (webhookWorker) {
    await webhookWorker.close();
    webhookWorker = null;
    logger.info("Webhook delivery worker stopped");
  }
  if (webhookQueue) {
    await webhookQueue.close();
    webhookQueue = null;
  }
}

export function getWebhookWorker(): Worker | null {
  return webhookWorker;
}

export function getWebhookQueue(): Queue {
  if (!webhookQueue) {
    webhookQueue = new Queue(WEBHOOK_QUEUE_NAME, {
      connection: webhookConnection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }
  return webhookQueue;
}
