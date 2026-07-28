import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../../src/utils/logger.js";
import { ReconciliationService } from "../../src/services/reconciliation.service.js";
import {
  runBatchReconciliation,
  startBatchReconciliationJob,
  stopBatchReconciliationJob,
} from "../../src/jobs/batchReconciliation.job.js";

vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/config/index.js", () => ({
  config: {},
  SUPPORTED_ASSETS: [
    { code: "USDC" },
    { code: "EURC" },
  ],
}));

vi.mock("../../src/database/connection.js", () => ({
  getDatabase: vi.fn(),
}));

const { mockStartRun, mockFinishRun, mockGetLatestRun } = vi.hoisted(() => ({
  mockStartRun: vi.fn(),
  mockFinishRun: vi.fn(),
  mockGetLatestRun: vi.fn(),
}));

vi.mock("../../src/services/reconciliation.service.js", () => ({
  ReconciliationService: vi.fn(() => ({
    startRun: mockStartRun,
    finishRun: mockFinishRun,
    getLatestRun: mockGetLatestRun,
  })),
}));

describe("BatchReconciliation Job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartRun.mockResolvedValue({ id: "run-123" });
    mockFinishRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopBatchReconciliationJob();
  });

  it("processes all supported assets and returns a report", async () => {
    mockGetLatestRun.mockResolvedValue({
      status: "success",
      stellarSupply: 1000,
      reportedSupply: 1000,
      mismatchPercentage: 0,
    });

    const report = await runBatchReconciliation();

    expect(report.totalAssets).toBe(2);
    expect(report.successCount).toBe(2);
    expect(report.mismatchCount).toBe(0);
    expect(report.failureCount).toBe(0);
    expect(report.jobId).toMatch(/^batch-recon-/);
    expect(report.startedAt).toBeTruthy();
    expect(report.finishedAt).toBeTruthy();
  });

  it("records mismatches when latest run has mismatch status", async () => {
    mockGetLatestRun.mockResolvedValue({
      status: "mismatch",
      stellarSupply: 1000,
      reportedSupply: 950,
      mismatchPercentage: 5.26,
    });

    const report = await runBatchReconciliation();

    expect(report.mismatchCount).toBe(2);
    expect(report.successCount).toBe(0);
    expect(report.mismatches).toHaveLength(2);
    expect(report.mismatches[0].mismatchPercentage).toBe(5.26);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "Reconciliation mismatch detected"
    );
  });

  it("records errors when no baseline data found", async () => {
    mockGetLatestRun.mockResolvedValue(null);

    const report = await runBatchReconciliation();

    expect(report.failureCount).toBe(2);
    expect(report.errors).toHaveLength(2);
    expect(report.errors[0].error).toContain("No baseline data");
  });

  it("handles per-asset exceptions gracefully without stopping the batch", async () => {
    mockGetLatestRun
      .mockResolvedValueOnce({ status: "success", stellarSupply: 100, reportedSupply: 100, mismatchPercentage: 0 })
      .mockRejectedValueOnce(new Error("DB connection lost"));

    const report = await runBatchReconciliation();

    expect(report.successCount).toBe(1);
    expect(report.failureCount).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ assetCode: "EURC" }),
      "Reconciliation run failed for asset"
    );
  });

  it("starts and stops the job scheduler without throwing", () => {
    vi.useFakeTimers();
    expect(() => startBatchReconciliationJob()).not.toThrow();
    expect(() => stopBatchReconciliationJob()).not.toThrow();
    vi.useRealTimers();
  });
});
