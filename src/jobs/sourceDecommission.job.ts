import { sourceDecommissionService } from "../services/sourceDecommission.service.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

const CHECK_INTERVAL_MS = config.SOURCE_DECOMMISSION_CHECK_INTERVAL_MS;

let decommissionCheckInterval: NodeJS.Timeout | null = null;

export async function runSourceDecommissionCheck(): Promise<number> {
  try {
    const updated = await sourceDecommissionService.refreshCompletionReadiness();
    if (updated > 0) {
      logger.info({ updated }, "Source decommission readiness check flagged sources ready to complete");
    }
    return updated;
  } catch (err) {
    logger.error({ error: err }, "Source decommission readiness check failed");
    return 0;
  }
}

export function startSourceDecommissionJob(): void {
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, "Starting source decommission readiness job scheduler");

  runSourceDecommissionCheck().catch((err) => {
    logger.error({ error: err }, "Initial source decommission readiness check failed");
  });

  decommissionCheckInterval = setInterval(() => {
    runSourceDecommissionCheck().catch((err) => {
      logger.error({ error: err }, "Scheduled source decommission readiness check failed");
    });
  }, CHECK_INTERVAL_MS);
}

export function stopSourceDecommissionJob(): void {
  if (decommissionCheckInterval) {
    clearInterval(decommissionCheckInterval);
    decommissionCheckInterval = null;
    logger.info("Stopped source decommission readiness job scheduler");
  }
}
