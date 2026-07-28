import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────
const getProtocolStatsMock = vi.hoisted(() => vi.fn());
const getAssetRankingsMock = vi.hoisted(() => vi.fn());
const getRecentAlertsMock = vi.hoisted(() => vi.fn());
const getDriftSummariesMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/analytics.service.js", () => ({
  AnalyticsService: class {
    getProtocolStats = getProtocolStatsMock;
    getAssetRankings = getAssetRankingsMock;
  },
}));

vi.mock("../../src/services/alert.service.js", () => ({
  AlertService: class {
    getRecentAlerts = getRecentAlertsMock;
  },
}));

vi.mock("../../src/services/reconciliation.service.js", () => ({
  ReconciliationService: class {
    getDriftSummaries = getDriftSummariesMock;
  },
}));

vi.mock("../../src/services/email.service.js", () => ({
  EmailNotificationService: class {
    sendReportEmail = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../../src/database/connection.js", () => ({
  getDatabase: () => {
    const q: any = {};
    q.where = () => q;
    q.andWhere = () => q;
    q.limit = () => Promise.resolve([]);
    q.insert = () => [{ id: "mock-id" }];
    q.returning = () => [{ id: "mock-id" }];
    return (table: string) => q;
  },
}));

import { ReportSchedulingService } from "../../src/services/reportScheduling.service.js";

const makeDelivery = (overrides: any = {}) => ({
  id: "del-1",
  scheduleId: "sched-1",
  frequency: "daily" as const,
  userAddress: "0xabc",
  email: "user@example.com",
  periodStart: new Date("2026-06-01T00:00:00Z"),
  periodEnd: new Date("2026-06-02T00:00:00Z"),
  status: "pending" as const,
  attempts: 0,
  sentAt: null,
  nextRetryAt: null,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeStats = () => ({
  totalValueLocked: "$1.2B",
  totalVolume24h: "$50M",
  totalVolume7d: "$300M",
  totalVolume30d: "$1B",
  activeBridges: 5,
  activeAssets: 12,
  totalTransactions24h: 3200,
  averageHealthScore: 0.87,
  timestamp: new Date(),
});

const makeRankings = () => [
  { rank: 1, symbol: "USDC", tvl: "$800M", volume24h: "$30M", healthScore: 0.95, priceStability: 0.99, liquidityDepth: "$400M", bridgeCount: 3, trend: "up" as const, changePercent24h: 1.2 },
];

const makeAlerts = (time: Date) => [
  { eventId: "a1", ruleId: "r1", assetCode: "USDC", alertType: "supply_mismatch", priority: "high", triggeredValue: 0.05, threshold: 0.01, metric: "mismatch_pct", webhookDelivered: false, onChainEventId: null, time },
];

const makeDrifts = () => [
  {
    id: "d1", assetCode: "USDC", bridgeName: "StellarBridge", sourceChain: "ethereum",
    severity: "low", trendDirection: "stable",
    latestRun: { id: "r1", assetCode: "USDC", bridgeName: "StellarBridge", sourceChain: "ethereum", status: "complete", triageStatus: "none", triageOwner: null, triageNote: null, triagedAt: null, stellarSupply: 1000000, reportedSupply: 1001000, mismatchPercentage: 0.001, discrepancy: 1000, discrepancyAbs: 1000, severity: "low", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), attempt: 1, jobId: null, error: null, sourceData: [] },
    previousRunId: null,
  },
];

describe("ReportSchedulingService.generateReportHtml", () => {
  let service: ReportSchedulingService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton
    (ReportSchedulingService as any).instance = undefined;
    service = ReportSchedulingService.getInstance();

    getProtocolStatsMock.mockResolvedValue(makeStats());
    getAssetRankingsMock.mockResolvedValue(makeRankings());
    getRecentAlertsMock.mockResolvedValue([]);
    getDriftSummariesMock.mockResolvedValue({ summaries: [] });
  });

  describe("HTML structure", () => {
    it("includes DOCTYPE and report title in generated HTML", async () => {
      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Bridge-Watch Report");
    });

    it("includes the period label in the output", async () => {
      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("2026-06-01");
      expect(html).toContain("2026-06-02");
    });

    it("includes all four report sections", async () => {
      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("Protocol Overview");
      expect(html).toContain("Top Assets");
      expect(html).toContain("Alert Summary");
      expect(html).toContain("Reconciliation");
    });
  });

  describe("protocol stats section", () => {
    it("renders TVL from analytics service", async () => {
      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("$1.2B");
    });

    it("renders active bridges count", async () => {
      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("5");
    });

    it("shows fallback when analytics service fails", async () => {
      getProtocolStatsMock.mockRejectedValueOnce(new Error("service unavailable"));

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("Protocol Overview");
      expect(html).toContain("Data unavailable");
    });
  });

  describe("alert summary section", () => {
    it("counts alerts within the report period", async () => {
      const inPeriod = new Date("2026-06-01T12:00:00Z");
      getRecentAlertsMock.mockResolvedValue(makeAlerts(inPeriod));

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("Total alerts in period: <strong>1</strong>");
    });

    it("excludes alerts outside the report period", async () => {
      const outsidePeriod = new Date("2026-06-05T12:00:00Z");
      getRecentAlertsMock.mockResolvedValue(makeAlerts(outsidePeriod));

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("Total alerts in period: <strong>0</strong>");
    });

    it("shows fallback when alert service fails", async () => {
      getRecentAlertsMock.mockRejectedValueOnce(new Error("DB error"));

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("Alert Summary");
      expect(html).toContain("Data unavailable");
    });
  });

  describe("asset rankings section", () => {
    it("renders top asset symbol in the rankings table", async () => {
      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("USDC");
    });

    it("shows fallback when asset rankings service fails", async () => {
      getAssetRankingsMock.mockRejectedValueOnce(new Error("rate limit"));

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("Top Assets");
      expect(html).toContain("Data unavailable");
    });
  });

  describe("all four services called", () => {
    it("calls all four data services when generating a report", async () => {
      await (service as any).generateReportHtml(makeDelivery());

      expect(getProtocolStatsMock).toHaveBeenCalledOnce();
      expect(getAssetRankingsMock).toHaveBeenCalledOnce();
      expect(getRecentAlertsMock).toHaveBeenCalledWith(50);
      expect(getDriftSummariesMock).toHaveBeenCalledWith();
    });
  });

  describe("reconciliation section", () => {
    it("renders drift data when available", async () => {
      getDriftSummariesMock.mockResolvedValue({ summaries: makeDrifts() });

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("StellarBridge");
      expect(html).toContain("USDC");
    });

    it("shows no-drift message when reconciliation returns empty", async () => {
      getDriftSummariesMock.mockResolvedValue({ summaries: [] });

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("No drift detected");
    });

    it("shows fallback when reconciliation service fails", async () => {
      getDriftSummariesMock.mockRejectedValueOnce(new Error("timeout"));

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("Reconciliation");
      expect(html).toContain("Data unavailable");
    });
  });

  describe("full degradation resilience", () => {
    it("returns a valid HTML document even when all four data services fail", async () => {
      getProtocolStatsMock.mockRejectedValueOnce(new Error("down"));
      getAssetRankingsMock.mockRejectedValueOnce(new Error("down"));
      getRecentAlertsMock.mockRejectedValueOnce(new Error("down"));
      getDriftSummariesMock.mockRejectedValueOnce(new Error("down"));

      const html = await (service as any).generateReportHtml(makeDelivery());

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Bridge-Watch Report");
      expect(html.match(/Data unavailable/g)?.length).toBe(4);
    });
  });
});
