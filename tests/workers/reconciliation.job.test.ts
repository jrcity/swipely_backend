import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReconciliationProcessor } from "../../src/workers/reconciliation.job.js";

const verifySupplyMock = vi.hoisted(() => vi.fn());
const startRunMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "run-1" }));
const finishRunMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const acquireLockMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const releaseLockMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const alertOnMismatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ alerted: false }));

describe("reconciliation job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists success run when supplies match", async () => {
    verifySupplyMock.mockResolvedValueOnce({
      assetCode: "USDC",
      stellarSupply: 100,
      ethereumReserves: 100,
      mismatchPercentage: 0,
      isFlagged: false,
      match: true,
      errorStatus: null,
    });

    const processReconciliation = createReconciliationProcessor({
      bridgeService: { verifySupply: verifySupplyMock } as any,
      reconciliationService: { startRun: startRunMock, finishRun: finishRunMock } as any,
      acquireLock: acquireLockMock as any,
      releaseLock: releaseLockMock as any,
      lockTtlMs: 50,
      alertOnMismatch: alertOnMismatchMock as any,
    });

    await processReconciliation({
      id: "job-1",
      data: { assetCode: "USDC" },
      attemptsMade: 0,
    } as any);

    expect(startRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ assetCode: "USDC", jobId: "job-1", attempt: 1 })
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        status: "success",
        stellarSupply: 100,
        reportedSupply: 100,
        mismatchPercentage: 0,
      })
    );
  });

  it("persists mismatch run when flagged", async () => {
    verifySupplyMock.mockResolvedValueOnce({
      assetCode: "EURC",
      stellarSupply: 110,
      ethereumReserves: 100,
      mismatchPercentage: 10,
      isFlagged: true,
      match: false,
      errorStatus: null,
    });

    const processReconciliation = createReconciliationProcessor({
      bridgeService: { verifySupply: verifySupplyMock } as any,
      reconciliationService: { startRun: startRunMock, finishRun: finishRunMock } as any,
      acquireLock: acquireLockMock as any,
      releaseLock: releaseLockMock as any,
      lockTtlMs: 50,
      alertOnMismatch: alertOnMismatchMock as any,
    });

    await processReconciliation({
      id: "job-2",
      data: { assetCode: "EURC" },
      attemptsMade: 1,
    } as any);

    expect(finishRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", status: "mismatch" })
    );
  });

  describe("reconciliation alerting wiring (issue #8)", () => {
    it("invokes the alerting helper with the real compared values on a mismatch", async () => {
      verifySupplyMock.mockResolvedValueOnce({
        assetCode: "EURC",
        stellarSupply: 110,
        ethereumReserves: 100,
        mismatchPercentage: 10,
        isFlagged: true,
        match: false,
        errorStatus: null,
      });

      const processReconciliation = createReconciliationProcessor({
        bridgeService: { verifySupply: verifySupplyMock } as any,
        reconciliationService: { startRun: startRunMock, finishRun: finishRunMock } as any,
        acquireLock: acquireLockMock as any,
        releaseLock: releaseLockMock as any,
        lockTtlMs: 50,
        alertOnMismatch: alertOnMismatchMock as any,
      });

      await processReconciliation({
        id: "job-3",
        data: { assetCode: "EURC" },
        attemptsMade: 0,
      } as any);

      expect(alertOnMismatchMock).toHaveBeenCalledTimes(1);
      expect(alertOnMismatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          assetCode: "EURC",
          runId: "run-1",
          stellarSupply: 110,
          reportedSupply: 100,
          mismatchPercentage: 10,
        })
      );
    });

    it("still invokes the alerting helper on success (threshold check happens inside the helper)", async () => {
      verifySupplyMock.mockResolvedValueOnce({
        assetCode: "USDC",
        stellarSupply: 100,
        ethereumReserves: 100,
        mismatchPercentage: 0,
        isFlagged: false,
        match: true,
        errorStatus: null,
      });

      const processReconciliation = createReconciliationProcessor({
        bridgeService: { verifySupply: verifySupplyMock } as any,
        reconciliationService: { startRun: startRunMock, finishRun: finishRunMock } as any,
        acquireLock: acquireLockMock as any,
        releaseLock: releaseLockMock as any,
        lockTtlMs: 50,
        alertOnMismatch: alertOnMismatchMock as any,
      });

      await processReconciliation({
        id: "job-4",
        data: { assetCode: "USDC" },
        attemptsMade: 0,
      } as any);

      expect(alertOnMismatchMock).toHaveBeenCalledTimes(1);
    });

    it("does not invoke the alerting helper when the run failed (no real values to compare)", async () => {
      verifySupplyMock.mockResolvedValueOnce({
        assetCode: "USDC",
        stellarSupply: 0,
        ethereumReserves: 0,
        mismatchPercentage: 0,
        isFlagged: false,
        match: false,
        errorStatus: "RPC timeout",
      });

      const processReconciliation = createReconciliationProcessor({
        bridgeService: { verifySupply: verifySupplyMock } as any,
        reconciliationService: { startRun: startRunMock, finishRun: finishRunMock } as any,
        acquireLock: acquireLockMock as any,
        releaseLock: releaseLockMock as any,
        lockTtlMs: 50,
        alertOnMismatch: alertOnMismatchMock as any,
      });

      await processReconciliation({
        id: "job-5",
        data: { assetCode: "USDC" },
        attemptsMade: 0,
      } as any);

      expect(alertOnMismatchMock).not.toHaveBeenCalled();
    });

    it("skips entirely (including alerting) when the per-asset lock is held", async () => {
      const processReconciliation = createReconciliationProcessor({
        bridgeService: { verifySupply: verifySupplyMock } as any,
        reconciliationService: { startRun: startRunMock, finishRun: finishRunMock } as any,
        acquireLock: vi.fn().mockResolvedValue(false) as any,
        releaseLock: releaseLockMock as any,
        lockTtlMs: 50,
        alertOnMismatch: alertOnMismatchMock as any,
      });

      await processReconciliation({
        id: "job-6",
        data: { assetCode: "USDC" },
        attemptsMade: 0,
      } as any);

      expect(verifySupplyMock).not.toHaveBeenCalled();
      expect(alertOnMismatchMock).not.toHaveBeenCalled();
    });
  });
});