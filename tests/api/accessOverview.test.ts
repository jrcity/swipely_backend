import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccessOverviewService } from "../../src/services/accessOverview.service.js";
import * as connection from "../../src/database/connection.js";

function makeDb(bridges: object[], operators: object[]) {
  const queryBuilder = (table: string) => {
    const rows = table === "bridges" ? bridges : operators;
    const qb: any = {
      select: () => qb,
      where: () => qb,
      orderBy: () => qb,
      // Awaitable regardless of which method terminates the chain.
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return qb;
  };
  return queryBuilder;
}

describe("AccessOverviewService.listSummaries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when no bridges exist", async () => {
    vi.spyOn(connection, "getDatabase").mockReturnValue(makeDb([], []) as any);
    const svc = new AccessOverviewService();
    const result = await svc.listSummaries();
    expect(result).toEqual([]);
  });

  it("maps each bridge to a WorkspaceAccessSummary", async () => {
    const bridges = [{ id: "bridge-uuid-1", name: "stellar-eth" }];
    const operators = [
      { bridge_id: "stellar-eth", operator_address: "0xABC", provider_name: "Prov1", is_active: true },
      { bridge_id: "stellar-eth", operator_address: "0xDEF", provider_name: "Prov2", is_active: true },
    ];
    vi.spyOn(connection, "getDatabase").mockReturnValue(makeDb(bridges, operators) as any);
    const svc = new AccessOverviewService();
    const result = await svc.listSummaries();
    expect(result).toHaveLength(1);
    expect(result[0].workspaceId).toBe("bridge-uuid-1");
    expect(result[0].workspaceName).toBe("stellar-eth");
    expect(result[0].roles.operator).toContain("0xABC");
    expect(result[0].roles.operator).toContain("0xDEF");
  });

  it("returns empty operator list for bridges with no operators", async () => {
    const bridges = [{ id: "bridge-uuid-2", name: "stellar-btc" }];
    vi.spyOn(connection, "getDatabase").mockReturnValue(makeDb(bridges, []) as any);
    const svc = new AccessOverviewService();
    const result = await svc.listSummaries();
    expect(result[0].roles.operator).toEqual([]);
  });

  it("addSummary returns the passed summary unchanged", async () => {
    const svc = new AccessOverviewService();
    const summary = { workspaceId: "x", workspaceName: "y", roles: {} };
    expect(await svc.addSummary(summary)).toEqual(summary);
  });
});
