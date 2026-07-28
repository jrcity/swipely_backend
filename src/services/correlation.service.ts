import { getDatabase } from "../database/connection.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

export interface CorrelationSuggestion {
  incidentId: string;
  score: number;
  reasons: string[];
}

export class CorrelationService {
  private db = getDatabase();
  private threshold: number;

  constructor() {
    // configurable via CORRELATION_THRESHOLD env var (0–1)
    this.threshold = config.CORRELATION_THRESHOLD;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[\W_]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  private jaccard(a: string[], b: string[]): number {
    const sa = new Set(a);
    const sb = new Set(b);
    const inter = new Set([...sa].filter((x) => sb.has(x)));
    const union = new Set([...sa, ...sb]);
    if (union.size === 0) return 0;
    return inter.size / union.size;
  }

  /**
   * Score similarity between two incident rows
   */
  scoreSimilarity(a: any, b: any): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    // exact normalized fingerprint match => very high
    if (a.normalized_fingerprint && b.normalized_fingerprint && a.normalized_fingerprint === b.normalized_fingerprint) {
      score += 0.6;
      reasons.push("normalized_fingerprint");
    }

    // bridge id and asset code match
    if (a.bridge_id && b.bridge_id && a.bridge_id === b.bridge_id) {
      score += 0.15;
      reasons.push("bridge_id");
    }
    if ((a.asset_code || null) && (b.asset_code || null) && a.asset_code === b.asset_code) {
      score += 0.05;
      reasons.push("asset_code");
    }

    // severity match
    if (a.severity && b.severity && a.severity === b.severity) {
      score += 0.03;
      reasons.push("severity");
    }

    // timestamp overlap: within 1 hour
    try {
      const ta = new Date(a.occurred_at).getTime();
      const tb = new Date(b.occurred_at).getTime();
      const delta = Math.abs(ta - tb);
      if (!Number.isNaN(delta) && delta <= 1000 * 60 * 60) {
        score += 0.07;
        reasons.push("time_window_1h");
      }
    } catch (e) {
      // ignore
    }

    // textual similarity on title+description
    const textA = `${a.title || ""} ${a.description || ""}`;
    const textB = `${b.title || ""} ${b.description || ""}`;
    const tokensA = this.tokenize(textA).slice(0, 50);
    const tokensB = this.tokenize(textB).slice(0, 50);
    const j = this.jaccard(tokensA, tokensB);
    // scale j to max 0.2
    score += Math.min(0.2, j * 0.2);
    if (j > 0.2) reasons.push("text_similarity");

    return { score: Math.min(1, score), reasons };
  }

  /**
   * Suggest correlations for a given incident id
   */
  async suggestForIncident(incidentId: string, lookbackHours = 24): Promise<CorrelationSuggestion[]> {
    // fetch incident
    const incident = await this.db("bridge_incidents").where("id", incidentId).first();
    if (!incident) return [];

    // fetch recent incidents in lookback window
    const since = new Date(Date.now() - lookbackHours * 3600 * 1000);
    const candidates = await this.db("bridge_incidents")
      .whereNot("id", incidentId)
      .andWhere("created_at", ">=", since)
      .orderBy("occurred_at", "desc")
      .limit(200)
      .select("*");

    const suggestions: CorrelationSuggestion[] = [];
    for (const cand of candidates) {
      const { score, reasons } = this.scoreSimilarity(incident, cand);
      if (score >= this.threshold) {
        suggestions.push({ incidentId: cand.id, score, reasons });
        // record audit "suggested"
        try {
          await this.db("incident_correlation_audit").insert({
            action: "suggested",
            incident_id: incidentId,
            target_incident_id: cand.id,
            actor: "system",
            metadata: JSON.stringify({ score, reasons }),
          });
        } catch (e) {
          logger.warn({ error: e }, "Failed to write correlation suggestion audit");
        }
      }
    }

    // sort by score desc
    suggestions.sort((a, b) => b.score - a.score);
    return suggestions;
  }

  async linkIncidents(incidentId: string, targetIncidentId: string, actor = "user") {
    // find existing group containing either incident
    const groupRow = await this.db.raw(
      `select g.id from incident_correlation_groups g
       join incident_correlation_members m on m.group_id = g.id
       where m.incident_id in (?, ?) limit 1`,
      [incidentId, targetIncidentId]
    );

    let groupId: string | null = null;
    if (groupRow && groupRow.rows && groupRow.rows[0]) {
      groupId = groupRow.rows[0].id;
    }

    const trx = await this.db.transaction();
    try {
      if (!groupId) {
        const [g] = await trx("incident_correlation_groups").insert({ created_by: actor }).returning("id");
        groupId = g.id || g;
      }

      // insert members if not present
      await trx("incident_correlation_members").insert({ group_id: groupId, incident_id: incidentId, linked_by: actor }).onConflict(["incident_id"]).ignore();
      await trx("incident_correlation_members").insert({ group_id: groupId, incident_id: targetIncidentId, linked_by: actor }).onConflict(["incident_id"]).ignore();

      // audit
      await trx("incident_correlation_audit").insert({ action: "linked", group_id: groupId, incident_id: incidentId, target_incident_id: targetIncidentId, actor, metadata: JSON.stringify({}) });
      await trx.commit();
      return { groupId };
    } catch (e) {
      await trx.rollback();
      throw e;
    }
  }

  async unlinkIncidents(incidentId: string, targetIncidentId: string, actor = "user") {
    // find common group
    const row = await this.db("incident_correlation_members as m1")
      .join("incident_correlation_members as m2", "m1.group_id", "m2.group_id")
      .select("m1.group_id")
      .where("m1.incident_id", incidentId)
      .andWhere("m2.incident_id", targetIncidentId)
      .first();

    if (!row) return { ok: false };
    const groupId = row.group_id as string;
    const trx = await this.db.transaction();
    try {
      await trx("incident_correlation_members").where({ group_id: groupId, incident_id: targetIncidentId }).del();
      await trx("incident_correlation_audit").insert({ action: "unlinked", group_id: groupId, incident_id: incidentId, target_incident_id: targetIncidentId, actor, metadata: JSON.stringify({}) });

      // if group has fewer than 2 members, delete group
      const countRow = await trx("incident_correlation_members")
        .where({ group_id: groupId })
        .count<{ count: string }>("id as count")
        .first();
      if (Number(countRow?.count ?? 0) < 2) {
        await trx("incident_correlation_members").where({ group_id: groupId }).del();
        await trx("incident_correlation_groups").where({ id: groupId }).del();
      }

      await trx.commit();
      return { ok: true };
    } catch (e) {
      await trx.rollback();
      throw e;
    }
  }

  async approveSuggestion(incidentId: string, targetIncidentId: string, actor = "user") {
    const res = await this.linkIncidents(incidentId, targetIncidentId, actor);
    // record approved audit
    try {
      await this.db("incident_correlation_audit").insert({ action: "approved", group_id: res.groupId, incident_id: incidentId, target_incident_id: targetIncidentId, actor, metadata: JSON.stringify({}) });
    } catch (e) {
      logger.warn({ error: e }, "Failed to write correlation approve audit");
    }
    return res;
  }

  async getGroupForIncident(incidentId: string) {
    const row = await this.db("incident_correlation_members as m").join("incident_correlation_groups as g", "m.group_id", "g.id").select("g.*").where("m.incident_id", incidentId).first();
    return row || null;
  }

  async listGroupMembers(groupId: string) {
    return this.db("incident_correlation_members").where({ group_id: groupId }).select("incident_id", "linked_by", "linked_at");
  }
}

let instance: CorrelationService | null = null;
export function getCorrelationService() {
  if (!instance) instance = new CorrelationService();
  return instance;
}
