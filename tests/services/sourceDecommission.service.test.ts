import { describe, it, expect, beforeEach, vi } from "vitest";
import { SourceDecommissionService } from "../../src/services/sourceDecommission.service.js";

const createQueryBuilder = (rows: any[] = []) => {
  const builder: any = {
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    onConflict: vi.fn().mockReturnThis(),
    merge: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(rows),
    first: vi.fn().mockResolvedValue(rows[0]),
    then: (resolve: (value: any) => any) => resolve(rows),
  };
  return builder;
};

const mockKnex = vi.hoisted(() => {
  const knex: any = vi.fn(() => createQueryBuilder([]));
  return knex;
});

const auditLogMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../src/database/connection.js", () => ({
  getDatabase: () => mockKnex,
}));

vi.mock("../../src/services/audit.service.js", () => ({
  auditService: { log: auditLogMock },
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "d1",
    source_key: "old-source",
    replacement_source_key: "new-source",
    status: "deprecated",
    deprecation_period_days: 30,
    deprecation_started_at: now.toISOString(),
    deprecation_ends_at: new Date(now.getTime() - 1000).toISOString(),
    fallback_routing_enabled: true,
    migration_progress_pct: "0.00",
    completion_ready: false,
    completion_verified_at: null,
    created_by: "admin",
    reason: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

describe("SourceDecommissionService", () => {
  let service: SourceDecommissionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SourceDecommissionService();
  });

  describe("startDecommission", () => {
    it("rejects decommissioning a source into itself", async () => {
      await expect(
        service.startDecommission({ sourceKey: "a", replacementSourceKey: "a", actorId: "admin" })
      ).rejects.toThrow(/must differ/);
    });

    it("creates a decommission row and writes an audit entry", async () => {
      mockKnex.mockImplementation((table: string) => {
        if (table === "source_decommissions") {
          const builder = createQueryBuilder([]);
          builder.first = vi.fn().mockResolvedValue(undefined);
          builder.returning = vi.fn().mockResolvedValue([makeRow()]);
          return builder;
        }
        return createQueryBuilder([]);
      });

      const result = await service.startDecommission({
        sourceKey: "old-source",
        replacementSourceKey: "new-source",
        actorId: "admin",
      });

      expect(result.sourceKey).toBe("old-source");
      expect(result.status).toBe("deprecated");
      expect(auditLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: "source.decommission_started" })
      );
    });

    it("refuses to start a new decommission while one is already active", async () => {
      mockKnex.mockImplementation(() => {
        const builder = createQueryBuilder([]);
        builder.first = vi.fn().mockResolvedValue(makeRow({ status: "migrating" }));
        return builder;
      });

      await expect(
        service.startDecommission({ sourceKey: "old-source", replacementSourceKey: "new-source", actorId: "admin" })
      ).rejects.toThrow(/already has an active decommission/);
    });
  });

  describe("getFallbackSource", () => {
    it("returns the replacement when fallback routing is enabled", async () => {
      mockKnex.mockImplementation(() => {
        const builder = createQueryBuilder([]);
        builder.first = vi.fn().mockResolvedValue(makeRow());
        return builder;
      });

      const fallback = await service.getFallbackSource("old-source");
      expect(fallback).toBe("new-source");
    });

    it("returns null once the decommission is completed", async () => {
      mockKnex.mockImplementation(() => {
        const builder = createQueryBuilder([]);
        builder.first = vi.fn().mockResolvedValue(makeRow({ status: "completed" }));
        return builder;
      });

      const fallback = await service.getFallbackSource("old-source");
      expect(fallback).toBeNull();
    });
  });

  describe("completeDecommission", () => {
    it("blocks completion when migration progress is below 100%", async () => {
      mockKnex.mockImplementation(() => {
        const builder = createQueryBuilder([]);
        builder.first = vi.fn().mockResolvedValue(makeRow({ migration_progress_pct: "40.00" }));
        return builder;
      });

      await expect(service.completeDecommission("old-source", "admin")).rejects.toThrow(/40/);
    });

    it("blocks completion before the deprecation period elapses", async () => {
      mockKnex.mockImplementation(() => {
        const builder = createQueryBuilder([]);
        builder.first = vi.fn().mockResolvedValue(
          makeRow({ migration_progress_pct: "100.00", deprecation_ends_at: new Date(Date.now() + 86_400_000).toISOString() })
        );
        return builder;
      });

      await expect(service.completeDecommission("old-source", "admin")).rejects.toThrow(/deprecation period/i);
    });

    it("completes and audits once all criteria are satisfied", async () => {
      const eligibleRow = makeRow({ migration_progress_pct: "100.00" });
      mockKnex.mockImplementation(() => {
        const builder = createQueryBuilder([]);
        builder.first = vi.fn().mockResolvedValue(eligibleRow);
        builder.returning = vi.fn().mockResolvedValue([{ ...eligibleRow, status: "completed" }]);
        return builder;
      });

      const result = await service.completeDecommission("old-source", "admin");

      expect(result.status).toBe("completed");
      expect(auditLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: "source.decommission_completed" })
      );
    });
  });

  describe("rollbackDecommission", () => {
    it("marks the flow rolled back and disables fallback routing", async () => {
      mockKnex.mockImplementation(() => {
        const builder = createQueryBuilder([]);
        builder.first = vi.fn().mockResolvedValue(makeRow());
        builder.returning = vi.fn().mockResolvedValue([makeRow({ status: "rolled_back", fallback_routing_enabled: false })]);
        return builder;
      });

      const result = await service.rollbackDecommission("old-source", "admin", "replacement unstable");

      expect(result.status).toBe("rolled_back");
      expect(result.fallbackRoutingEnabled).toBe(false);
      expect(auditLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: "source.decommission_rolled_back" })
      );
    });
  });
});
