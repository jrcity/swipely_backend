import { describe, it, expect, vi } from "vitest";
import { IncidentService } from "../../src/services/incident.service.js";

function makeChainable(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    whereBetween: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    count: vi.fn(() => Promise.resolve([{ count: String(rows.length) }])),
    clone: vi.fn().mockReturnThis(),
    first: vi.fn().mockImplementation(() => Promise.resolve(rows[0] ?? null)),
    select: vi.fn().mockReturnThis(),
  };
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    return Promise.resolve(rows).then(resolve, reject);
  };
  return chain;
}

vi.mock("../../src/database/connection.js", () => {
  const incidentsChainable = makeChainable([]);

  const tableMap: Record<string, typeof incidentsChainable> = {
    incidents: incidentsChainable,
  };

  const knexInstance = Object.assign(
    (tableName: string) => tableMap[tableName] ?? makeChainable(),
    {
      raw: vi.fn((sql: string) => sql),
      fn: { now: () => new Date() },
      incidents: incidentsChainable,
    }
  );

  return {
    getDatabase: vi.fn(() => knexInstance),
  };
});

describe("IncidentService", () => {
  const service = new IncidentService();

  it("should be instantiable", () => {
    expect(service).toBeInstanceOf(IncidentService);
  });

  it("getHeatmapData returns empty result with no data", async () => {
    const result = await service.getHeatmapData({});
    expect(result.buckets).toEqual([]);
    expect(result.totalIncidents).toBe(0);
    expect(result.assets).toEqual([]);
  });

  it("getIncidentReplayTimeline returns null when incident missing", async () => {
    const result = await service.getIncidentReplayTimeline("missing-id");
    expect(result).toBeNull();
  });
});
