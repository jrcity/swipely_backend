import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeliveryDLQ, getCustomBackoffStrategies, JobQueue } from "../../src/workers/queue.js";
import { retryPolicyService } from "../../src/services/retryPolicy.service.js";

vi.mock("../../src/database/connection.js", () => ({
  getDatabase: () => () => {
    throw new Error("Mock DB not connected in test");
  },
}));

// Hoist mocks
const mockAddWebhook = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "replayed-webhook-job" }));
const mockAddNotif = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "replayed-notif-job" }));
const mockAddJob = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "replayed-priority-job" }));

vi.mock("../../src/workers/webhookDelivery.worker.js", () => ({
  getWebhookQueue: () => ({
    add: mockAddWebhook,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../src/workers/notificationQueue.worker.js", () => ({
  enqueueNotification: mockAddNotif,
  getNotificationQueue: () => ({
    add: mockAddNotif,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("bullmq", () => {
  const mockQueue = {
    add: vi.fn().mockResolvedValue({ id: "mock-job" }),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    Queue: vi.fn(() => mockQueue),
    Worker: vi.fn(() => ({
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

describe("DeliveryDLQ and Custom Backoff Strategies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("DeliveryDLQ", () => {
    it("moves permanently failed messages to DLQ with payload, attempt count, error, and timestamp", async () => {
      const dlq = DeliveryDLQ.getInstance();
      const payload = { test: "data", deliveryId: "del-100" };

      const dlqId = await dlq.moveToDLQ({
        queue_name: "webhook-delivery",
        job_name: "webhook-job",
        payload,
        attempts: 7,
        last_error: "Connection timeout after max retries",
        last_response: { status: 504 },
      });

      expect(dlqId).toBeDefined();
      expect(typeof dlqId).toBe("string");

      const items = await dlq.list();
      const found = items.find((i) => i.id === dlqId);
      expect(found).toBeDefined();
      expect(found?.queue_name).toBe("webhook-delivery");
      expect(found?.attempts).toBe(7);
      expect(found?.last_error).toBe("Connection timeout after max retries");
      expect(found?.payload).toEqual(payload);
      expect(found?.failed_at).toBeDefined();
    });

    it("lists DLQ entries with optional queue filtering", async () => {
      const dlq = DeliveryDLQ.getInstance();

      await dlq.moveToDLQ({
        queue_name: "webhook-delivery",
        job_name: "webhook-1",
        payload: { id: 1 },
        attempts: 5,
      });

      await dlq.moveToDLQ({
        queue_name: "notification-delivery",
        job_name: "notif-1",
        payload: { id: 2 },
        attempts: 3,
      });

      const webhooks = await dlq.list("webhook-delivery");
      expect(webhooks.every((item) => item.queue_name === "webhook-delivery")).toBe(true);

      const notifs = await dlq.list("notification-delivery");
      expect(notifs.every((item) => item.queue_name === "notification-delivery")).toBe(true);
    });

    it("replays a webhook-delivery job and discards from DLQ", async () => {
      const dlq = DeliveryDLQ.getInstance();

      const dlqId = await dlq.moveToDLQ({
        queue_name: "webhook-delivery",
        job_name: "webhook-delivery",
        payload: { endpoint: "https://example.com" },
        attempts: 7,
      });

      const result = await dlq.replay(dlqId);
      expect(result).toBe(true);
      expect(mockAddWebhook).toHaveBeenCalledWith(
        "webhook-delivery",
        expect.objectContaining({ endpoint: "https://example.com" })
      );

      // Confirm it was discarded after replay
      const items = await dlq.list();
      expect(items.some((i) => i.id === dlqId)).toBe(false);
    });

    it("replays a notification-delivery job and discards from DLQ", async () => {
      const dlq = DeliveryDLQ.getInstance();

      const dlqId = await dlq.moveToDLQ({
        queue_name: "notification-delivery",
        job_name: "notification-delivery",
        payload: { notificationId: "notif-xyz", channel: "email" },
        attempts: 5,
      });

      const result = await dlq.replay(dlqId);
      expect(result).toBe(true);
      expect(mockAddNotif).toHaveBeenCalledWith(
        expect.objectContaining({ notificationId: "notif-xyz", channel: "email" })
      );

      // Confirm it was discarded after replay
      const items = await dlq.list();
      expect(items.some((i) => i.id === dlqId)).toBe(false);
    });

    it("discards an entry from DLQ directly", async () => {
      const dlq = DeliveryDLQ.getInstance();

      const dlqId = await dlq.moveToDLQ({
        queue_name: "webhook-delivery",
        job_name: "webhook-to-discard",
        payload: {},
        attempts: 5,
      });

      let items = await dlq.list();
      expect(items.some((i) => i.id === dlqId)).toBe(true);

      const discarded = await dlq.discard(dlqId);
      expect(discarded).toBe(true);

      items = await dlq.list();
      expect(items.some((i) => i.id === dlqId)).toBe(false);
    });
  });

  describe("Custom Backoff Strategies", () => {
    it("provides exponential and custom-exponential strategies that delegate to retryPolicyService", () => {
      const strategies = getCustomBackoffStrategies();
      expect(typeof strategies.exponential).toBe("function");
      expect(typeof strategies["custom-exponential"]).toBe("function");

      const spy = vi.spyOn(retryPolicyService, "getDelayMs").mockReturnValue(4200);

      const mockJob = { name: "webhook:delivery" } as any;
      const delay = strategies.exponential(3, "exponential", new Error("test"), mockJob);

      expect(spy).toHaveBeenCalledWith(3, { operation: "webhook:delivery" });
      expect(delay).toBe(4200);
    });
  });
});
