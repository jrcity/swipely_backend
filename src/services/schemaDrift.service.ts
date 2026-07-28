import { getDatabase } from "../database/connection.js";
import { createChildLogger } from "../utils/logger.js";
import { AlertService } from "./alert.service.js";
import { alertOnSchemaDrift } from "./schemaDriftAlerting.service.js";

const logger = createChildLogger("schema-drift");

export type DriftType = "ADDITION" | "REMOVAL" | "TYPE_CHANGE";

export interface DriftIncident {
  sourceName: string;
  driftType: DriftType;
  fieldPath: string;
  expectedType?: string;
  actualType?: string;
  isBreaking: boolean;
  rawPayloadSample?: any;
}

export interface DriftReport {
  sourceName: string;
  hasDrift: boolean;
  incidents: DriftIncident[];
  detectedAt: Date;
}

export class SchemaDriftService {
  private alertService: AlertService;

  constructor(alertService?: AlertService) {
    this.alertService = alertService || new AlertService();
  }

  /**
   * Checks for schema drift in a payload against a baseline.
   * If no baseline exists, it creates one.
   */
  async checkDrift(sourceName: string, payload: any): Promise<DriftReport> {
    const startTime = Date.now();
    const currentSchema = this.extractSchema(payload);
    const baseline = await this.getBaseline(sourceName);

    if (!baseline) {
      logger.info({ sourceName }, "No baseline found, creating new baseline");
      await this.saveBaseline(sourceName, currentSchema);
      return {
        sourceName,
        hasDrift: false,
        incidents: [],
        detectedAt: new Date(),
      };
    }

    const incidents = this.compareSchemas(sourceName, baseline, currentSchema, payload);
    const hasDrift = incidents.length > 0;

    if (hasDrift) {
      logger.warn({ sourceName, incidentCount: incidents.length }, "Schema drift detected");
      await this.recordIncidents(incidents);
      await this.triggerAlerts(sourceName, incidents);
    }

    const duration = Date.now() - startTime;
    logger.debug({ sourceName, duration, hasDrift }, "Schema drift check completed");

    return {
      sourceName,
      hasDrift,
      incidents,
      detectedAt: new Date(),
    };
  }

  /**
   * Recursively extracts schema from a JSON object.
   */
  private extractSchema(data: any, prefix = ""): Record<string, string> {
    const schema: Record<string, string> = {};
    
    if (data === null) {
      schema[prefix || "root"] = "null";
    } else if (Array.isArray(data)) {
      schema[prefix || "root"] = "array";
      if (data.length > 0) {
        // For arrays, we check the first element as a representative schema
        Object.assign(schema, this.extractSchema(data[0], `${prefix}[]`));
      }
    } else if (typeof data === "object") {
      schema[prefix || "root"] = "object";
      for (const [key, value] of Object.entries(data)) {
        const path = prefix ? `${prefix}.${key}` : key;
        Object.assign(schema, this.extractSchema(value, path));
      }
    } else {
      schema[prefix || "root"] = typeof data;
    }
    
    return schema;
  }

  /**
   * Compares two schemas and returns a list of drift incidents.
   */
  private compareSchemas(
    sourceName: string,
    baseline: Record<string, string>,
    current: Record<string, string>,
    payload: any
  ): DriftIncident[] {
    const incidents: DriftIncident[] = [];

    // Check for removals and type changes
    for (const [path, expectedType] of Object.entries(baseline)) {
      const actualType = current[path];

      if (actualType === undefined) {
        incidents.push({
          sourceName,
          driftType: "REMOVAL",
          fieldPath: path,
          expectedType,
          isBreaking: true, // Removals are usually breaking
          rawPayloadSample: payload,
        });
      } else if (actualType !== expectedType && expectedType !== "null" && actualType !== "null") {
        incidents.push({
          sourceName,
          driftType: "TYPE_CHANGE",
          fieldPath: path,
          expectedType,
          actualType,
          isBreaking: true, // Type changes are breaking
          rawPayloadSample: payload,
        });
      }
    }

    // Check for additions
    for (const [path, actualType] of Object.entries(current)) {
      if (baseline[path] === undefined) {
        incidents.push({
          sourceName,
          driftType: "ADDITION",
          fieldPath: path,
          actualType,
          isBreaking: false, // Additions are usually non-breaking
          rawPayloadSample: payload,
        });
      }
    }

    return incidents;
  }

  private async getBaseline(sourceName: string): Promise<Record<string, string> | null> {
    const db = getDatabase();
    const row = await db("schema_baselines").where({ source_name: sourceName }).first();
    return row ? row.schema_definition : null;
  }

  private async saveBaseline(sourceName: string, schema: Record<string, string>): Promise<void> {
    const db = getDatabase();
    await db("schema_baselines")
      .insert({
        source_name: sourceName,
        schema_definition: JSON.stringify(schema),
      })
      .onConflict("source_name")
      .merge({
        schema_definition: JSON.stringify(schema),
        version: db.raw("version + 1"),
        updated_at: db.fn.now(),
      });
  }

  private async recordIncidents(incidents: DriftIncident[]): Promise<void> {
    const db = getDatabase();
    const records = incidents.map((i) => ({
      source_name: i.sourceName,
      drift_type: i.driftType,
      field_path: i.fieldPath,
      expected_type: i.expectedType || null,
      actual_type: i.actualType || null,
      is_breaking: i.isBreaking,
      raw_payload_sample: JSON.stringify(i.rawPayloadSample),
    }));

    await db("schema_drift_incidents").insert(records);
  }

  private async triggerAlerts(sourceName: string, incidents: DriftIncident[]): Promise<void> {
    const breakingCount = incidents.filter((i) => i.isBreaking).length;
    const nonBreakingCount = incidents.length - breakingCount;

    if (breakingCount > 0) {
      logger.error(
        { sourceName, breakingCount },
        "CRITICAL: Breaking schema drift detected in upstream payload"
      );
    }

    if (nonBreakingCount > 0) {
      logger.warn(
        { sourceName, nonBreakingCount },
        "Warning: Non-breaking schema additions detected in upstream payload"
      );
    }

    await Promise.all(
      incidents.map((incident) =>
        alertOnSchemaDrift(incident).catch((err) =>
          logger.error(
            { sourceName, fieldPath: incident.fieldPath, err },
            "Failed to raise schema drift alert"
          )
        )
      )
    );
  }

  /**
   * Generates a summary report of all drifts.
   */
  async getDriftReport(): Promise<any> {
    const db = getDatabase();
    const summary = await db("schema_drift_incidents")
      .select("source_name")
      .count("* as incident_count")
      .max("detected_at as last_detected")
      .groupBy("source_name");

    const recentIncidents = await db("schema_drift_incidents")
      .orderBy("detected_at", "desc")
      .limit(20);

    return {
      summary,
      recentIncidents,
    };
  }
}

export const schemaDriftService = new SchemaDriftService();
