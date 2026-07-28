import { describe, it, expect, vi, beforeEach } from "vitest";

const deduplicateMock = vi.hoisted(() => vi.fn());
const routeAlertMock = vi.hoisted(() => vi.fn());

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
      SCHEMA_DRIFT_ALERT_OWNER: "system:schema-drift",
      SCHEMA_DRIFT_ALERT_DEDUP_WINDOW_MS: 15 * 60 * 1000,
    },
  };
});

import { alertOnSchemaDrift } from "../../src/services/schemaDriftAlerting.service.js";
import type { DriftIncident } from "../../src/services/schemaDrift.service.js";

const fakeIncident = {
  id: "incident-1",
  bridgeId: "bridge-coingecko:price",
  assetCode: "CoinGecko:SimplePrice:price",
  severity: "critical",
  status: "open",
  title: "Alert: schema_drift on CoinGecko:SimplePrice:price",
  description: "test",
  sourceUrl: null,
  sourceType: "schema_drift",
  sourceExternalId: "schema_baselines:CoinGecko:SimplePrice",
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

function makeIncident(overrides: Partial<DriftIncident> = {}): DriftIncident {
  return {
    sourceName: "CoinGecko:SimplePrice",
    driftType: "TYPE_CHANGE",
    fieldPath: "price",
    expectedType: "number",
    actualType: "string",
    isBreaking: true,
    ...overrides,
  };
}

describe("alertOnSchemaDrift (issue #7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deduplicateMock.mockResolvedValue(fakeIncident);
    routeAlertMock.mockResolvedValue(undefined);
  });

  describe("added-field scenario", () => {
    it("raises a low-severity alert with an addition diff summary", async () => {
      const incident = makeIncident({
        driftType: "ADDITION",
        fieldPath: "metadata.volume24h",
        expectedType: undefined,
        actualType: "number",
        isBreaking: false,
      });

      const result = await alertOnSchemaDrift(incident);

      expect(result.alerted).toBe(true);
      expect(result.severity).toBe("low");

      const [event, context] = deduplicateMock.mock.calls[0];
      expect(event.assetCode).toBe("CoinGecko:SimplePrice:metadata.volume24h");
      expect(event.alertType).toBe("schema_drift");
      expect(event.priority).toBe("low");
      expect(context.descriptionOverride).toContain("New field 'metadata.volume24h' appeared in CoinGecko:SimplePrice");
      expect(context.descriptionOverride).toContain("type number");
    });
  });

  describe("removed-field scenario", () => {
    it("raises a critical-severity alert with a removal diff summary", async () => {
      const incident = makeIncident({
        driftType: "REMOVAL",
        fieldPath: "price",
        expectedType: "number",
        actualType: undefined,
        isBreaking: true,
      });

      const result = await alertOnSchemaDrift(incident);

      expect(result.alerted).toBe(true);
      expect(result.severity).toBe("critical");

      const [event, context] = deduplicateMock.mock.calls[0];
      expect(event.priority).toBe("critical");
      expect(context.descriptionOverride).toContain("Field 'price' was removed from CoinGecko:SimplePrice");
      expect(context.descriptionOverride).toContain("previously number");
    });
  });

  describe("type-change scenario", () => {
    it("raises a critical-severity alert with a before/after type diff summary", async () => {
      const incident = makeIncident({
        driftType: "TYPE_CHANGE",
        fieldPath: "price",
        expectedType: "number",
        actualType: "string",
        isBreaking: true,
      });

      const result = await alertOnSchemaDrift(incident);

      expect(result.alerted).toBe(true);
      expect(result.severity).toBe("critical");

      const [event, context] = deduplicateMock.mock.calls[0];
      expect(event.priority).toBe("critical");
      expect(context.descriptionOverride).toBe(
        "Field 'price' on CoinGecko:SimplePrice changed type from number to string"
      );
    });
  });

  it("deduplicates repeated identical drift using a configurable window scoped to provider+field", async () => {
    const incident = makeIncident();
    await alertOnSchemaDrift(incident);

    expect(deduplicateMock).toHaveBeenCalledTimes(1);
    const [event, , windowMs] = deduplicateMock.mock.calls[0];
    expect(event.assetCode).toBe("CoinGecko:SimplePrice:price");
    expect(event.alertType).toBe("schema_drift");
    expect(windowMs).toBe(15 * 60 * 1000);
  });

  it("routes the alert through the standard alert pipeline with provider, field, and severity", async () => {
    const incident = makeIncident();
    await alertOnSchemaDrift(incident);

    expect(routeAlertMock).toHaveBeenCalledTimes(1);
    const [routedAlert] = routeAlertMock.mock.calls[0];
    expect(routedAlert.sourceType).toBe("schema_drift");
    expect(routedAlert.assetCode).toBe("CoinGecko:SimplePrice:price");
    expect(routedAlert.metric).toBe("price");
    expect(routedAlert.severity).toBe("critical");
    expect(routedAlert.ownerAddress).toBe("system:schema-drift");
    expect(routedAlert.ruleName).toContain("changed type from number to string");
  });

  it("does not throw and reports the reason when deduplication fails", async () => {
    deduplicateMock.mockRejectedValueOnce(new Error("db down"));

    const result = await alertOnSchemaDrift(makeIncident());

    expect(result.alerted).toBe(false);
    expect(result.reason).toBe("deduplication_failed");
    expect(routeAlertMock).not.toHaveBeenCalled();
  });

  it("returns alerted=true with a reason when routing fails, since the incident was still recorded", async () => {
    routeAlertMock.mockRejectedValueOnce(new Error("routing down"));

    const result = await alertOnSchemaDrift(makeIncident());

    expect(result.alerted).toBe(true);
    expect(result.reason).toBe("routing_failed");
    expect(result.incident?.id).toBe(fakeIncident.id);
  });
});
