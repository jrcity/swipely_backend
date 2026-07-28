import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockDb } from "../helpers/knexMock.js";
import { DigestSchedulerService } from "../../src/services/digestScheduler.service.js";
import type {
  DigestSubscription,
  DigestDelivery,
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
} from "../../src/services/digestScheduler.service.js";

const mockDb = () =>
  createMockDb([
    "digest_subscriptions",
    "digest_deliveries",
    "digest_items",
    "alert_events",
    "alert_rules",
  ]);

vi.mock("../../src/database/connection.js", () => ({
  getDatabase: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../src/services/email.service.js", () => ({
  EmailNotificationService: class {
    sendDigestEmail = vi.fn().mockResolvedValue(undefined);
  },
}));

describe("DigestSchedulerService", () => {
  let service: DigestSchedulerService;
  let db: any;

  beforeEach(async () => {
    const { getDatabase } = await import("../../src/database/connection.js");
    db = mockDb();
    vi.mocked(getDatabase).mockReturnValue(db);
    service = DigestSchedulerService.getInstance();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createSubscription", () => {
    it("creates a new subscription with default values", async () => {
      const input: CreateSubscriptionInput = {
        userAddress: "GABC123",
        email: "user@example.com",
      };

      db("digest_subscriptions").first.mockResolvedValueOnce(null);

      const subscription = await service.createSubscription(input);

      expect(subscription).toBeDefined();
      expect(subscription.userAddress).toBe("GABC123");
      expect(subscription.email).toBe("user@example.com");
      expect(subscription.dailyEnabled).toBe(true);
      expect(subscription.weeklyEnabled).toBe(true);
      expect(subscription.timezone).toBe("UTC");
      expect(subscription.preferredHour).toBe(9);
    });

    it("creates subscription with custom settings", async () => {
      const input: CreateSubscriptionInput = {
        userAddress: "GDEF456",
        email: "custom@example.com",
        dailyEnabled: false,
        weeklyEnabled: true,
        timezone: "America/New_York",
        preferredHour: 14,
        preferredDayOfWeek: 3,
        quietHours: { start: 23, end: 8 },
        includedAlertTypes: ["price_deviation", "supply_mismatch"],
        includedSeverities: ["critical"],
        includeTrends: false,
        includeUnresolved: true,
      };

      db("digest_subscriptions").first.mockResolvedValueOnce(null);

      const subscription = await service.createSubscription(input);

      expect(subscription.dailyEnabled).toBe(false);
      expect(subscription.weeklyEnabled).toBe(true);
      expect(subscription.timezone).toBe("America/New_York");
      expect(subscription.preferredHour).toBe(14);
      expect(subscription.preferredDayOfWeek).toBe(3);
      expect(subscription.quietHours).toEqual({ start: 23, end: 8 });
      expect(subscription.includedAlertTypes).toEqual(["price_deviation", "supply_mismatch"]);
      expect(subscription.includedSeverities).toEqual(["critical"]);
    });

    it("throws error when subscription already exists", async () => {
      const existingSubscription = {
        user_address: "GABC123",
        email: "user@example.com",
      };

      db("digest_subscriptions").first.mockResolvedValueOnce(existingSubscription);

      const input: CreateSubscriptionInput = {
        userAddress: "GABC123",
        email: "user@example.com",
      };

      await expect(service.createSubscription(input)).rejects.toThrow(
        "Digest subscription already exists for user: GABC123"
      );
    });
  });

  describe("updateSubscription", () => {
    it("updates an existing subscription", async () => {
      const existingSubscription = {
        user_address: "GABC123",
        email: "user@example.com",
        daily_enabled: true,
        weekly_enabled: true,
      };

      db("digest_subscriptions").where.mockReturnThis();
      db("digest_subscriptions").returning.mockResolvedValueOnce([
        {
          ...existingSubscription,
          daily_enabled: false,
          timezone: "America/Los_Angeles",
          quiet_hours: JSON.stringify({ start: 22, end: 7 }),
          included_alert_types: JSON.stringify([]),
          included_severities: JSON.stringify([]),
          updated_at: new Date(),
        },
      ]);

      const updates: UpdateSubscriptionInput = {
        dailyEnabled: false,
        timezone: "America/Los_Angeles",
      };

      const subscription = await service.updateSubscription("GABC123", updates);

      expect(subscription).toBeDefined();
      expect(db("digest_subscriptions").update).toHaveBeenCalled();
    });

    it("throws error when subscription not found", async () => {
      db("digest_subscriptions").returning.mockResolvedValueOnce([]);

      const updates: UpdateSubscriptionInput = {
        dailyEnabled: false,
      };

      await expect(service.updateSubscription("NONEXISTENT", updates)).rejects.toThrow(
        "Subscription not found for user: NONEXISTENT"
      );
    });

    it("updates all subscription fields", async () => {
      const updates: UpdateSubscriptionInput = {
        dailyEnabled: false,
        weeklyEnabled: false,
        timezone: "Europe/London",
        preferredHour: 8,
        preferredDayOfWeek: 1,
        quietHours: { start: 22, end: 6 },
        includedAlertTypes: ["health_score_drop"],
        includedSeverities: ["high", "critical"],
        includeTrends: false,
        includeUnresolved: false,
        isActive: false,
      };

      db("digest_subscriptions").returning.mockResolvedValueOnce([
        {
          user_address: "GABC123",
          ...updates,
          quiet_hours: JSON.stringify({ start: 22, end: 6 }),
          included_alert_types: JSON.stringify(["health_score_drop"]),
          included_severities: JSON.stringify(["high", "critical"]),
          updated_at: new Date(),
        },
      ]);

      await service.updateSubscription("GABC123", updates);

      const updateCall = db("digest_subscriptions").update.mock.calls[0][0];
      expect(updateCall.daily_enabled).toBe(false);
      expect(updateCall.weekly_enabled).toBe(false);
      expect(updateCall.is_active).toBe(false);
    });
  });

  describe("getSubscription", () => {
    it("retrieves a subscription by user address", async () => {
      const mockSubscription = {
        id: "sub-123",
        user_address: "GABC123",
        email: "user@example.com",
        daily_enabled: true,
        weekly_enabled: true,
        timezone: "UTC",
        preferred_hour: 9,
        preferred_day_of_week: 1,
        quiet_hours: JSON.stringify({ start: 22, end: 7 }),
        included_alert_types: JSON.stringify([]),
        included_severities: JSON.stringify(["high", "critical"]),
        include_trends: true,
        include_unresolved: true,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      db("digest_subscriptions").first.mockResolvedValueOnce(mockSubscription);

      const subscription = await service.getSubscription("GABC123");

      expect(subscription).toBeDefined();
      expect(subscription?.userAddress).toBe("GABC123");
      expect(subscription?.quietHours).toEqual({ start: 22, end: 7 });
    });

    it("returns null when subscription not found", async () => {
      db("digest_subscriptions").first.mockResolvedValueOnce(null);

      const subscription = await service.getSubscription("NONEXISTENT");

      expect(subscription).toBeNull();
    });
  });

  describe("listActiveSubscriptions", () => {
    it("retrieves all active subscriptions", async () => {
      const mockSubscriptions = [
        {
          user_address: "USER1",
          email: "user1@example.com",
          daily_enabled: true,
          weekly_enabled: true,
          is_active: true,
          quiet_hours: JSON.stringify({ start: 22, end: 7 }),
          included_alert_types: JSON.stringify([]),
          included_severities: JSON.stringify(["high"]),
        },
        {
          user_address: "USER2",
          email: "user2@example.com",
          daily_enabled: true,
          weekly_enabled: false,
          is_active: true,
          quiet_hours: JSON.stringify({ start: 23, end: 8 }),
          included_alert_types: JSON.stringify([]),
          included_severities: JSON.stringify(["critical"]),
        },
      ];

      db.__store.digest_subscriptions.push(...mockSubscriptions);

      const subscriptions = await service.listActiveSubscriptions();

      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[0].userAddress).toBe("USER1");
    });

    it("filters subscriptions by digest type", async () => {
      const mockSubscriptions = [
        {
          user_address: "USER1",
          daily_enabled: true,
          weekly_enabled: true,
          is_active: true,
          quiet_hours: JSON.stringify({ start: 22, end: 7 }),
          included_alert_types: JSON.stringify([]),
          included_severities: JSON.stringify([]),
        },
      ];

      db.__store.digest_subscriptions.push(...mockSubscriptions);

      await service.listActiveSubscriptions("daily");

      expect(db("digest_subscriptions").where).toHaveBeenCalledWith({ is_active: true });
      expect(db("digest_subscriptions").where).toHaveBeenCalledWith({ daily_enabled: true });
    });
  });

  describe("deleteSubscription", () => {
    it("deletes a subscription", async () => {
      await service.deleteSubscription("GABC123");

      expect(db("digest_subscriptions").delete).toHaveBeenCalled();
      expect(db("digest_subscriptions").where).toHaveBeenCalledWith({
        user_address: "GABC123",
      });
    });
  });

  describe("generateDigests", () => {
    it("generates digests for eligible subscriptions", async () => {
      const mockSubscriptions: DigestSubscription[] = [
        {
          id: "sub-1",
          userAddress: "USER1",
          email: "user1@example.com",
          dailyEnabled: true,
          weeklyEnabled: true,
          timezone: "UTC",
          preferredHour: new Date().getUTCHours(),
          preferredDayOfWeek: 1,
          quietHours: { start: 22, end: 7 },
          includedAlertTypes: [],
          includedSeverities: ["high", "critical"],
          includeTrends: true,
          includeUnresolved: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.spyOn(service, "listActiveSubscriptions").mockResolvedValueOnce(mockSubscriptions);
      vi.spyOn(service as any, "shouldSendDigest").mockReturnValueOnce(true);
      vi.spyOn(service as any, "isInQuietHours").mockReturnValueOnce(false);
      vi.spyOn(service as any, "createDigestDelivery").mockResolvedValueOnce({});

      const count = await service.generateDigests("daily");

      expect(count).toBe(1);
    });

    it("skips subscriptions in quiet hours", async () => {
      const mockSubscriptions: DigestSubscription[] = [
        {
          id: "sub-1",
          userAddress: "USER1",
          email: "user1@example.com",
          dailyEnabled: true,
          weeklyEnabled: true,
          timezone: "UTC",
          preferredHour: 9,
          preferredDayOfWeek: 1,
          quietHours: { start: 22, end: 7 },
          includedAlertTypes: [],
          includedSeverities: ["high"],
          includeTrends: true,
          includeUnresolved: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.spyOn(service, "listActiveSubscriptions").mockResolvedValueOnce(mockSubscriptions);
      vi.spyOn(service as any, "shouldSendDigest").mockReturnValueOnce(true);
      vi.spyOn(service as any, "isInQuietHours").mockReturnValueOnce(true);

      const count = await service.generateDigests("daily");

      expect(count).toBe(0);
    });

    it("handles errors gracefully during generation", async () => {
      const mockSubscriptions: DigestSubscription[] = [
        {
          id: "sub-1",
          userAddress: "USER1",
          email: "user1@example.com",
          dailyEnabled: true,
          weeklyEnabled: true,
          timezone: "UTC",
          preferredHour: 9,
          preferredDayOfWeek: 1,
          quietHours: { start: 22, end: 7 },
          includedAlertTypes: [],
          includedSeverities: [],
          includeTrends: true,
          includeUnresolved: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.spyOn(service, "listActiveSubscriptions").mockResolvedValueOnce(mockSubscriptions);
      vi.spyOn(service as any, "shouldSendDigest").mockReturnValueOnce(true);
      vi.spyOn(service as any, "isInQuietHours").mockReturnValueOnce(false);
      vi.spyOn(service as any, "createDigestDelivery").mockRejectedValueOnce(
        new Error("Database error")
      );

      const count = await service.generateDigests("daily");

      expect(count).toBe(0);
    });
  });

  describe("processPendingDeliveries", () => {
    it("processes pending deliveries", async () => {
      const mockDeliveries = [
        {
          id: "delivery-1",
          subscription_id: "sub-1",
          digest_type: "daily",
          user_address: "USER1",
          email: "user1@example.com",
          period_start: new Date(),
          period_end: new Date(),
          status: "pending",
          alert_count: 5,
          unresolved_count: 2,
          summary_data: JSON.stringify({}),
          attempts: 0,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      db("digest_deliveries").limit.mockResolvedValueOnce(mockDeliveries);
      db("digest_items").orderBy.mockResolvedValueOnce([
        {
          title: "Test alert",
          summary: "Test summary",
          occurred_at: new Date(),
        },
      ]);

      vi.spyOn(service as any, "sendDigest").mockResolvedValueOnce(undefined);

      const count = await service.processPendingDeliveries();

      expect(count).toBe(1);
    });

    it("handles failed deliveries", async () => {
      const mockDeliveries = [
        {
          id: "delivery-1",
          status: "pending",
          attempts: 0,
        },
      ];

      db("digest_deliveries").limit.mockResolvedValueOnce(mockDeliveries);
      vi.spyOn(service as any, "sendDigest").mockRejectedValueOnce(new Error("Send failed"));

      const count = await service.processPendingDeliveries();

      expect(count).toBe(0);
    });
  });

  describe("quiet hours logic", () => {
    it("detects quiet hours correctly", () => {
      const subscription: DigestSubscription = {
        id: "sub-1",
        userAddress: "USER1",
        email: "user@example.com",
        dailyEnabled: true,
        weeklyEnabled: true,
        timezone: "UTC",
        preferredHour: 9,
        preferredDayOfWeek: 1,
        quietHours: { start: 22, end: 7 },
        includedAlertTypes: [],
        includedSeverities: [],
        includeTrends: true,
        includeUnresolved: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(service as any, "getUserHour").mockReturnValueOnce(23);

      const isQuiet = service["isInQuietHours"](subscription);

      expect(isQuiet).toBe(true);
    });

    it("handles quiet hours spanning midnight", () => {
      const subscription: DigestSubscription = {
        id: "sub-1",
        userAddress: "USER1",
        email: "user@example.com",
        dailyEnabled: true,
        weeklyEnabled: true,
        timezone: "UTC",
        preferredHour: 9,
        preferredDayOfWeek: 1,
        quietHours: { start: 22, end: 7 },
        includedAlertTypes: [],
        includedSeverities: [],
        includeTrends: true,
        includeUnresolved: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(service as any, "getUserHour").mockReturnValueOnce(2);

      const isQuiet = service["isInQuietHours"](subscription);

      expect(isQuiet).toBe(true);
    });

    it("returns false outside quiet hours", () => {
      const subscription: DigestSubscription = {
        id: "sub-1",
        userAddress: "USER1",
        email: "user@example.com",
        dailyEnabled: true,
        weeklyEnabled: true,
        timezone: "UTC",
        preferredHour: 9,
        preferredDayOfWeek: 1,
        quietHours: { start: 22, end: 7 },
        includedAlertTypes: [],
        includedSeverities: [],
        includeTrends: true,
        includeUnresolved: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(service as any, "getUserHour").mockReturnValueOnce(10);

      const isQuiet = service["isInQuietHours"](subscription);

      expect(isQuiet).toBe(false);
    });
  });

  describe("timing and scheduling", () => {
    it("determines daily digest timing correctly", () => {
      const subscription: DigestSubscription = {
        id: "sub-1",
        userAddress: "USER1",
        email: "user@example.com",
        dailyEnabled: true,
        weeklyEnabled: true,
        timezone: "UTC",
        preferredHour: 9,
        preferredDayOfWeek: 1,
        quietHours: { start: 22, end: 7 },
        includedAlertTypes: [],
        includedSeverities: [],
        includeTrends: true,
        includeUnresolved: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(service as any, "getUserHour").mockReturnValueOnce(9);

      const shouldSend = service["shouldSendDigest"](subscription, "daily");

      expect(shouldSend).toBe(true);
    });

    it("determines weekly digest timing correctly", () => {
      const subscription: DigestSubscription = {
        id: "sub-1",
        userAddress: "USER1",
        email: "user@example.com",
        dailyEnabled: true,
        weeklyEnabled: true,
        timezone: "UTC",
        preferredHour: 9,
        preferredDayOfWeek: 1,
        quietHours: { start: 22, end: 7 },
        includedAlertTypes: [],
        includedSeverities: [],
        includeTrends: true,
        includeUnresolved: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(service as any, "getUserHour").mockReturnValueOnce(9);
      vi.spyOn(service as any, "getUserDayOfWeek").mockReturnValueOnce(1);

      const shouldSend = service["shouldSendDigest"](subscription, "weekly");

      expect(shouldSend).toBe(true);
    });

    it("does not send when daily is disabled", () => {
      const subscription: DigestSubscription = {
        id: "sub-1",
        userAddress: "USER1",
        email: "user@example.com",
        dailyEnabled: false,
        weeklyEnabled: true,
        timezone: "UTC",
        preferredHour: 9,
        preferredDayOfWeek: 1,
        quietHours: { start: 22, end: 7 },
        includedAlertTypes: [],
        includedSeverities: [],
        includeTrends: true,
        includeUnresolved: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const shouldSend = service["shouldSendDigest"](subscription, "daily");

      expect(shouldSend).toBe(false);
    });
  });

  describe("getDeliveryHistory", () => {
    it("retrieves delivery history for a user", async () => {
      const mockDeliveries = [
        {
          id: "delivery-1",
          user_address: "USER1",
          digest_type: "daily",
          status: "sent",
          summary_data: JSON.stringify({}),
        },
        {
          id: "delivery-2",
          user_address: "USER1",
          digest_type: "weekly",
          status: "sent",
          summary_data: JSON.stringify({}),
        },
      ];

      db("digest_deliveries").limit.mockResolvedValueOnce(mockDeliveries);

      const history = await service.getDeliveryHistory("USER1");

      expect(history).toHaveLength(2);
      expect(db("digest_deliveries").where).toHaveBeenCalledWith({ user_address: "USER1" });
    });

    it("respects limit parameter", async () => {
      db("digest_deliveries").limit.mockResolvedValueOnce([]);

      await service.getDeliveryHistory("USER1", 10);

      expect(db("digest_deliveries").limit).toHaveBeenCalledWith(10);
    });
  });

  describe("getUnreadCount", () => {
    it("returns count of unread digests", async () => {
      db("digest_deliveries").first.mockResolvedValueOnce({ count: 5 });

      const count = await service.getUnreadCount("USER1");

      expect(count).toBe(5);
    });

    it("returns 0 when no unread digests", async () => {
      db("digest_deliveries").first.mockResolvedValueOnce({ count: 0 });

      const count = await service.getUnreadCount("USER1");

      expect(count).toBe(0);
    });

    it("handles null result", async () => {
      db("digest_deliveries").first.mockResolvedValueOnce(null);

      const count = await service.getUnreadCount("USER1");

      expect(count).toBe(0);
    });
  });
});
