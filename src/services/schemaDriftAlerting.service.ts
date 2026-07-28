import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { alertDeduplicationService } from "./alertDeduplication.service.js";
import type { AlertDeduplicationContext } from "./alertDeduplication.service.js";
import { alertRoutingService } from "./alertRouting.service.js";
import type { AlertEvent, AlertPriority } from "./alert.service.js";
import type { BridgeIncident } from "./incident.service.js";
import type { DriftIncident } from "./schemaDrift.service.js";

export interface SchemaDriftAlertResult {
  alerted: boolean;
  severity: AlertPriority;
  incident?: BridgeIncident;
  reason?: string;
}

const SOURCE_TYPE = "schema_drift";

function severityFor(incident: DriftIncident): AlertPriority {
  return incident.isBreaking ? "critical" : "low";
}

/**
 * Builds a human-readable before/after diff summary for a single drift
 * incident, describing the provider, the changed field, and what changed.
 */
function buildDiffSummary(incident: DriftIncident): string {
  switch (incident.driftType) {
    case "REMOVAL":
      return `Field '${incident.fieldPath}' was removed from ${incident.sourceName} (previously ${incident.expectedType ?? "unknown"})`;
    case "ADDITION":
      return `New field '${incident.fieldPath}' appeared in ${incident.sourceName} (type ${incident.actualType ?? "unknown"})`;
    case "TYPE_CHANGE":
      return `Field '${incident.fieldPath}' on ${incident.sourceName} changed type from ${incident.expectedType ?? "unknown"} to ${incident.actualType ?? "unknown"}`;
  }
}

/**
 * Raises a structured, deduplicated, routed alert for a single detected
 * schema drift incident.
 *
 * - Deduplication: delegates to alertDeduplicationService, keyed on a
 *   composite `sourceName:fieldPath` assetCode plus the "schema_drift"
 *   alertType, so repeated identical drift for the same provider/field
 *   collapses into a single open incident (escalating severity on repeat)
 *   within config.SCHEMA_DRIFT_ALERT_DEDUP_WINDOW_MS instead of re-alerting.
 * - Diff summary: a before/after description of the change is attached to
 *   the incident via descriptionOverride so it stays actionable.
 * - Routing: delegates to alertRoutingService, severity-routed via the
 *   seeded "Schema drift (default)" routing rule (source_types:
 *   ["schema_drift"], owner_address: null / global).
 *
 * This function never throws — call sites in the schema drift check run on
 * the hot ingestion path and a failure to alert must not fail the ingest.
 * Errors are logged and reflected in the returned result.
 */
export async function alertOnSchemaDrift(
  incident: DriftIncident
): Promise<SchemaDriftAlertResult> {
  const severity = severityFor(incident);
  const now = new Date();
  const dedupKey = `${incident.sourceName}:${incident.fieldPath}`;

  const event: AlertEvent = {
    eventId: `schema-drift-${dedupKey}-${incident.driftType}`,
    ruleId: `schema-drift-${dedupKey}-${incident.driftType}`,
    assetCode: dedupKey,
    alertType: SOURCE_TYPE,
    priority: severity,
    triggeredValue: incident.isBreaking ? 1 : 0,
    threshold: 0,
    metric: incident.fieldPath,
    webhookDelivered: false,
    onChainEventId: null,
    lifecycleState: "open",
    acknowledgedAt: null,
    acknowledgedBy: null,
    assignedAt: null,
    assignedTo: null,
    closedAt: null,
    closedBy: null,
    closureNote: null,
    updatedAt: now,
    time: now,
  };

  const dedupContext: AlertDeduplicationContext = {
    descriptionOverride: buildDiffSummary(incident),
    recordReference: `schema_baselines:${incident.sourceName}`,
  };

  let incidentRecord: BridgeIncident;

  try {
    incidentRecord = await alertDeduplicationService.deduplicate(
      event,
      dedupContext,
      config.SCHEMA_DRIFT_ALERT_DEDUP_WINDOW_MS
    );
  } catch (error) {
    logger.error(
      { sourceName: incident.sourceName, fieldPath: incident.fieldPath, error },
      "Failed to deduplicate schema drift alert; skipping routing"
    );
    return { alerted: false, severity, reason: "deduplication_failed" };
  }

  try {
    await alertRoutingService.routeAlert({
      eventTime: now,
      alertRuleId: event.ruleId,
      ownerAddress: config.SCHEMA_DRIFT_ALERT_OWNER,
      ruleName: dedupContext.descriptionOverride!,
      assetCode: dedupKey,
      sourceType: SOURCE_TYPE,
      severity,
      triggeredValue: event.triggeredValue,
      threshold: event.threshold,
      metric: incident.fieldPath,
    });
  } catch (error) {
    logger.warn(
      {
        sourceName: incident.sourceName,
        fieldPath: incident.fieldPath,
        incidentId: incidentRecord.id,
        error,
      },
      "Schema drift alert routing dispatch failed"
    );
    return { alerted: true, severity, incident: incidentRecord, reason: "routing_failed" };
  }

  logger.info(
    {
      sourceName: incident.sourceName,
      fieldPath: incident.fieldPath,
      driftType: incident.driftType,
      incidentId: incidentRecord.id,
      severity,
    },
    "Schema drift alert raised"
  );

  return { alerted: true, severity, incident: incidentRecord };
}
