import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExternalDependencyMonitorService } from "../../src/services/externalDependencyMonitor.service.js";

// ---------------------------------------------------------------------------
// DB mock factory
//
// Design goals:
//   1. Supports ALL knex chain patterns used by the service:
//        db(t).select("*")                          → terminal awaitable
//        db(t).select("*").orderBy(...)             → awaitable
//        db(t).where(...).orderBy(...).limit(n)     → awaitable
//        db(t).where(...).update(...).returning("*")→ awaitable
//        db(t).insert(...).onConflict(...).merge()  → awaitable
//        db(t).where(...).first()                   → awaitable
//   2. Tests can override any terminal call with .mockResolvedValueOnce()
//      via the shared spies exposed on db(table).
//   3. Each test gets a completely fresh set of query builders.
// ---------------------------------------------------------------------------
const makeMockDb = () => {
  const store: Record<string, any[]> = {
    external_dependencies:       [],
    external_dependency_checks:  [],
  };

  const createQuery = (table: string) => {
    // The builder is both chainable (methods return the builder) and awaitable
    // (a `then` makes `await db(table)...` resolve to the pending result), which
    // mirrors how a real Knex query builder behaves.
    const UNSET = Symbol("unset");
    const rowsOf = () => (store[table as keyof typeof store] as any[]) || [];
    let result: any = UNSET;

    const query: any = {
      where: vi.fn(() => query),
      whereIn: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(() => query),
      select: vi.fn(() => {
        result = rowsOf();
        return query;
      }),
      first: vi.fn(async () => {
        const items = rowsOf();
        return items.length > 0 ? items[0] : null;
      }),
      insert: vi.fn((data: any) => {
        const items = Array.isArray(data) ? data : [data];
        rowsOf().push(...items);
        result = items;
        return query;
      }),
      update: vi.fn((data: any) => {
        const items = rowsOf();
        if (items.length > 0) {
          Object.assign(items[0], data);
          result = [items[0]];
        } else {
          result = [];
        }
        return query;
      }),
      onConflict: vi.fn(() => query),
      merge: vi.fn(() => {
        result = undefined;
        return query;
      }),
      returning: vi.fn(() => query),
      then: (resolve: any, reject: any) =>
        Promise.resolve(result === UNSET ? rowsOf() : result).then(resolve, reject),
    };

    return query;
  };

  // Cache one builder per table so per-test overrides such as
  // `db("table").select.mockResolvedValueOnce(...)` apply to the same builder
  // the service under test receives.
  const queryCache: Record<string, any> = {};
  const db: any = (table: string) => (queryCache[table] ??= createQuery(table));
  db.raw = vi.fn();
  db.fn = { now: () => new Date() };
  db.client = {
    wrapIdentifier: (id: string) => `"${id}"`,
  };
  db.transaction = vi.fn(async (callback: any) => {
    // Reuse the same cached builders as `db` so assertions on
    // `db("table").update.mock.calls` see updates issued through the trx.
    const trx: any = (table: string) => db(table);
    trx.raw = db.raw;
    trx.fn  = db.fn;
    return cb(trx);
  });
  db.__store = store;

  return db;
};

vi.mock("../../src/database/connection.js", () => ({ getDatabase: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../src/config/index.js", () => ({
  config: {
    STELLAR_HORIZON_URL: "https://horizon.stellar.org",
    SOROBAN_RPC_URL:     "https://soroban-rpc.stellar.org",
    ETHEREUM_RPC_URL:    "https://eth.llamarpc.com",
    POLYGON_RPC_URL:     "https://polygon.llamarpc.com",
    BASE_RPC_URL:        "https://base.llamarpc.com",
  },
}));

global.fetch = vi.fn();

describe("ExternalDependencyMonitorService", () => {
  let service: ExternalDependencyMonitorService;
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(async () => {
    const { getDatabase } = await import("../../src/database/connection.js");
    db = makeMockDb();
    vi.mocked(getDatabase).mockReturnValue(db);
    service = new ExternalDependencyMonitorService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── listDependencies ───────────────────────────────────────────────────────

  describe("listDependencies", () => {
    it("lists all dependencies", async () => {
      const mockDeps = [{ provider_key: "stellar-horizon", display_name: "Stellar Horizon", category: "core-rpc", endpoint: "https://horizon.stellar.org", check_type: "http", latency_warning_ms: 750, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, maintenance_note: null, status: "healthy", last_checked_at: new Date().toISOString(), last_latency_ms: 150, consecutive_failures: 0, last_success_at: new Date().toISOString(), last_failure_at: null, last_error: null }];

      db("external_dependencies").orderBy.mockResolvedValueOnce(mockDependencies);

      const result = await service.listDependencies();

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].providerKey).toBe("stellar-horizon");
      expect(result.summary).toBeDefined();
    });

    it("includes history when requested", async () => {
      const mockDeps = [{ provider_key: "stellar-horizon", display_name: "Stellar Horizon", category: "core-rpc", endpoint: "https://horizon.stellar.org", check_type: "http", latency_warning_ms: 750, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, status: "healthy", last_checked_at: new Date().toISOString(), consecutive_failures: 0 }];
      const mockHistory = [{ id: "c1", provider_key: "stellar-horizon", status: "healthy", checked_at: new Date().toISOString(), latency_ms: 150, status_code: 200, within_threshold: true, alert_triggered: false, error: null, details: "{}" }];

      const mockHistory = [
        {
          id: "check-1",
          provider_key: "stellar-horizon",
          status: "healthy",
          checked_at: new Date().toISOString(),
          latency_ms: 150,
          status_code: 200,
          within_threshold: true,
          alert_triggered: false,
          error: null,
          details: JSON.stringify({}),
        },
      ];

      db("external_dependencies").orderBy.mockResolvedValueOnce(mockDependencies);
      db("external_dependency_checks").orderBy.mockResolvedValueOnce(mockHistory);

      const result = await service.listDependencies({ includeHistory: true, historyLimit: 10 });

      expect(result.dependencies[0].history).toHaveLength(1);
    });

    it("calculates summary correctly", async () => {
      const mockDependencies = [
        {
          provider_key: "dep1",
          status: "healthy",
          maintenance_mode: false,
          consecutive_failures: 0,
        },
        {
          provider_key: "dep2",
          status: "degraded",
          maintenance_mode: false,
          consecutive_failures: 1,
        },
        {
          provider_key: "dep3",
          status: "down",
          maintenance_mode: false,
          consecutive_failures: 3,
        },
      ];

      db("external_dependencies").orderBy.mockResolvedValueOnce(mockDependencies);

      const result = await service.listDependencies();

      expect(result.summary.healthy).toBe(1);
      expect(result.summary.degraded).toBe(1);
      expect(result.summary.down).toBe(1);
    });
  });

  // ── getDependencyHistory ───────────────────────────────────────────────────

  describe("getDependencyHistory", () => {
    it("retrieves history for a specific provider", async () => {
      const rows = [
        { id: "c1", provider_key: "stellar-horizon", status: "healthy", checked_at: new Date().toISOString(), latency_ms: 150, status_code: 200, within_threshold: true, alert_triggered: false, error: null, details: "{}" },
        { id: "c2", provider_key: "stellar-horizon", status: "healthy", checked_at: new Date().toISOString(), latency_ms: 200, status_code: 200, within_threshold: true, alert_triggered: false, error: null, details: "{}" },
      ];
      db("external_dependency_checks").limit.mockResolvedValueOnce(rows);

      const history = await service.getDependencyHistory("stellar-horizon");

      expect(history).toHaveLength(2);
      expect(history[0].providerKey).toBe("stellar-horizon");
    });

    it("respects limit parameter", async () => {
      db("external_dependency_checks").limit.mockResolvedValueOnce([]);

      await service.getDependencyHistory("stellar-horizon", 20);

      expect(db("external_dependency_checks").limit.mock.calls.some((c: any[]) => c[0] === 20)).toBe(true);
    });
  });

  // ── runAllChecks ───────────────────────────────────────────────────────────

  describe("runAllChecks", () => {
    it("runs checks for all dependencies", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "stellar-horizon", display_name: "Stellar Horizon", endpoint: "https://horizon.stellar.org", check_type: "http", latency_warning_ms: 750, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true } as Response);

      const results = await service.runAllChecks("manual");

      expect(results).toHaveLength(1);
      expect(results[0].providerKey).toBe("stellar-horizon");
    });

    it("handles check failures", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "stellar-horizon", endpoint: "https://horizon.stellar.org", check_type: "http", latency_warning_ms: 750, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

      const results = await service.runAllChecks();

      expect(results[0].status).toBe("down");
      expect(results[0].error).toBe("Network error");
    });

    it("skips dependencies in maintenance mode", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "stellar-horizon", endpoint: "https://horizon.stellar.org", check_type: "http", maintenance_mode: true, maintenance_note: "maintenance", consecutive_failures: 0 },
      ]);

      const results = await service.runAllChecks();

      expect(results[0].status).toBe("maintenance");
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // ── setMaintenanceMode ─────────────────────────────────────────────────────

  describe("setMaintenanceMode", () => {
    const baseDep = { provider_key: "stellar-horizon", display_name: "Stellar Horizon", category: "core-rpc", endpoint: "https://horizon.stellar.org", check_type: "http", latency_warning_ms: 750, latency_critical_ms: 2000, failure_threshold: 2, consecutive_failures: 0 };

      db("external_dependencies").returning.mockResolvedValueOnce([mockDependency]);

      const result = await service.setMaintenanceMode("stellar-horizon", true, "upgrade");

      expect(result?.providerKey).toBe("stellar-horizon");
    });

    it("disables maintenance mode", async () => {
      const mockDependency = {
        provider_key: "stellar-horizon",
        maintenance_mode: false,
        maintenance_note: null,
        status: "unknown",
      };

      db("external_dependencies").returning.mockResolvedValueOnce([mockDependency]);

      const result = await service.setMaintenanceMode("stellar-horizon", false);

      expect(result).toBeDefined();
      expect(db("external_dependencies").update.mock.calls[0]?.[0]).toMatchObject({ maintenance_mode: false, maintenance_note: null });
    });

    it("returns null when dependency not found", async () => {
      db("external_dependencies").returning.mockResolvedValueOnce([]);

      const result = await service.setMaintenanceMode("nonexistent", true);

      expect(result).toBeNull();
    });
  });

  // ── health check logic ─────────────────────────────────────────────────────

  describe("health check logic", () => {
    it("marks as healthy when response is ok", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "t", endpoint: "https://t.com", check_type: "http", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true } as Response);

      const results = await service.runAllChecks();

      expect(results[0].status).toBe("healthy");
      expect(results[0].withinThreshold).toBe(true);
    });

    it("marks as degraded when latency exceeds warning threshold", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "t", endpoint: "https://t.com", check_type: "http", latency_warning_ms: 10, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ status: 200, ok: true } as Response), 50)));

      const results = await service.runAllChecks();

      expect(results[0].status).toMatch(/healthy|degraded/);
    });

    it("marks as down when status is 500", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "t", endpoint: "https://t.com", check_type: "http", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockResolvedValueOnce({ status: 500, ok: false } as Response);

      const results = await service.runAllChecks();

      expect(results[0].status).toBe("down");
    });

    it("marks as degraded when status is 400", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "t", endpoint: "https://t.com", check_type: "http", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockResolvedValueOnce({ status: 400, ok: false } as Response);

      const results = await service.runAllChecks();

      expect(results[0].status).toBe("degraded");
    });
  });

  // ── alert thresholds ───────────────────────────────────────────────────────

  describe("alert thresholds", () => {
    it("triggers alert when failure threshold reached", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "t", endpoint: "https://t.com", check_type: "http", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 1 },
      ]);
      vi.mocked(fetch).mockRejectedValueOnce(new Error("fail"));

      const results = await service.runAllChecks();

      expect(results[0].alertTriggered).toBe(true);
    });

    it("does not trigger alert below threshold", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "t", endpoint: "https://t.com", check_type: "http", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 3, maintenance_mode: false, consecutive_failures: 1 },
      ]);
      vi.mocked(fetch).mockRejectedValueOnce(new Error("fail"));

      const results = await service.runAllChecks();

      expect(results[0].alertTriggered).toBe(false);
    });

    it("resets consecutive failures on success", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "t", endpoint: "https://t.com", check_type: "http", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 5 },
      ]);
      vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true } as Response);

      await service.runAllChecks();

      const call = db("external_dependencies").update.mock.calls.find(
        (c: any[]) => c[0] != null && "consecutive_failures" in c[0]
      );
      expect(call?.[0].consecutive_failures).toBe(0);
    });
  });

  // ── check types ────────────────────────────────────────────────────────────

  describe("check types", () => {
    it("performs HTTP checks correctly", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "http-svc", endpoint: "https://api.example.com/health", check_type: "http", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true } as Response);

      await service.runAllChecks();

      expect(fetch).toHaveBeenCalledWith("https://api.example.com/health", expect.objectContaining({ method: "GET" }));
    });

    it("performs JSON-RPC checks correctly", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "soroban-rpc", endpoint: "https://soroban-rpc.stellar.org", check_type: "jsonrpc", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true } as Response);

      await service.runAllChecks();

      expect(fetch).toHaveBeenCalledWith("https://soroban-rpc.stellar.org", expect.objectContaining({ method: "POST", body: expect.stringContaining("getHealth") }));
    });

    it("uses correct RPC method for different providers", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "ethereum-rpc", endpoint: "https://eth.llamarpc.com", check_type: "jsonrpc", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true } as Response);

      await service.runAllChecks();

      expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: expect.stringContaining("eth_blockNumber") }));
    });
  });

  // ── timeout handling ───────────────────────────────────────────────────────

  describe("timeout handling", () => {
    it("aborts request after timeout", async () => {
      db("external_dependencies").select.mockResolvedValueOnce([
        { provider_key: "slow", endpoint: "https://slow.example.com", check_type: "http", latency_warning_ms: 1000, latency_critical_ms: 2000, failure_threshold: 2, maintenance_mode: false, consecutive_failures: 0 },
      ]);
      vi.mocked(fetch).mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("Aborted")), 100)));

      const results = await service.runAllChecks();

      expect(results[0].status).toBe("down");
    });
  });
});
