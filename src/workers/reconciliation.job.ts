import type { Job } from "bullmq";
import crypto from "crypto";
import { BridgeService } from "../services/bridge.service.js";
import { ReconciliationService } from "../services/reconciliation.service.js";
import { logger } from "../utils/logger.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { alertOnReconciliationMismatch } from "../services/reconciliationAlerting.service.js";

export interface ReconciliationJobData {
  assetCode: string;
}

function lockKey(assetCode: string) {
  return `lock:reconciliation:${assetCode}`;
}

export function createReconciliationProcessor(deps?: {
  bridgeService?: BridgeService;
  reconciliationService?: ReconciliationService;
  acquireLock?: typeof acquireLock;
  releaseLock?: typeof releaseLock;
  lockTtlMs?: number;
  alertOnMismatch?: typeof alertOnReconciliationMismatch;
}) {
  const bridgeService = deps?.bridgeService ?? new BridgeService();
  const reconciliationService = deps?.reconciliationService ?? new ReconciliationService();
  const acquire = deps?.acquireLock ?? acquireLock;
  const release = deps?.releaseLock ?? releaseLock;
  const lockTtlMs = deps?.lockTtlMs ?? 10 * 60 * 1000;
  const alertOnMismatch = deps?.alertOnMismatch ?? alertOnReconciliationMismatch;

  return async function processReconciliation(job: Job<ReconciliationJobData>) {
    const { assetCode } = job.data;
    const lockValue = crypto.randomUUID();

    const locked = await acquire({
      key: lockKey(assetCode),
      value: lockValue,
      ttlMs: lockTtlMs,
    });

    if (!locked) {
      logger.warn({ assetCode, jobId: job.id }, "Reconciliation skipped (lock held)");
      return;
    }

    const attempt = (job.attemptsMade ?? 0) + 1;
    const started = Date.now();
    const run = await reconciliationService.startRun({
      assetCode,
      jobId: job.id ?? null,
      attempt,
    });

    try {
      const result = await bridgeService.verifySupply(assetCode);

      const status = result.errorStatus
        ? "failed"
        : result.isFlagged
          ? "mismatch"
          : "success";

      await reconciliationService.finishRun({
        id: run.id,
        status,
        stellarSupply: result.stellarSupply,
        reportedSupply: result.ethereumReserves,
        mismatchPercentage: result.mismatchPercentage,
        error: result.errorStatus ?? null,
      });

      logger.info(
        {
          assetCode,
          status,
          mismatchPercentage: result.mismatchPercentage,
          durationMs: Date.now() - started,
        },
        "Reconciliation complete"
      );

      // Raise a structured, severity-routed, deduplicated alert when the
      // discrepancy exceeds the configured per-asset threshold. This never
      // throws — a failure to alert must not fail the reconciliation run
      // itself, so any errors are caught and logged inside the helper.
      if (status !== "failed") {
        await alertOnMismatch({
          assetCode,
          runId: run.id,
          stellarSupply: result.stellarSupply,
          reportedSupply: result.ethereumReserves,
          mismatchPercentage: result.mismatchPercentage,
        });
      }
    } catch (error: any) {
      const message = error?.message || String(error);

      await reconciliationService.finishRun({
        id: run.id,
        status: "failed",
        error: message,
      });

      logger.error({ assetCode, error: message, jobId: job.id }, "Reconciliation failed");
      throw error;
    } finally {
      await release({ key: lockKey(assetCode), value: lockValue }).catch(() => {});
    }
  };
}

export async function processReconciliation(job: Job<ReconciliationJobData>) {
  return createReconciliationProcessor()(job);
}