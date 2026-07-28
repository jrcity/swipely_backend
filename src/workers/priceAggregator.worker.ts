import { Worker, Queue } from "bullmq";
import { config } from "../config/index.js";
import { PriceService, type AggregatedPrice } from "../services/price.service.js";
import { logger } from "../utils/logger.js";
import { alertRoutingService, type RouteableAlert } from "../services/alertRouting.service.js";
import { duplicateAlertCheckService } from "../services/duplicateAlertCheck.service.js";
import type { AlertEventInput } from "../services/alert.service.js";
import { PriceModel } from "../database/models/price.model.js";

const QUEUE_NAME = "price-aggregator";

const priceModel = new PriceModel();

const connection = {
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD || undefined,
};

export const priceAggregatorQueue = new Queue(QUEUE_NAME, { connection });

function buildDeviationAlert(symbol: string, deviation: { deviated: boolean; percentage: number }): RouteableAlert {
  return {
    eventTime: new Date(),
    alertRuleId: `price-aggregator-${symbol}`,
    ownerAddress: "system",
    ruleName: "Price Deviation",
    assetCode: symbol,
    sourceType: "price_deviation",
    severity: deviation.percentage > config.PRICE_DEVIATION_THRESHOLD * 2 ? "critical" : "high",
    triggeredValue: deviation.percentage,
    threshold: config.PRICE_DEVIATION_THRESHOLD,
    metric: "price_deviation_pct",
  };
}

async function routeDeviationAlert(symbol: string, deviation: { deviated: boolean; percentage: number }): Promise<void> {
  const dedupEvent: AlertEventInput = {
    ruleId: `price-aggregator-${symbol}`,
    assetCode: symbol,
    alertType: "price_deviation",
    priority: deviation.percentage > config.PRICE_DEVIATION_THRESHOLD * 2 ? "critical" : "high",
    triggeredValue: deviation.percentage,
    threshold: config.PRICE_DEVIATION_THRESHOLD,
    metric: "price_deviation_pct",
    webhookDelivered: false,
    onChainEventId: null,
  };

  const dedupResult = duplicateAlertCheckService.check(dedupEvent);

  if (!dedupResult.isDuplicate || dedupResult.action !== "block") {
    const alert = buildDeviationAlert(symbol, deviation);
    await alertRoutingService.routeAlert(alert);
    logger.info({ symbol, percentage: deviation.percentage }, "Price deviation alert routed");
  } else {
    logger.debug({ symbol, reason: dedupResult.reason }, "Price deviation alert suppressed by deduplication");
  }
}

/**
 * Batch-inserts one row per price source into the prices TimescaleDB hypertable.
 * Columns: time (now), symbol, source, price, volume_24h (null — not returned by aggregation).
 * Errors are swallowed so a DB outage never prevents the alert routing path from running.
 */
async function persistAggregatedPrice(aggregated: AggregatedPrice): Promise<void> {
  try {
    const now = new Date();
    const records = aggregated.sources.map((src) => ({
      time: now,
      symbol: aggregated.symbol,
      source: src.source,
      price: src.price,
      volume_24h: null as number | null,
    }));
    await priceModel.insertBatch(records);
  } catch (err) {
    logger.error({ err, symbol: aggregated.symbol }, "Failed to persist aggregated price");
  }
}

export async function processPriceAggregatorJob(job: { id?: string; data: { symbol: string } }) {
  const priceService = new PriceService();
  logger.info({ jobId: job.id, data: job.data }, "Processing price aggregation job");

  const { symbol } = job.data;

  const aggregatedPrice = await priceService.getAggregatedPrice(symbol);
  const deviation = await priceService.checkDeviation(symbol);

  if (deviation.deviated) {
    logger.warn({ symbol, deviation: deviation.percentage }, "Price deviation detected");
    await routeDeviationAlert(symbol, deviation);
  }

  if (aggregatedPrice) {
    await persistAggregatedPrice(aggregatedPrice);
  }

  return { success: true, symbol, price: aggregatedPrice };
}

/**
 * Worker that periodically aggregates prices from multiple sources:
 * - Stellar DEX (SDEX + AMM pools)
 * - Circle API
 * - Coinbase API
 *
 * Computes VWAP, persists source prices to TimescaleDB, and triggers alerts
 * when cross-source deviation exceeds the configured threshold.
 */
export const priceAggregatorWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    try {
      return await processPriceAggregatorJob(job);
    } catch (error) {
      logger.error({ error, symbol: job.data?.symbol }, "Price aggregation job failed");
      throw error;
    }
  },
  { connection, concurrency: 5 }
);

priceAggregatorWorker.on("completed", (job) => {
  logger.debug({ jobId: job?.id }, "Price aggregation job completed");
});

priceAggregatorWorker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, error: error.message }, "Price aggregation job failed");
});
