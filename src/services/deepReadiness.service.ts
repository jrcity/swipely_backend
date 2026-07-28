/**
 * DeepReadinessService
 *
 * Aggregates readiness signals from every critical dependency:
 *   - database connectivity
 *   - cache (Redis) connectivity
 *   - outbox lag (pending / failed events)
 *   - per-worker heartbeat freshness (BullMQ queue health)
 *   - external provider reachability (last-known status from external_dependencies table)
 *
 * Returns a structured, machine-readable JSON payload.
 * HTTP 200 when all critical checks pass; 503 when any critical check fails.
 */

import { logger } from "../utils/logger.js";
import { getDatabase } from "../database/connection.js";
import Redis from "ioredis";
import { config } from "../config/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DependencyStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface DependencyResult {
  status: DependencyStatus;
  /** ISO-8601 timestamp of when this check was performed */
  checkedAt: string;
  /** Round-trip time in milliseconds (where applicable) */
  latencyMs?: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface WorkerHeartbeatResult extends DependencyResult {
  workerName: string;
  /** True when the queue was reachable and job counts were retrieved */
  reachable: boolean;
  jobCounts?: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
}

export interface ExternalProviderResult extends DependencyResult {
  providerKey: string;
  displayName: string;
  /** ISO-8601 timestamp from the last periodic check stored in the DB */
  lastCheckedAt: string | null;
}

export interface OutboxLagResult extends DependencyResult {
  pendingEvents: number;
  failedEvents: number;
  deadLetterEvents: number;
}

export interface DeepReadinessResponse {
  /** Overall verdict: "ready" when all critical checks pass, "not_ready" otherwise */
  status: "ready" | "not_ready";
  checkedAt: string;
  /** Per-dependency breakdown */
  checks: {
    database: DependencyResult;
    cache: DependencyResult;
    outbox: OutboxLagResult;
    workers: WorkerHeartbeatResult[];
    externalProviders: ExternalProviderResult[];
  };
  /** Summary counters */
  summary: {
    total: number;
    healthy: number;
    unhealthy: number;
    degraded: number;
    unknown: number;
  };
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const OUTBOX_PENDING_WARN_THRESHOLD = 500;
const OUTBOX_PENDING_CRITICAL_THRESHOLD = 2_000;
const OUTBOX_FAILED_WARN_THRESHOLD = 50;
const OUTBOX_FAILED_CRITICAL_THRESHOLD = 200;
const OUTBOX_DEAD_LETTER_CRITICAL_THRESHOLD = 100;

/** A worker is considered stale if its BullMQ queue has more failed jobs than this */
const WORKER_FAILED_CRITICAL_THRESHOLD = 50;

// ─── Service ─────────────────────────────────────────────────────────────────

export class DeepReadinessService {
  private readonly redisClient: Redis;

  constructor() {
    this.redisClient = new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null, // do not retry during a health check
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async getDeepReadiness(): Promise<DeepReadinessResponse> {
    const checkedAt = new Date().toISOString();

    const [database, cache, outbox, workers, externalProviders] =
      await Promise.allSettled([
        this.checkDatabase(),
        this.checkCache(),
        this.checkOutboxLag(),
        this.checkWorkerHeartbeats(),
        this.checkExternalProviders(),
      ]);

    const checks: DeepReadinessResponse["checks"] = {
      database: this.settle(database, "database"),
      cache: this.settle(cache, "cache"),
      outbox: this.settleOutbox(outbox),
      workers: this.settleWorkers(workers),
      externalProviders: this.settleExternalProviders(externalProviders),
    };

    const allStatuses = this.collectStatuses(checks);
    const summary = this.buildSummary(allStatuses);

    // Critical check: any unhealthy dependency makes the service not ready
    const ready = !allStatuses.includes("unhealthy");

    logger.info(
      { ready, summary, checkedAt },
      "Deep readiness check completed"
    );

    return {
      status: ready ? "ready" : "not_ready",
      checkedAt,
      checks,
      summary,
    };
  }

  async disconnect(): Promise<void> {
    await this.redisClient.quit();
  }

  // ── Individual checks ──────────────────────────────────────────────────────

  async checkDatabase(): Promise<DependencyResult> {
    const start = Date.now();
    try {
      const db = getDatabase();
      await db.raw("SELECT 1");
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        details: { connection: "postgresql" },
      };
    } catch (err) {
      logger.warn({ err }, "Deep readiness: database check failed");
      return {
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async checkCache(): Promise<DependencyResult> {
    const start = Date.now();
    try {
      await this.redisClient.ping();
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        details: { connection: "redis" },
      };
    } catch (err) {
      logger.warn({ err }, "Deep readiness: cache check failed");
      return {
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async checkOutboxLag(): Promise<OutboxLagResult> {
    const start = Date.now();
    try {
      const db = getDatabase();

      const [pendingRow, failedRow, deadLetterRow] = await Promise.all([
        db("outbox_events").where({ status: "pending" }).count("* as count").first(),
        db("outbox_events").where({ status: "failed" }).count("* as count").first(),
        db("dead_letter_events").count("* as count").first(),
      ]);

      const pending = parseInt(String(pendingRow?.count ?? 0), 10);
      const failed = parseInt(String(failedRow?.count ?? 0), 10);
      const deadLetter = parseInt(String(deadLetterRow?.count ?? 0), 10);

      let status: DependencyStatus = "healthy";
      if (
        pending >= OUTBOX_PENDING_CRITICAL_THRESHOLD ||
        failed >= OUTBOX_FAILED_CRITICAL_THRESHOLD ||
        deadLetter >= OUTBOX_DEAD_LETTER_CRITICAL_THRESHOLD
      ) {
        status = "unhealthy";
      } else if (
        pending >= OUTBOX_PENDING_WARN_THRESHOLD ||
        failed >= OUTBOX_FAILED_WARN_THRESHOLD
      ) {
        status = "degraded";
      }

      return {
        status,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        pendingEvents: pending,
        failedEvents: failed,
        deadLetterEvents: deadLetter,
      };
    } catch (err) {
      logger.warn({ err }, "Deep readiness: outbox lag check failed");
      return {
        status: "unknown",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        pendingEvents: 0,
        failedEvents: 0,
        deadLetterEvents: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async checkWorkerHeartbeats(): Promise<WorkerHeartbeatResult[]> {
    const workerNames = [
      "health-check",
      "bridge-watch-jobs-critical",
      "bridge-watch-jobs-high",
      "bridge-watch-jobs-medium",
      "bridge-watch-jobs-low",
    ];

    const results = await Promise.allSettled(
      workerNames.map((name) => this.checkSingleWorker(name))
    );

    return results.map((r, idx) => {
      if (r.status === "fulfilled") {
        return r.value;
      }
      return {
        workerName: workerNames[idx],
        status: "unknown" as DependencyStatus,
        checkedAt: new Date().toISOString(),
        reachable: false,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });
  }

  async checkExternalProviders(): Promise<ExternalProviderResult[]> {
    try {
      const db = getDatabase();
      const rows = await db("external_dependencies")
        .select(
          "provider_key",
          "display_name",
          "status",
          "last_checked_at",
          "last_latency_ms",
          "consecutive_failures",
          "maintenance_mode"
        )
        .orderBy("provider_key");

      return rows.map((row) => {
        const maintenanceMode = Boolean(row.maintenance_mode);
        const rawStatus = String(row.status ?? "unknown");
        const status: DependencyStatus = maintenanceMode
          ? "degraded"
          : this.normalizeToDependencyStatus(rawStatus);

        return {
          providerKey: String(row.provider_key),
          displayName: String(row.display_name),
          status,
          checkedAt: new Date().toISOString(),
          lastCheckedAt: row.last_checked_at
            ? new Date(String(row.last_checked_at)).toISOString()
            : null,
          details: {
            lastLatencyMs: row.last_latency_ms ?? null,
            consecutiveFailures: Number(row.consecutive_failures ?? 0),
            maintenanceMode,
          },
        } satisfies ExternalProviderResult;
      });
    } catch (err) {
      logger.warn({ err }, "Deep readiness: external providers check failed");
      return [];
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async checkSingleWorker(queueName: string): Promise<WorkerHeartbeatResult> {
    const start = Date.now();
    try {
      const { Queue } = await import("bullmq");
      const connection = {
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        password: config.REDIS_PASSWORD || undefined,
      };

      const queue = new Queue(queueName, { connection });
      const counts = await queue.getJobCounts();
      await queue.close();

      const failed = Number(counts.failed ?? 0);
      const status: DependencyStatus =
        failed >= WORKER_FAILED_CRITICAL_THRESHOLD ? "unhealthy" : "healthy";

      return {
        workerName: queueName,
        status,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        reachable: true,
        jobCounts: {
          waiting: Number(counts.waiting ?? 0),
          active: Number(counts.active ?? 0),
          completed: Number(counts.completed ?? 0),
          failed,
          delayed: Number(counts.delayed ?? 0),
        },
      };
    } catch (err) {
      return {
        workerName: queueName,
        status: "unknown",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private settle<T extends DependencyResult>(
    result: PromiseSettledResult<T>,
    label: string
  ): T {
    if (result.status === "fulfilled") {
      return result.value;
    }
    logger.warn({ label, reason: result.reason }, "Deep readiness check promise rejected");
    return {
      status: "unknown",
      checkedAt: new Date().toISOString(),
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    } as T;
  }

  private settleOutbox(
    result: PromiseSettledResult<OutboxLagResult>
  ): OutboxLagResult {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      status: "unknown",
      checkedAt: new Date().toISOString(),
      pendingEvents: 0,
      failedEvents: 0,
      deadLetterEvents: 0,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    };
  }

  private settleWorkers(
    result: PromiseSettledResult<WorkerHeartbeatResult[]>
  ): WorkerHeartbeatResult[] {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return [];
  }

  private settleExternalProviders(
    result: PromiseSettledResult<ExternalProviderResult[]>
  ): ExternalProviderResult[] {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return [];
  }

  private collectStatuses(checks: DeepReadinessResponse["checks"]): DependencyStatus[] {
    const statuses: DependencyStatus[] = [
      checks.database.status,
      checks.cache.status,
      checks.outbox.status,
      ...checks.workers.map((w) => w.status),
      ...checks.externalProviders.map((p) => p.status),
    ];
    return statuses;
  }

  private buildSummary(
    statuses: DependencyStatus[]
  ): DeepReadinessResponse["summary"] {
    const total = statuses.length;
    const healthy = statuses.filter((s) => s === "healthy").length;
    const unhealthy = statuses.filter((s) => s === "unhealthy").length;
    const degraded = statuses.filter((s) => s === "degraded").length;
    const unknown = statuses.filter((s) => s === "unknown").length;
    return { total, healthy, unhealthy, degraded, unknown };
  }

  private normalizeToDependencyStatus(value: string): DependencyStatus {
    switch (value) {
      case "healthy":
        return "healthy";
      case "degraded":
      case "maintenance":
        return "degraded";
      case "down":
        return "unhealthy";
      default:
        return "unknown";
    }
  }
}
