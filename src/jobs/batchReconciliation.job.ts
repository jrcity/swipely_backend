import { SUPPORTED_ASSETS, config } from "../config/index.js";
import { ReconciliationService } from "../services/reconciliation.service.js";
import { logger } from "../utils/logger.js";

const RECONCILIATION_INTERVAL_MS = config.RECONCILIATION_INTERVAL_MS;

export interface BatchReconciliationReport {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  totalAssets: number;
  successCount: number;
  mismatchCount: number;
  failureCount: number;
  mismatches: Array<{ assetCode: string; mismatchPercentage: number | null; runId: string }>;
  errors: Array<{ assetCode: string; error: string }>;
}

let reconciliationInterval: NodeJS.Timeout | null = null;
const reconciliationService = new ReconciliationService();

export async function runBatchReconciliation(): Promise<BatchReconciliationReport> {
  const jobId = `batch-recon-${Date.now()}`;
  const startedAt = new Date().toISOString();

  logger.info({ jobId, assetCount: SUPPORTED_ASSETS.length }, "Starting batch reconciliation run");

  const mismatches: BatchReconciliationReport["mismatches"] = [];
  const errors: BatchReconciliationReport["errors"] = [];
  let successCount = 0;

  for (const asset of SUPPORTED_ASSETS) {
    const assetCode = asset.code;
    let runId: string | null = null;

    try {
      // NOTE: startRun() inserts a fresh "running" row (all comparison
      // fields null) and getLatestRun() below then fetches the most
      // recently started row ordered by started_at desc — which is the row
      // we just inserted, not a previously completed run. As written, this
      // means `latest` here is (almost) always the run we just created, so
      // `latest.status`/`latest.mismatchPercentage` don't reflect a real
      // comparison. This predates the reconciliation-alerting work (issue
      // #8) and isn't something we're fixing here — flagging it because it
      // also means this batch job path currently has no real mismatch data
      // to alert on. Reconciliation alerting (see reconciliationAlerting.
      // service.ts) is wired into src/workers/reconciliation.job.ts instead,
      // where bridgeService.verifySupply() produces real compared values.
      // Consider filing a follow-up to fetch the latest *completed* run
      // before calling startRun(), or to compute values here directly.
      const run = await reconciliationService.startRun({ assetCode, jobId });
      runId = run.id;

      const latest = await reconciliationService.getLatestRun(assetCode);

      if (!latest) {
        await reconciliationService.finishRun({
          id: runId,
          status: "failed",
          error: "No baseline data found",
        });
        errors.push({ assetCode, error: "No baseline data found" });
        continue;
      }

      const isMismatch = latest.status === "mismatch";
      const status = isMismatch ? "mismatch" : "success";

      await reconciliationService.finishRun({
        id: runId,
        status,
        stellarSupply: latest.stellarSupply,
        reportedSupply: latest.reportedSupply,
        mismatchPercentage: latest.mismatchPercentage,
      });

      if (isMismatch) {
        mismatches.push({
          assetCode,
          mismatchPercentage: latest.mismatchPercentage,
          runId,
        });
        logger.warn({ assetCode, mismatchPercentage: latest.mismatchPercentage, runId }, "Reconciliation mismatch detected");
      } else {
        successCount++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ assetCode, jobId, error: message }, "Reconciliation run failed for asset");
      errors.push({ assetCode, error: message });

      if (runId) {
        try {
          await reconciliationService.finishRun({ id: runId, status: "failed", error: message });
        } catch (finishErr) {
          logger.error({ assetCode, finishErr }, "Failed to mark reconciliation run as failed");
        }
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const report: BatchReconciliationReport = {
    jobId,
    startedAt,
    finishedAt,
    totalAssets: SUPPORTED_ASSETS.length,
    successCount,
    mismatchCount: mismatches.length,
    failureCount: errors.length,
    mismatches,
    errors,
  };

  logger.info(
    { jobId, successCount, mismatchCount: mismatches.length, failureCount: errors.length },
    "Batch reconciliation run complete"
  );

  return report;
}

export function startBatchReconciliationJob(): void {
  logger.info({ intervalMs: RECONCILIATION_INTERVAL_MS }, "Starting batch reconciliation job scheduler");

  runBatchReconciliation().catch((err) => {
    logger.error({ error: err }, "Initial batch reconciliation run failed");
  });

  reconciliationInterval = setInterval(() => {
    runBatchReconciliation().catch((err) => {
      logger.error({ error: err }, "Scheduled batch reconciliation run failed");
    });
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopBatchReconciliationJob(): void {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
    logger.info("Stopped batch reconciliation job scheduler");
  }
}