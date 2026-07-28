import { getDatabase } from "../database/connection.js";
import { logger } from "../utils/logger.js";

export interface UsageMetricRow {
  endpoint: string;
  method: string;
  status_code: number;
  duration_ms: number;
  user_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export class UsageMetricsService {
  private db = getDatabase();

  async record(metric: UsageMetricRow) {
    // fire-and-forget: run async but catch errors so they don't go unhandled
    this.db("usage_metrics")
      .insert({
        endpoint: metric.endpoint,
        method: metric.method,
        status_code: metric.status_code,
        duration_ms: metric.duration_ms,
        user_id: metric.user_id ?? null,
        metadata: JSON.stringify(metric.metadata ?? {}),
      })
      .catch((e: unknown) => {
        logger.warn({ err: e }, "Failed to record usage metric");
      });
  }

  async queryAggregates({ start, end, groupBy = "endpoint", rollup = "hour" }: { start?: string; end?: string; groupBy?: string; rollup?: string }) {
    const s = start ? new Date(start) : new Date(Date.now() - 1000 * 60 * 60 * 24);
    const e = end ? new Date(end) : new Date();

    const timeBucket = rollup === "hour" ? "1 hour" : rollup === "day" ? "1 day" : "1 hour";

    // use Postgres date_trunc
    const rows = await this.db.raw(
      `SELECT date_trunc('${rollup}', created_at) as period, ${groupBy} as key, count(*) as count, avg(duration_ms)::numeric as avg_ms, percentile_cont(0.95) within group (order by duration_ms) as p95_ms
       FROM usage_metrics
       WHERE created_at >= ? AND created_at <= ?
       GROUP BY period, key
       ORDER BY period desc
       LIMIT 1000`,
      [s.toISOString(), e.toISOString()]
    );

    return rows.rows || rows;
  }
}

let instance: UsageMetricsService | null = null;
export function getUsageMetricsService() {
  if (!instance) instance = new UsageMetricsService();
  return instance;
}
