/**
 * Configuration Management Service
 * Centralized configuration management with environment-based settings,
 * feature flags, secrets management, and dynamic updates.
 */

import { z } from "zod";
import { getDatabase } from "../database/connection";
import { logger } from "../utils/logger";
import { config } from "../config/index";
import { featureFlagAuditService } from "./featureFlagAudit.service";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";

// ─── Configuration Schema ────────────────────────────────────────────────────

const ConfigValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.unknown()),
  z.array(z.unknown()),
]);

export type ConfigValue = z.infer<typeof ConfigValueSchema>;

export interface ConfigEntry {
  id: string;
  key: string;
  value: ConfigValue;
  environment: string;
  is_sensitive: boolean;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface FeatureFlag {
  id: string;
  name: string;
  enabled: boolean;
  environment: string;
  rollout_percentage: number;
  conditions: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ConfigAuditLog {
  id: string;
  config_key: string;
  action: "create" | "update" | "delete";
  old_value: ConfigValue | null;
  new_value: ConfigValue | null;
  changed_by: string;
  timestamp: Date;
}

// ─── Encryption Utilities ────────────────────────────────────────────────────

// Use the validated env config so the key is always properly set.
// Falls back to a clearly insecure default only in non-production environments.
const ENCRYPTION_KEY =
  config.CONFIG_ENCRYPTION_KEY ?? "default-key-change-in-production-32b";
const ALGORITHM = "aes-256-cbc";

function encrypt(text: string): string {
  const iv = randomBytes(16);
  const key = createHash("sha256").update(ENCRYPTION_KEY).digest();
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

function decrypt(encryptedText: string): string {
  const [ivHex, encrypted] = encryptedText.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const key = createHash("sha256").update(ENCRYPTION_KEY).digest();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ─── Configuration Service ───────────────────────────────────────────────────

export class ConfigService {
  private cache: Map<string, ConfigEntry> = new Map();
  private featureFlagCache: Map<string, FeatureFlag> = new Map();
  private environment: string;

  constructor(environment: string = config.NODE_ENV) {
    this.environment = environment;
  }

  /**
   * Get configuration value with environment hierarchy
   * Priority: specific environment > default > fallback
   */
  async get<T = ConfigValue>(
    key: string,
    fallback?: T,
  ): Promise<T | undefined> {
    try {
      // Check cache first
      const cacheKey = `${this.environment}:${key}`;
      if (this.cache.has(cacheKey)) {
        const entry = this.cache.get(cacheKey)!;
        return this.decryptIfNeeded(entry) as T;
      }

      const db = getDatabase();

      // Try environment-specific config first
      let result = await db("config_entries")
        .where({ key, environment: this.environment })
        .first();

      // Fall back to default environment
      if (!result) {
        result = await db("config_entries")
          .where({ key, environment: "default" })
          .first();
      }

      if (result) {
        this.cache.set(cacheKey, result);
        return this.decryptIfNeeded(result) as T;
      }

      return fallback;
    } catch (error) {
      logger.error({ error, key }, "Failed to get config");
      return fallback;
    }
  }

  /**
   * Set configuration value
   */
  async set(
    key: string,
    value: ConfigValue,
    options: {
      environment?: string;
      isSensitive?: boolean;
      createdBy: string;
    },
  ): Promise<void> {
    const db = getDatabase();
    const env = options.environment || this.environment;

    try {
      // Get existing config for audit
      const existing = await db("config_entries")
        .where({ key, environment: env })
        .first();

      const valueToStore = options.isSensitive
        ? encrypt(JSON.stringify(value))
        : value;

      if (existing) {
        // Update existing
        await db("config_entries")
          .where({ key, environment: env })
          .update({
            value: JSON.stringify(valueToStore),
            is_sensitive: options.isSensitive || false,
            version: existing.version + 1,
            updated_at: new Date(),
          });

        // Audit log
        await this.logChange(
          key,
          "update",
          existing.value,
          value,
          options.createdBy,
        );
      } else {
        // Create new
        await db("config_entries").insert({
          id: randomBytes(16).toString("hex"),
          key,
          value: JSON.stringify(valueToStore),
          environment: env,
          is_sensitive: options.isSensitive || false,
          version: 1,
          created_by: options.createdBy,
          created_at: new Date(),
          updated_at: new Date(),
        });

        // Audit log
        await this.logChange(key, "create", null, value, options.createdBy);
      }

      // Invalidate cache
      this.cache.delete(`${env}:${key}`);

      logger.info({ key, environment: env }, "Config updated");
    } catch (error) {
      logger.error({ error, key }, "Failed to set config");
      throw error;
    }
  }

  /**
   * Delete configuration
   */
  async delete(
    key: string,
    deletedBy: string,
    environment?: string,
  ): Promise<void> {
    const db = getDatabase();
    const env = environment || this.environment;

    try {
      const existing = await db("config_entries")
        .where({ key, environment: env })
        .first();

      if (existing) {
        await db("config_entries").where({ key, environment: env }).delete();

        await this.logChange(key, "delete", existing.value, null, deletedBy);
        this.cache.delete(`${env}:${key}`);

        logger.info({ key, environment: env }, "Config deleted");
      }
    } catch (error) {
      logger.error({ error, key }, "Failed to delete config");
      throw error;
    }
  }

  /**
   * Get all configurations for an environment
   */
  async getAll(environment?: string): Promise<ConfigEntry[]> {
    const db = getDatabase();
    const env = environment || this.environment;

    try {
      const configs = await db("config_entries")
        .where({ environment: env })
        .orderBy("key");

      return configs.map((config: ConfigEntry) => ({
        ...config,
        value: this.decryptIfNeeded(config),
      }));
    } catch (error) {
      logger.error({ error }, "Failed to get all configs");
      return [];
    }
  }

  /**
   * Check if feature flag is enabled
   */
  async isFeatureEnabled(
    featureName: string,
    context?: { userId?: string; percentage?: number },
  ): Promise<boolean> {
    try {
      const cacheKey = `${this.environment}:${featureName}`;

      let flag = this.featureFlagCache.get(cacheKey);

      if (!flag) {
        const db = getDatabase();
        flag = await db("feature_flags")
          .where({ name: featureName, environment: this.environment })
          .first();

        if (flag) {
          this.featureFlagCache.set(cacheKey, flag);
        }
      }

      if (!flag) {
        return false;
      }

      if (!flag.enabled) {
        return false;
      }

      // Rollout percentage check
      if (flag.rollout_percentage < 100 && context?.userId) {
        const hash = createHash("md5")
          .update(context.userId + featureName)
          .digest("hex");
        const userPercentage = parseInt(hash.substring(0, 8), 16) % 100;
        return userPercentage < flag.rollout_percentage;
      }

      return true;
    } catch (error) {
      logger.error({ error, featureName }, "Failed to check feature flag");
      return false;
    }
  }

  /**
   * Set feature flag
   */
  async setFeatureFlag(
    name: string,
    enabled: boolean,
    options?: {
      environment?: string;
      rolloutPercentage?: number;
      conditions?: Record<string, unknown>;
      changedBy?: string;
      changeReason?: string;
    },
  ): Promise<void> {
    const db = getDatabase();
    const env = options?.environment || this.environment;
    const changedBy = options?.changedBy ?? "system";

    try {
      const existing = await db("feature_flags")
        .where({ name, environment: env })
        .first();

      const oldValue = existing
        ? {
            enabled: existing.enabled,
            rolloutPercentage: existing.rollout_percentage,
            conditions:
              typeof existing.conditions === "string"
                ? JSON.parse(existing.conditions)
                : existing.conditions,
          }
        : null;

      const newValue = {
        enabled,
        rolloutPercentage: options?.rolloutPercentage ?? existing?.rollout_percentage ?? 100,
        conditions: options?.conditions ?? (oldValue?.conditions as Record<string, unknown>) ?? {},
      };

      if (existing) {
        await db("feature_flags")
          .where({ name, environment: env })
          .update({
            enabled,
            rollout_percentage: newValue.rolloutPercentage,
            conditions: JSON.stringify(newValue.conditions),
            updated_at: new Date(),
          });

        await featureFlagAuditService.recordChange({
          flagName: name,
          environment: env,
          action: "update",
          oldValue,
          newValue,
          changedBy,
          changeReason: options?.changeReason,
        });
      } else {
        await db("feature_flags").insert({
          id: randomBytes(16).toString("hex"),
          name,
          enabled,
          environment: env,
          rollout_percentage: newValue.rolloutPercentage,
          conditions: JSON.stringify(newValue.conditions),
          created_at: new Date(),
          updated_at: new Date(),
        });

        await featureFlagAuditService.recordChange({
          flagName: name,
          environment: env,
          action: "create",
          oldValue: null,
          newValue,
          changedBy,
          changeReason: options?.changeReason,
        });
      }

      this.featureFlagCache.delete(`${env}:${name}`);
      logger.info({ name, enabled, environment: env }, "Feature flag updated");
    } catch (error) {
      logger.error({ error, name }, "Failed to set feature flag");
      throw error;
    }
  }

  /**
   * Export configuration
   */
  async exportConfig(
    environment?: string,
  ): Promise<Record<string, ConfigValue>> {
    const configs = await this.getAll(environment);
    const exported: Record<string, ConfigValue> = {};

    for (const config of configs) {
      if (!config.is_sensitive) {
        exported[config.key] = config.value;
      }
    }

    return exported;
  }

  /**
   * Import configuration
   */
  async importConfig(
    configs: Record<string, ConfigValue>,
    importedBy: string,
    environment?: string,
  ): Promise<void> {
    for (const [key, value] of Object.entries(configs)) {
      await this.set(key, value, {
        environment,
        isSensitive: false,
        createdBy: importedBy,
      });
    }

    logger.info({ count: Object.keys(configs).length }, "Config imported");
  }

  /**
   * Get audit trail
   */
  async getAuditTrail(
    key?: string,
    limit: number = 100,
  ): Promise<ConfigAuditLog[]> {
    const db = getDatabase();

    try {
      let query = db("config_audit_logs")
        .orderBy("timestamp", "desc")
        .limit(limit);

      if (key) {
        query = query.where({ config_key: key });
      }

      return await query;
    } catch (error) {
      logger.error({ error }, "Failed to get audit trail");
      return [];
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.featureFlagCache.clear();
    logger.info("Config cache cleared");
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  private decryptIfNeeded(entry: ConfigEntry): ConfigValue {
    if (!entry.is_sensitive) {
      return typeof entry.value === "string"
        ? JSON.parse(entry.value)
        : entry.value;
    }

    try {
      const decrypted = decrypt(entry.value as string);
      return JSON.parse(decrypted);
    } catch (error) {
      logger.error({ error, key: entry.key }, "Failed to decrypt config");
      return entry.value;
    }
  }

  private async logChange(
    key: string,
    action: "create" | "update" | "delete",
    oldValue: ConfigValue | null,
    newValue: ConfigValue | null,
    changedBy: string,
  ): Promise<void> {
    const db = getDatabase();

    try {
      await db("config_audit_logs").insert({
        id: randomBytes(16).toString("hex"),
        config_key: key,
        action,
        old_value: oldValue ? JSON.stringify(oldValue) : null,
        new_value: newValue ? JSON.stringify(newValue) : null,
        changed_by: changedBy,
        timestamp: new Date(),
      });
    } catch (error) {
      logger.error({ error }, "Failed to log config change");
    }
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────────

export const configService = new ConfigService();
