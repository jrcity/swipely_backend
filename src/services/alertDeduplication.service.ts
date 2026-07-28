import { getDatabase } from "../database/connection.js";
import { logger } from "../utils/logger.js";
import { IncidentService } from "./incident.service.js";
import type { AlertEvent, AlertPriority, AlertType } from "./alert.service.js";
import type { BridgeIncident } from "./incident.service.js";

/**
 * Configuration for deduplication.
 * - windowMs: time window within which alerts are considered duplicates.
 * - severityOrder: defines escalation hierarchy.
 */
const DEDUP_CONFIG = {
  windowMs: 10 * 60 * 1000, // 10 minutes
  severityOrder: ["low", "medium", "high", "critical"] as AlertPriority[],
};

/**
 * Optional extra context a producer can supply so the resulting incident
 * carries enough detail to act on without re-deriving it (e.g. both
 * compared values and a reference to the underlying record). When omitted,
 * deduplicate() falls back to its original triggeredValue/threshold-only
 * description, so this is fully backward compatible with existing callers.
 */
export interface AlertDeduplicationContext {
  /** Human/URL reference to the underlying record for investigation. */
  recordReference?: string;
  /** First compared value (e.g. on-chain/Stellar supply). */
  sourceAValue?: number | null;
  /** Second compared value (e.g. reported/reserve supply). */
  sourceBValue?: number | null;
  /** Labels for the two compared sources, used only for description text. */
  sourceALabel?: string;
  sourceBLabel?: string;
  /** Absolute delta between the two compared values, if known. */
  delta?: number | null;
  /**
   * Fully-formed description text supplied by the producer (e.g. a diff
   * summary), used verbatim instead of the triggeredValue/threshold or
   * sourceA/sourceB template below. Optional; existing callers that rely on
   * the generated description are unaffected.
   */
  descriptionOverride?: string;
}

export class AlertDeduplicationService {
  private static instance: AlertDeduplicationService;
  private incidentService = new IncidentService();

  private constructor() {}

  public static getInstance(): AlertDeduplicationService {
    if (!AlertDeduplicationService.instance) {
      AlertDeduplicationService.instance = new AlertDeduplicationService();
    }
    return AlertDeduplicationService.instance;
  }

  /**
   * Find an open incident that matches the alert within the deduplication window.
   */
  private async findMatchingIncident(
    event: AlertEvent,
    windowMs: number = DEDUP_CONFIG.windowMs
  ): Promise<BridgeIncident | null> {
    const db = getDatabase();
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    // Simple matching on assetCode, alertType and open status.
    const row = await db("bridge_incidents")
      .where({ asset_code: event.assetCode, status: "open" })
      .andWhere((qb: any) => {
        qb.where("source_type", event.alertType).orWhere("source_type", null);
      })
      .andWhere("created_at", ">=", windowStart)
      .orderBy("created_at", "desc")
      .first();

    return row ? this.incidentService.mapDatabaseRow(row) : null;
  }

  /**
   * Merge the alert into an existing incident or create a new one.
   *
   * @param context optional extra detail (source values, delta, record
   * reference) used to build a richer incident description and
   * sourceExternalId. Safe to omit; existing callers are unaffected.
   * @param windowMs optional override for the deduplication window, in
   * milliseconds. Defaults to DEDUP_CONFIG.windowMs when omitted, so
   * existing callers are unaffected.
   */
  public async deduplicate(
    event: AlertEvent,
    context?: AlertDeduplicationContext,
    windowMs?: number
  ): Promise<BridgeIncident> {
    const matching = await this.findMatchingIncident(event, windowMs);
    if (matching) {
      // Escalate severity if needed.
      const newSeverity = this.escalateSeverity(matching.severity, event.priority);
      if (newSeverity !== matching.severity) {
        await this.incidentService.updateIncidentSeverity(matching.id, newSeverity as any);
        await this.incidentService.updateIncidentStatus(matching.id, "investigating");
      }
      logger.info({ incidentId: matching.id, alertId: event.eventId }, "Alert deduplicated into existing incident");
      return matching;
    }

    // No matching incident – create a new one.
    const description = this.buildDescription(event, context);

    const payload = {
      bridgeId: `bridge-${event.assetCode.toLowerCase()}`,
      assetCode: event.assetCode,
      severity: event.priority as any, // map priority to severity directly.
      title: `Alert: ${event.alertType} on ${event.assetCode}`,
      description,
      sourceUrl: null,
      sourceType: event.alertType,
      sourceExternalId: context?.recordReference ?? null,
      sourceRepository: null,
      sourceRepoAvatarUrl: null,
      sourceActor: null,
      sourceAttribution: {},
      followUpActions: [],
      occurredAt: event.time.toISOString(),
    };
    const incident = await this.incidentService.createIncident(payload);
    logger.info({ incidentId: incident.id }, "New incident created for deduplicated alert");
    return incident;
  }

  private buildDescription(event: AlertEvent, context?: AlertDeduplicationContext): string {
    if (!context) {
      return `Triggered value ${event.triggeredValue} exceeded threshold ${event.threshold}`;
    }

    if (context.descriptionOverride) {
      return context.descriptionOverride;
    }

    const parts = [`Triggered value ${event.triggeredValue} exceeded threshold ${event.threshold}`];

    if (context.sourceAValue !== undefined || context.sourceBValue !== undefined) {
      const labelA = context.sourceALabel ?? "Source A";
      const labelB = context.sourceBLabel ?? "Source B";
      parts.push(`${labelA}: ${context.sourceAValue ?? "n/a"}, ${labelB}: ${context.sourceBValue ?? "n/a"}`);
    }

    if (context.delta !== undefined && context.delta !== null) {
      parts.push(`Delta: ${context.delta}`);
    }

    if (context.recordReference) {
      parts.push(`Record: ${context.recordReference}`);
    }

    return parts.join(" | ");
  }

  /**
   * Determine the higher severity between current incident severity and incoming alert priority.
   */
  private escalateSeverity(current: string, incomingPriority: AlertPriority): string {
    const order = DEDUP_CONFIG.severityOrder;
    const curIdx = order.indexOf(current as any);
    const incIdx = order.indexOf(incomingPriority);
    return incIdx > curIdx ? incomingPriority : current;
  }
}

export const alertDeduplicationService = AlertDeduplicationService.getInstance();