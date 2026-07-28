import { describe, it, expect, vi, beforeEach } from "vitest";
import { PerformanceBaselineService, type PerformanceSample } from "../../src/services/performanceBaseline.service.js";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../../src/database/connection.js", () => ({
  getDatabase: vi.fn(() => ({ raw: mockQuery })),
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeService() {
  return new PerformanceBaselineService();
}

const SAMPLE_BASELINE = {
  id: "base-1",
  endpoint: "/api/v1/assets",
  method: "GET",
  p50Ms: 80,
  p95Ms: 150,
  p99Ms: 200,
  sampleCount: 100,
  thresholdMs: 225,
  measuredAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

describe("PerformanceBaselineService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("recordBaseline", () => {
    it("inserts one baseline row per unique endpoint+method pair", async () => {
      mockQuery.mockResolvedValue({ rows: [SAMPLE_BASELINE] });

      const samples: PerformanceSample[] = [
        { endpoint: "/api/v1/assets", method: "GET", durationMs: 100, statusCode: 200 },
        { endpoint: "/api/v1/assets", method: "GET", durationMs: 120, statusCode: 200 },
        { endpoint: "/api/v1/assets", method: "GET", durationMs: 80, statusCode: 200 },
      ];

      const service = makeService();
      const results = await service.recordBaseline(samples);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
    });

    it("inserts separate rows for different endpoint+method combinations", async () => {
      mockQuery.mockResolvedValue({ rows: [SAMPLE_BASELINE] });

      const samples: PerformanceSample[] = [
        { endpoint: "/api/v1/assets", method: "GET", durationMs: 100, statusCode: 200 },
        { endpoint: "/api/v1/bridges", method: "GET", durationMs: 200, statusCode: 200 },
      ];

      const service = makeService();
      await service.recordBaseline(samples);

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("returns empty array when no samples provided", async () => {
      const service = makeService();
      const results = await service.recordBaseline([]);
      expect(results).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("detectRegressions", () => {
    it("returns empty array when no baseline exists for the endpoint", async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const samples: PerformanceSample[] = [
        { endpoint: "/api/v1/unknown", method: "GET", durationMs: 5000, statusCode: 200 },
      ];

      const service = makeService();
      const alerts = await service.detectRegressions(samples);
      expect(alerts).toHaveLength(0);
    });

    it("returns warning alert when p95 degrades by more than 20%", async () => {
      mockQuery.mockResolvedValue({ rows: [SAMPLE_BASELINE] }); // p95 = 150ms

      // p95 of [200, 210, 190] = 210ms → +40% above 150ms baseline
      const samples: PerformanceSample[] = Array.from({ length: 10 }, (_, i) => ({
        endpoint: "/api/v1/assets",
        method: "GET",
        durationMs: 190 + i * 2,
        statusCode: 200,
      }));

      const service = makeService();
      const alerts = await service.detectRegressions(samples);

      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].severity).toBe("warning");
      expect(alerts[0].degradationPct).toBeGreaterThan(20);
    });

    it("returns critical alert when p95 degrades by more than 50%", async () => {
      mockQuery.mockResolvedValue({ rows: [SAMPLE_BASELINE] }); // p95 = 150ms

      // 150ms * 1.6 = 240ms+ → critical
      const samples: PerformanceSample[] = Array.from({ length: 10 }, () => ({
        endpoint: "/api/v1/assets",
        method: "GET",
        durationMs: 300,
        statusCode: 200,
      }));

      const service = makeService();
      const alerts = await service.detectRegressions(samples);

      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].severity).toBe("critical");
    });

    it("returns no alerts when performance is within threshold", async () => {
      mockQuery.mockResolvedValue({ rows: [SAMPLE_BASELINE] }); // p95 = 150ms

      const samples: PerformanceSample[] = Array.from({ length: 10 }, () => ({
        endpoint: "/api/v1/assets",
        method: "GET",
        durationMs: 155,
        statusCode: 200,
      }));

      const service = makeService();
      const alerts = await service.detectRegressions(samples);
      expect(alerts).toHaveLength(0);
    });
  });

  describe("getTrend", () => {
    it("queries historical baselines with correct params", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { p95Ms: 150, sampleCount: 100, measuredAt: "2025-01-01T00:00:00Z" },
          { p95Ms: 160, sampleCount: 80, measuredAt: "2025-01-02T00:00:00Z" },
        ],
      });

      const service = makeService();
      const trend = await service.getTrend("/api/v1/assets", "GET", 10);

      expect(trend.endpoint).toBe("/api/v1/assets");
      expect(trend.method).toBe("GET");
      expect(trend.history).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT"),
        ["/api/v1/assets", "GET", 10]
      );
    });
  });
});
