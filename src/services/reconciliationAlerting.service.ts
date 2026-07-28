import { config, getReconciliationAlertThreshold } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { alertRoutingService } from "./alertRouting.service.js";
import { alertDeduplicationService } from "./alertDeduplication.service.js";
import type { AlertDeduplicationContext } from "./alertDeduplication.service.js";
import type { AlertEvent, AlertPriority } from "./alert.service.js";
import type { BridgeIncident } from "./incident.service.js";

export interface ReconciliationMismatchInput {
  assetCode: string;
  runId: string;
  stellarSupply: number | null;
  reportedSupply: number | null;
  mismatchPercentage: number | null;
  /** Optional override; defaults to config.getReconciliationAlertThreshold(assetCode) */
  threshold?: number;
}

export interface ReconciliationAlertResult {
  alerted: boolean;
  threshold: number;
  severity?: AlertPriority;
  incident?: BridgeIncident;
  reason?: string;
}

const SOURCE_TYPE = "reconciliation";
const METRIC = "mismatchPercentage";

/**
 * Maps a mismatch severity to an AlertPriority based on how far past the
 * configured threshold the observed delta is. Only called once we already
 * know the delta exceeds the threshold (ratio >= 1).
 */
function severityForRatio(ratio: number): AlertPriority {
  if (ratio >= 5) return "critical";
  if (ratio >= 2) return "high";
  return "medium";
}

/**
 * Checks a reconciliation mismatch against the configured per-asset/source
 * threshold and, if exceeded, raises a structured, severity-routed,
 * deduplicated alert.
 *
 * - Deduplication: delegates to alertDeduplicationService, which collapses
 *   repeated mismatches for the same asset/source into a single open
 *   bridge_incidents row within its configured window, escalating severity
 *   on repeat rather than creating duplicate incidents.
 * - Routing: delegates to alertRoutingService, which is severity-routed via
 *   the seeded "Reconciliation mismatch (default)" routing rule
 *   (source_types: ["reconciliation"], owner_address: null / global).
 * - Record reference: the incident's sourceExternalId is set to the
 *   reconciliation run id so operators can jump straight to the underlying
 *   record for investigation.
 *
 * This function never throws on routing/dedup failures — a failure to
 * notify must not fail the reconciliation job itself. Errors are logged and
 * reflected in the returned result.
 */
export async function alertOnReconciliationMismatch(
  input: ReconciliationMismatchInput
): Promise<ReconciliationAlertResult> {
  const threshold = input.threshold ?? getReconciliationAlertThreshold(input.assetCode);

  if (
    input.mismatchPercentage === null ||
    input.mismatchPercentage === undefined ||
    input.mismatchPercentage <= threshold
  ) {
    return { alerted: false, threshold, reason: "below_threshold" };
  }

  const ratio = threshold > 0 ? input.mismatchPercentage / threshold : Infinity;
  const severity = severityForRatio(ratio);
  const now = new Date();

  const event: AlertEvent = {
    eventId: `reconciliation-${input.runId}`,
    ruleId: `reconciliation-${input.runId}`,
    assetCode: input.assetCode,
    alertType: "supply_mismatch",
    priority: severity,
    triggeredValue: input.mismatchPercentage,
    threshold,
    metric: METRIC,
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

  const delta =
    input.stellarSupply !== null &&
    input.stellarSupply !== undefined &&
    input.reportedSupply !== null &&
    input.reportedSupply !== undefined
      ? input.stellarSupply - input.reportedSupply
      : null;

  const dedupContext: AlertDeduplicationContext = {
    recordReference: `reconciliation_runs:${input.runId}`,
    sourceAValue: input.stellarSupply,
    sourceBValue: input.reportedSupply,
    sourceALabel: "Stellar supply",
    sourceBLabel: "Reported supply",
    delta,
  };

  let incident: BridgeIncident | undefined;

  try {
    incident = await alertDeduplicationService.deduplicate(event, dedupContext);
  } catch (error) {
    logger.error(
      { assetCode: input.assetCode, runId: input.runId, error },
      "Failed to deduplicate reconciliation alert; skipping routing"
    );
    return { alerted: false, threshold, severity, reason: "deduplication_failed" };
  }

  try {
    await alertRoutingService.routeAlert({
      eventTime: now,
      alertRuleId: event.ruleId,
      ownerAddress: config.RECONCILIATION_ALERT_OWNER,
      ruleName: "Reconciliation mismatch",
      assetCode: input.assetCode,
      sourceType: SOURCE_TYPE,
      severity,
      triggeredValue: input.mismatchPercentage,
      threshold,
      metric: METRIC,
    });
  } catch (error) {
    logger.warn(
      { assetCode: input.assetCode, runId: input.runId, incidentId: incident.id, error },
      "Reconciliation alert routing dispatch failed"
    );
    return { alerted: true, threshold, severity, incident, reason: "routing_failed" };
  }

  logger.info(
    {
      assetCode: input.assetCode,
      runId: input.runId,
      incidentId: incident.id,
      severity,
      mismatchPercentage: input.mismatchPercentage,
      threshold,
    },
    "Reconciliation mismatch alert raised"
  );

  return { alerted: true, threshold, severity, incident };
}