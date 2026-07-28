import crypto from "crypto";
import { logger } from "../utils/logger.js";
import type { AlertEvent, AlertEventInput, AlertPriority, AlertType } from "./alert.service.js";

export interface DedupRule {
  id: string;
  name: string;
  alertType: AlertType | "*";
  assetCode: string | "*";
  windowMs: number;
  matchFields: Array<"assetCode" | "alertType" | "metric" | "source">;
  /** block = drop silently; escalate = allow but upgrade severity; review = queue for manual review */
  severityBehavior: "block" | "escalate" | "review";
  isActive: boolean;
  createdAt: Date;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  action: "allow" | "block" | "escalate" | "review";
  matchedEventId?: string;
  matchedRule?: DedupRule;
  escalatedPriority?: AlertPriority;
  reason?: string;
}

export interface ReviewQueueEntry {
  id: string;
  incomingEvent: AlertEventInput;
  matchedEventId: string;
  matchScore: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
}

const SEVERITY_ORDER: AlertPriority[] = ["low", "medium", "high", "critical"];

const DEFAULT_DEDUP_RULES: DedupRule[] = [
  {
    id: "default-exact",
    name: "Exact duplicate (same asset + type within 10 min)",
    alertType: "*",
    assetCode: "*",
    windowMs: 10 * 60 * 1000,
    matchFields: ["assetCode", "alertType", "metric"],
    severityBehavior: "block",
    isActive: true,
    createdAt: new Date(),
  },
  {
    id: "default-cross-source",
    name: "Cross-source duplicate (same asset + metric within 5 min)",
    alertType: "*",
    assetCode: "*",
    windowMs: 5 * 60 * 1000,
    matchFields: ["assetCode", "metric"],
    severityBehavior: "review",
    isActive: true,
    createdAt: new Date(),
  },
  {
    id: "default-critical-escalate",
    name: "Critical severity re-trigger escalation within 30 min",
    alertType: "*",
    assetCode: "*",
    windowMs: 30 * 60 * 1000,
    matchFields: ["assetCode", "alertType"],
    severityBehavior: "escalate",
    isActive: true,
    createdAt: new Date(),
  },
];

export class DuplicateAlertCheckService {
  private static instance: DuplicateAlertCheckService;

  private rules: Map<string, DedupRule> = new Map(
    DEFAULT_DEDUP_RULES.map((r) => [r.id, r])
  );

  // In-memory ring buffer keyed by fingerprint -> { eventId, time, priority }
  private recentEvents: Map<string, { eventId: string; time: Date; priority: AlertPriority }> =
    new Map();

  private reviewQueue: ReviewQueueEntry[] = [];

  private constructor() {}

  public static getInstance(): DuplicateAlertCheckService {
    if (!DuplicateAlertCheckService.instance) {
      DuplicateAlertCheckService.instance = new DuplicateAlertCheckService();
    }
    return DuplicateAlertCheckService.instance;
  }

  /**
   * Check an incoming alert event for duplicates before it is persisted or dispatched.
   * Returns the action to take and any escalation details.
   */
  public check(event: AlertEventInput): DuplicateCheckResult {
    this.evict();

    const activeRules = [...this.rules.values()]
      .filter((r) => r.isActive)
      .filter(
        (r) =>
          (r.alertType === "*" || r.alertType === event.alertType) &&
          (r.assetCode === "*" || r.assetCode === event.assetCode)
      );

    for (const rule of activeRules) {
      const fp = this.fingerprint(event, rule.matchFields);
      const recent = this.recentEvents.get(fp);
      if (!recent) continue;

      const age = Date.now() - recent.time.getTime();
      if (age > rule.windowMs) continue;

      // Found a duplicate within the window.
      if (rule.severityBehavior === "block") {
        logger.debug(
          { matchedEventId: recent.eventId, ruleId: rule.id, age },
          "Duplicate alert blocked"
        );
        return {
          isDuplicate: true,
          action: "block",
          matchedEventId: recent.eventId,
          matchedRule: rule,
          reason: `Matched rule "${rule.name}" (age ${Math.round(age / 1000)}s)`,
        };
      }

      if (rule.severityBehavior === "escalate") {
        const escalated = this.escalate(recent.priority, event.priority);
        logger.debug(
          { matchedEventId: recent.eventId, ruleId: rule.id, escalated },
          "Duplicate alert escalated"
        );
        return {
          isDuplicate: true,
          action: "escalate",
          matchedEventId: recent.eventId,
          matchedRule: rule,
          escalatedPriority: escalated,
          reason: `Severity escalated by rule "${rule.name}"`,
        };
      }

      if (rule.severityBehavior === "review") {
        const score = this.matchScore(event, recent.priority);
        this.enqueueReview(event, recent.eventId, score, rule.name);
        logger.debug(
          { matchedEventId: recent.eventId, ruleId: rule.id, score },
          "Duplicate alert queued for review"
        );
        return {
          isDuplicate: true,
          action: "review",
          matchedEventId: recent.eventId,
          matchedRule: rule,
          reason: `Queued for review by rule "${rule.name}" (score ${score.toFixed(2)})`,
        };
      }
    }

    return { isDuplicate: false, action: "allow" };
  }

  /**
   * Record a newly persisted event so future alerts can be matched against it.
   */
  public record(event: AlertEvent): void {
    // Record under every active rule's fingerprint.
    for (const rule of this.rules.values()) {
      if (!rule.isActive) continue;
      if (rule.alertType !== "*" && rule.alertType !== event.alertType) continue;
      if (rule.assetCode !== "*" && rule.assetCode !== event.assetCode) continue;
      const fp = this.fingerprint(event, rule.matchFields);
      this.recentEvents.set(fp, { eventId: event.eventId, time: event.time, priority: event.priority });
    }
  }

  // ---------------------------------------------------------------------------
  // Dedup rule management
  // ---------------------------------------------------------------------------

  public getDedupRules(): DedupRule[] {
    return [...this.rules.values()];
  }

  public getDedupRule(id: string): DedupRule | undefined {
    return this.rules.get(id);
  }

  public addDedupRule(
    rule: Omit<DedupRule, "id" | "createdAt">
  ): DedupRule {
    const newRule: DedupRule = {
      ...rule,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };
    this.rules.set(newRule.id, newRule);
    logger.info({ ruleId: newRule.id, name: newRule.name }, "Dedup rule added");
    return newRule;
  }

  public updateDedupRule(
    id: string,
    updates: Partial<Omit<DedupRule, "id" | "createdAt">>
  ): DedupRule | null {
    const existing = this.rules.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates };
    this.rules.set(id, updated);
    logger.info({ ruleId: id }, "Dedup rule updated");
    return updated;
  }

  public deleteDedupRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) logger.info({ ruleId: id }, "Dedup rule deleted");
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Review queue management
  // ---------------------------------------------------------------------------

  public getReviewQueue(status?: ReviewQueueEntry["status"]): ReviewQueueEntry[] {
    return status ? this.reviewQueue.filter((e) => e.status === status) : [...this.reviewQueue];
  }

  public reviewEntry(
    entryId: string,
    action: "approved" | "rejected",
    reviewedBy: string
  ): ReviewQueueEntry | null {
    const entry = this.reviewQueue.find((e) => e.id === entryId);
    if (!entry || entry.status !== "pending") return null;
    entry.status = action;
    entry.reviewedAt = new Date();
    entry.reviewedBy = reviewedBy;
    logger.info({ entryId, action, reviewedBy }, "Review queue entry resolved");
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private fingerprint(
    event: AlertEventInput,
    fields: DedupRule["matchFields"]
  ): string {
    const parts: string[] = [];
    for (const f of fields) {
      if (f === "assetCode") parts.push(event.assetCode);
      else if (f === "alertType") parts.push(event.alertType);
      else if (f === "metric") parts.push(event.metric);
      else if (f === "source") parts.push(event.alertType); // source maps to alertType here
    }
    return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
  }

  private escalate(current: AlertPriority, incoming: AlertPriority): AlertPriority {
    const ci = SEVERITY_ORDER.indexOf(current);
    const ii = SEVERITY_ORDER.indexOf(incoming);
    return ii > ci ? incoming : current;
  }

  private matchScore(
    event: AlertEventInput,
    existingPriority: AlertPriority
  ): number {
    let score = 0.5;
    const si = SEVERITY_ORDER.indexOf(event.priority);
    const ei = SEVERITY_ORDER.indexOf(existingPriority);
    if (si === ei) score += 0.3;
    else if (Math.abs(si - ei) === 1) score += 0.1;
    return Math.min(score, 1.0);
  }

  /** Remove records older than the longest active window to prevent unbounded growth. */
  private evict(): void {
    const maxWindow = Math.max(
      ...([...this.rules.values()]
        .filter((r) => r.isActive)
        .map((r) => r.windowMs)),
      0
    );
    if (maxWindow === 0) return;
    const cutoff = Date.now() - maxWindow;
    for (const [fp, rec] of this.recentEvents) {
      if (rec.time.getTime() < cutoff) this.recentEvents.delete(fp);
    }
  }

  private enqueueReview(
    event: AlertEventInput,
    matchedEventId: string,
    matchScore: number,
    reason: string
  ): void {
    this.reviewQueue.push({
      id: crypto.randomUUID(),
      incomingEvent: event,
      matchedEventId,
      matchScore,
      reason,
      status: "pending",
      createdAt: new Date(),
    });
  }
}

export const duplicateAlertCheckService = DuplicateAlertCheckService.getInstance();
