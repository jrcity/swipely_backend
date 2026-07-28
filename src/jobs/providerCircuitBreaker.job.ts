import { providerCircuitBreakerService } from "../services/providerCircuitBreaker.service.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

const PROBE_SWEEP_INTERVAL_MS = config.PROVIDER_BREAKER_PROBE_INTERVAL_MS;

let probeSweepInterval: NodeJS.Timeout | null = null;

export async function runRecoveryProbeSweep(): Promise<number> {
  try {
    const probed = await providerCircuitBreakerService.runRecoveryProbeSweep();
    if (probed > 0) {
      logger.info({ probed }, "Provider circuit breaker recovery probe sweep transitioned breakers to half-open");
    }
    return probed;
  } catch (err) {
    logger.error({ error: err }, "Provider circuit breaker recovery probe sweep failed");
    return 0;
  }
}

export function startProviderCircuitBreakerJob(): void {
  logger.info({ intervalMs: PROBE_SWEEP_INTERVAL_MS }, "Starting provider circuit breaker recovery probe job");

  probeSweepInterval = setInterval(() => {
    runRecoveryProbeSweep().catch((err) => {
      logger.error({ error: err }, "Scheduled provider circuit breaker probe sweep failed");
    });
  }, PROBE_SWEEP_INTERVAL_MS);
}

export function stopProviderCircuitBreakerJob(): void {
  if (probeSweepInterval) {
    clearInterval(probeSweepInterval);
    probeSweepInterval = null;
    logger.info("Stopped provider circuit breaker recovery probe job");
  }
}
