import { describe, it, expect, vi, beforeEach } from "vitest";

const deduplicateMock = vi.hoisted(() => vi.fn());
const routeAlertMock = vi.hoisted(() => vi.fn());
const getReconciliationAlertThresholdMock = vi.hoisted(() =>
  vi.fn((assetCode: string) => (assetCode === "TIGHT" ? 0.01 : 0.1))
);

vi.mock("../../src/services/alertDeduplication.service.js", () => ({
  alertDeduplicationService: {
    deduplicate: deduplicateMock,
  },
}));

vi.mock("../../src/services/alertRouting.service.js", () => ({
  alertRoutingService: {
    routeAlert: routeAlertMock,
  },
}));

vi.mock("../../src/config/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/config/index.js")>(
    "../../src/config/index.js"
  );
  return {
    ...actual,
    config: {
      ...actual.config,
      RECONCILIATION_ALERT_OWNER: "system:reconciliation",
    },
    getReconciliationAlertThreshold: getReconciliationAlertThresholdMock,
  };
});

import { alertOnReconciliationMismatch } from "../../src/services/reconciliationAlerting.service.js";

const fakeIncident = {
  id: "incident-1",
  bridgeId: "bridge-usdc",
  assetCode: "USDC",
  severity: "medium",
  status: "open",
  title: "Alert: supply_mismatch on USDC",
  description: "test",
  sourceUrl: null,
  sourceType: "supply_mismatch",
  sourceExternalId: "reconciliation_runs:run-1",
  sourceRepository: null,
  sourceRepoAvatarUrl: null,
  sourceActor: null,
  sourceAttribution: {},
  enrichmentMetadata: {},
  enrichmentTags: [],
  derivedFields: {},
  enrichmentValidation: {},
  requiresManualReview: false,
  ingestionAttemptCount: 0,
  lastIngestionError: null,
  normalizedFingerprint: null,
  followUpActions: [],
  occurredAt: new Date().toISOString(),
  resolvedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as const;

describe("alertOnReconciliationMismatch (issue #8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deduplicateMock.mockResolvedValue(fakeIncident);
    routeAlertMock.mockResolvedValue(undefined);
    getReconciliationAlertThresholdMock.mockImplementation((assetCode: string) =>
      assetCode === "TIGHT" ? 0.01 : 0.1
    );
  });

  it("does not alert when mismatch is below threshold", async () => {
    const result = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-1",
      stellarSupply: 1000,
      reportedSupply: 999,
      mismatchPercentage: 0.05,
    });

    expect(result.alerted).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(deduplicateMock).not.toHaveBeenCalled();
    expect(routeAlertMock).not.toHaveBeenCalled();
  });

  it("does not alert when mismatchPercentage is null (e.g. no baseline yet)", async () => {
    const result = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-1",
      stellarSupply: null,
      reportedSupply: null,
      mismatchPercentage: null,
    });

    expect(result.alerted).toBe(false);
    expect(deduplicateMock).not.toHaveBeenCalled();
  });

  it("raises an alert exceeding threshold, carrying entity id, both values, delta, and record reference", async () => {
    const result = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-42",
      stellarSupply: 1_000_000,
      reportedSupply: 998_000,
      mismatchPercentage: 0.5,
    });

    expect(result.alerted).toBe(true);
    expect(deduplicateMock).toHaveBeenCalledTimes(1);

    const [event, context] = deduplicateMock.mock.calls[0];
    expect(event.assetCode).toBe("USDC");
    expect(event.triggeredValue).toBe(0.5);
    expect(event.threshold).toBe(0.1);

    expect(context.recordReference).toBe("reconciliation_runs:run-42");
    expect(context.sourceAValue).toBe(1_000_000);
    expect(context.sourceBValue).toBe(998_000);
    expect(context.delta).toBe(2_000);

    expect(routeAlertMock).toHaveBeenCalledTimes(1);
    const [routedAlert] = routeAlertMock.mock.calls[0];
    expect(routedAlert.sourceType).toBe("reconciliation");
    expect(routedAlert.assetCode).toBe("USDC");
    expect(routedAlert.ownerAddress).toBe("system:reconciliation");
  });

  it("routes severity=medium just over threshold, high 2x-5x, critical >=5x", async () => {
    const medium = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-1",
      stellarSupply: 100,
      reportedSupply: 90,
      mismatchPercentage: 0.15,
    });
    expect(medium.severity).toBe("medium");

    const high = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-2",
      stellarSupply: 100,
      reportedSupply: 70,
      mismatchPercentage: 0.3,
    });
    expect(high.severity).toBe("high");

    const critical = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-3",
      stellarSupply: 100,
      reportedSupply: 20,
      mismatchPercentage: 0.9,
    });
    expect(critical.severity).toBe("critical");
  });

  it("uses a per-asset threshold override instead of the global default", async () => {
    const result = await alertOnReconciliationMismatch({
      assetCode: "TIGHT",
      runId: "run-tight-1",
      stellarSupply: 100,
      reportedSupply: 98,
      mismatchPercentage: 0.02,
    });

    expect(result.alerted).toBe(true);
    expect(result.threshold).toBe(0.01);
  });

  it("does not alert for the same value against an asset using the global default", async () => {
    const result = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-2",
      stellarSupply: 100,
      reportedSupply: 98,
      mismatchPercentage: 0.02,
    });

    expect(result.alerted).toBe(false);
  });

  it("delegates duplicate suppression entirely to alertDeduplicationService (collapses repeats)", async () => {
    deduplicateMock.mockResolvedValueOnce(fakeIncident);
    const first = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-a",
      stellarSupply: 100,
      reportedSupply: 80,
      mismatchPercentage: 0.5,
    });

    deduplicateMock.mockResolvedValueOnce(fakeIncident);
    const second = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-b",
      stellarSupply: 100,
      reportedSupply: 79,
      mismatchPercentage: 0.55,
    });

    expect(first.incident?.id).toBe(second.incident?.id);
    expect(deduplicateMock).toHaveBeenCalledTimes(2);
  });

  it("returns alerted=true with reason when routing fails, since the incident was still recorded", async () => {
    routeAlertMock.mockRejectedValueOnce(new Error("routing down"));

    const result = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-route-fail",
      stellarSupply: 100,
      reportedSupply: 50,
      mismatchPercentage: 0.5,
    });

    expect(result.alerted).toBe(true);
    expect(result.reason).toBe("routing_failed");
    expect(result.incident?.id).toBe(fakeIncident.id);
  });

  it("does not throw when deduplication itself fails", async () => {
    deduplicateMock.mockRejectedValueOnce(new Error("db down"));

    const result = await alertOnReconciliationMismatch({
      assetCode: "USDC",
      runId: "run-dedup-fail",
      stellarSupply: 100,
      reportedSupply: 50,
      mismatchPercentage: 0.5,
    });

    expect(result.alerted).toBe(false);
    expect(result.reason).toBe("deduplication_failed");
    expect(routeAlertMock).not.toHaveBeenCalled();
  });
});