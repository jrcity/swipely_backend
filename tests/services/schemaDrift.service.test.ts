import { describe, it, expect, vi, beforeEach } from "vitest";

const alertOnSchemaDriftMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/schemaDriftAlerting.service.js", () => ({
  alertOnSchemaDrift: alertOnSchemaDriftMock,
}));

const baselineRow = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const insertedIncidents = vi.hoisted(() => ({ records: [] as unknown[] }));

vi.mock("../../src/database/connection.js", () => ({
  getDatabase: () => {
    const db = (table: string) => {
      if (table === "schema_baselines") {
        return {
          where: () => ({
            first: async () => baselineRow.current,
          }),
          insert: () => ({
            onConflict: () => ({
              merge: async () => undefined,
            }),
          }),
        };
      }
      if (table === "schema_drift_incidents") {
        return {
          insert: async (records: unknown[]) => {
            insertedIncidents.records.push(...records);
            return [];
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    };
    (db as any).fn = { now: () => new Date() };
    (db as any).raw = (sql: string) => sql;
    return db;
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SchemaDriftService } from "../../src/services/schemaDrift.service.js";

describe("SchemaDriftService.checkDrift alerting integration (issue #7)", () => {
  let service: SchemaDriftService;

  beforeEach(() => {
    vi.clearAllMocks();
    alertOnSchemaDriftMock.mockResolvedValue({ alerted: true, severity: "critical" });
    insertedIncidents.records = [];
    baselineRow.current = null;
  });

  it("creates a baseline and raises no alert on first sight of a source", async () => {
    baselineRow.current = null;
    const report = await service_().checkDrift("TestProvider", { a: 1, b: "x" });

    expect(report.hasDrift).toBe(false);
    expect(alertOnSchemaDriftMock).not.toHaveBeenCalled();
  });

  it("added-field: raises exactly one non-breaking alert for the new field", async () => {
    baselineRow.current = {
      source_name: "TestProvider",
      schema_definition: { root: "object", a: "number" },
    };

    const report = await service_().checkDrift("TestProvider", { a: 1, b: "new" });

    expect(report.hasDrift).toBe(true);
    const addition = report.incidents.find((i) => i.driftType === "ADDITION");
    expect(addition).toBeDefined();
    expect(addition?.fieldPath).toBe("b");
    expect(addition?.isBreaking).toBe(false);

    expect(alertOnSchemaDriftMock).toHaveBeenCalledTimes(1);
    expect(alertOnSchemaDriftMock).toHaveBeenCalledWith(
      expect.objectContaining({ driftType: "ADDITION", fieldPath: "b", isBreaking: false })
    );
  });

  it("removed-field: raises exactly one breaking alert for the missing field", async () => {
    baselineRow.current = {
      source_name: "TestProvider",
      schema_definition: { root: "object", a: "number", b: "string" },
    };

    const report = await service_().checkDrift("TestProvider", { a: 1 });

    expect(report.hasDrift).toBe(true);
    const removal = report.incidents.find((i) => i.driftType === "REMOVAL");
    expect(removal).toBeDefined();
    expect(removal?.fieldPath).toBe("b");
    expect(removal?.isBreaking).toBe(true);

    expect(alertOnSchemaDriftMock).toHaveBeenCalledTimes(1);
    expect(alertOnSchemaDriftMock).toHaveBeenCalledWith(
      expect.objectContaining({ driftType: "REMOVAL", fieldPath: "b", isBreaking: true })
    );
  });

  it("type-change: raises exactly one breaking alert with expected/actual types", async () => {
    baselineRow.current = {
      source_name: "TestProvider",
      schema_definition: { root: "object", a: "number" },
    };

    const report = await service_().checkDrift("TestProvider", { a: "not-a-number" });

    expect(report.hasDrift).toBe(true);
    const typeChange = report.incidents.find((i) => i.driftType === "TYPE_CHANGE");
    expect(typeChange).toBeDefined();
    expect(typeChange?.fieldPath).toBe("a");
    expect(typeChange?.expectedType).toBe("number");
    expect(typeChange?.actualType).toBe("string");
    expect(typeChange?.isBreaking).toBe(true);

    expect(alertOnSchemaDriftMock).toHaveBeenCalledTimes(1);
    expect(alertOnSchemaDriftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        driftType: "TYPE_CHANGE",
        fieldPath: "a",
        expectedType: "number",
        actualType: "string",
      })
    );
  });

  it("does not fail checkDrift when alerting itself throws", async () => {
    baselineRow.current = {
      source_name: "TestProvider",
      schema_definition: { root: "object", a: "number" },
    };
    alertOnSchemaDriftMock.mockRejectedValueOnce(new Error("routing down"));

    await expect(
      service_().checkDrift("TestProvider", { a: "broken" })
    ).resolves.toMatchObject({ hasDrift: true });
  });

  function service_(): SchemaDriftService {
    if (!service) {
      service = new SchemaDriftService();
    }
    return service;
  }
});
