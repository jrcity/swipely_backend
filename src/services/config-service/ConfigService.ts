import { Knex } from "knex";
import { Redis } from "ioredis";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import {
  ConfigKey,
  ConfigValue,
  validateConfig,
  safeValidateConfig,
  isSensitiveKey,
} from "./validators.js";
import { getSafeDefault, hasSafeDefault } from "./defaults.js";

/**
 * Configuration Service with Full Audit Trail
 * Issue: #377
 * 
 * Features:
 * - Hierarchical resolution (env → global → default)
 * - Redis caching with pub/sub invalidation
 * - Full audit trail for all changes
 * - Encryption for sensitive values
 * - Type-safe validation with Zod
 * - Zero-downtime deployments
 */

interface ConfigEntry {
  id: number;
  environment: string;
  key: string;
  value: any;
  encrypted: boolean;
  schema_name: string | null;
  validated: boolean;
  description: string | null;
  created_by: string;
  created_at: Date;
  changed_by: string | null;
  changed_at: Date | null;
}

interface ConfigAuditEntry {
  id: number;
  config_id: number;
  old_value: any;
  new_value: any;
  changed_by: string;
  change_reason: string;
  changed_at: Date;
}

interface SetConfigOptions {
  environment?: string;
  description?: string;
  changeReason?: string;
  changedBy: string;
}

export class ConfigService {
  private readonly db: Knex;
  private readonly redis: Redis;
  private readonly cachePrefix = "config:";
  private readonly cacheTTL = 300; // 5 minutes
  private readonly pubsubChannel = "config:changed";
  private readonly encryptionKey: Buffer;
  private readonly algorithm = "aes-256-gcm";

  constructor(db: Knex, redis: Redis, encryptionKey?: string) {
    this.db = db;
    this.redis = redis;
    
    // Initialize encryption key (32 bytes for AES-256) — prefer the injected
    // key, then the validated env config, then a clearly-insecure dev fallback.
    const key = encryptionKey ?? config.CONFIG_ENCRYPTION_KEY ?? "default-key-change-in-production-32b";
    this.encryptionKey = Buffer.from(key.padEnd(32, "0").slice(0, 32));

    // Subscribe to config change events for cache invalidation
    this.subscribeToChanges();
  }

  /**
   * Get configuration value with hierarchical resolution
   * 
   * Resolution order:
   * 1. Environment-specific config
   * 2. Global config (fallback)
   * 3. Safe default (embedded)
   * 4. Error (required config missing)
   */
  async get<K extends ConfigKey>(
    key: K,
    environment: string = "global"
  ): Promise<ConfigValue<K>> {
    try {
      // 1. Try environment-specific config
      const envConfig = await this.getFromCacheOrDB(key, environment);
      if (envConfig !== null) {
        logger.debug({ key, environment, source: "env-specific" }, "Config resolved");
        return envConfig;
      }

      // 2. Try global config (fallback)
      if (environment !== "global") {
        const globalConfig = await this.getFromCacheOrDB(key, "global");
        if (globalConfig !== null) {
          logger.debug({ key, environment, source: "global" }, "Config resolved");
          return globalConfig;
        }
      }

      // 3. Try safe default
      if (hasSafeDefault(key)) {
        const safeDefault = getSafeDefault(key);
        logger.warn(
          { key, environment, source: "safe-default" },
          "Using safe default for config"
        );
        return safeDefault as ConfigValue<K>;
      }

      // 4. Error - no config found
      throw new Error(
        `No configuration found for ${key} in ${environment} (no global, no default)`
      );
    } catch (error) {
      logger.error({ error, key, environment }, "Failed to get config");
      throw error;
    }
  }

  /**
   * Get configuration from cache or database
   */
  private async getFromCacheOrDB<K extends ConfigKey>(
    key: K,
    environment: string
  ): Promise<ConfigValue<K> | null> {
    const cacheKey = `${this.cachePrefix}${environment}:${key}`;

    try {
      // Try cache first (99% path)
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        logger.debug({ key, environment, source: "cache" }, "Config cache hit");
        return JSON.parse(cached) as ConfigValue<K>;
      }

      // Cache miss - query database
      const config = await this.db<ConfigEntry>("configs")
        .where({ environment, key: key as string })
        .first();

      if (!config || !config.validated) {
        return null;
      }

      // Decrypt if encrypted
      let value = config.value;
      if (config.encrypted) {
        value = this.decrypt(value);
      }

      // Validate with Zod schema
      const validated = validateConfig(key, value);

      // Cache for TTL
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(validated));

      logger.debug({ key, environment, source: "database" }, "Config cache miss");
      return validated;
    } catch (error) {
      logger.error({ error, key, environment }, "Failed to get config from cache/DB");
      return null;
    }
  }

  /**
   * Set configuration value with full audit trail
   */
  async set<K extends ConfigKey>(
    key: K,
    value: ConfigValue<K>,
    options: SetConfigOptions
  ): Promise<void> {
    const environment = options.environment || "global";
    const changeReason = options.changeReason || "Configuration update";
    const changedBy = options.changedBy;

    try {
      // Validate value with Zod schema
      const validationResult = safeValidateConfig(key, value);
      if (!validationResult.success) {
        const failResult = validationResult as { success: false; error: import("zod").ZodError };
        throw new Error(
          `Validation failed for ${key}: ${failResult.error.message}`
        );
      }
      const validatedValue = validationResult.data;

      // Encrypt if sensitive
      const shouldEncrypt = isSensitiveKey(key);
      const storedValue = shouldEncrypt
        ? this.encrypt(JSON.stringify(validatedValue))
        : validatedValue;

      // Use transaction for atomicity
      await this.db.transaction(async (trx) => {
        // Check if config exists
        const existing = await trx<ConfigEntry>("configs")
          .where({ environment, key: key as string })
          .first();

        let configId: number;

        if (existing) {
          // Update existing config
          await trx<ConfigEntry>("configs")
            .where({ id: existing.id })
            .update({
              value: storedValue,
              encrypted: shouldEncrypt,
              schema_name: key,
              validated: true,
              description: options.description || existing.description,
              changed_by: changedBy,
              changed_at: trx.fn.now(),
            });

          configId = existing.id;

          // Log audit trail
          await trx<ConfigAuditEntry>("config_audits").insert({
            config_id: configId,
            old_value: existing.value,
            new_value: storedValue,
            changed_by: changedBy,
            change_reason: changeReason,
          });

          logger.info(
            { key, environment, changedBy, configId },
            "Config updated"
          );
        } else {
          // Insert new config
          const [inserted] = await trx<ConfigEntry>("configs")
            .insert({
              environment,
              key: key as string,
              value: storedValue,
              encrypted: shouldEncrypt,
              schema_name: key,
              validated: true,
              description: options.description,
              created_by: changedBy,
              changed_by: changedBy,
              changed_at: trx.fn.now(),
            })
            .returning("id");

          configId = inserted.id;

          // Log audit trail (no old value for new config)
          await trx<ConfigAuditEntry>("config_audits").insert({
            config_id: configId,
            old_value: null,
            new_value: storedValue,
            changed_by: changedBy,
            change_reason: changeReason,
          });

          logger.info(
            { key, environment, changedBy, configId },
            "Config created"
          );
        }
      });

      // Invalidate cache cluster-wide
      await this.invalidate(environment, key);
    } catch (error) {
      logger.error({ error, key, environment }, "Failed to set config");
      throw error;
    }
  }

  /**
   * Delete configuration
   */
  async delete(
    key: ConfigKey,
    environment: string,
    deletedBy: string,
    reason: string = "Configuration deleted"
  ): Promise<void> {
    try {
      await this.db.transaction(async (trx) => {
        const existing = await trx<ConfigEntry>("configs")
          .where({ environment, key: key as string })
          .first();

        if (!existing) {
          throw new Error(`Config ${key} not found in ${environment}`);
        }

        // Log audit trail before deletion
        await trx<ConfigAuditEntry>("config_audits").insert({
          config_id: existing.id,
          old_value: existing.value,
          new_value: null,
          changed_by: deletedBy,
          change_reason: reason,
        });

        // Delete config (audit entries cascade)
        await trx<ConfigEntry>("configs").where({ id: existing.id }).delete();

        logger.info({ key, environment, deletedBy }, "Config deleted");
      });

      // Invalidate cache cluster-wide
      await this.invalidate(environment, key);
    } catch (error) {
      logger.error({ error, key, environment }, "Failed to delete config");
      throw error;
    }
  }

  /**
   * Get all configurations for an environment
   */
  async getAll(environment?: string): Promise<ConfigEntry[]> {
    try {
      const query = this.db<ConfigEntry>("configs");
      
      if (environment) {
        query.where({ environment });
      }

      const configs = await query.orderBy("changed_at", "desc");

      // Decrypt sensitive values
      return configs.map((config) => {
        if (config.encrypted) {
          config.value = this.decrypt(config.value);
        }
        return config;
      });
    } catch (error) {
      logger.error({ error, environment }, "Failed to get all configs");
      throw error;
    }
  }

  /**
   * Get audit trail for a configuration
   */
  async getAuditTrail(
    key?: ConfigKey,
    environment?: string,
    limit: number = 100
  ): Promise<ConfigAuditEntry[]> {
    try {
      const query = this.db<ConfigAuditEntry>("config_audits")
        .join("configs", "config_audits.config_id", "configs.id")
        .select("config_audits.*");

      if (key) {
        query.where("configs.key", key as string);
      }

      if (environment) {
        query.where("configs.environment", environment);
      }

      const audits = await query
        .orderBy("config_audits.changed_at", "desc")
        .limit(limit);

      return audits;
    } catch (error) {
      logger.error({ error, key, environment }, "Failed to get audit trail");
      throw error;
    }
  }

  /**
   * Invalidate cache cluster-wide
   */
  async invalidate(environment: string, key?: ConfigKey): Promise<void> {
    try {
      if (key) {
        // Invalidate specific key
        const cacheKey = `${this.cachePrefix}${environment}:${key}`;
        await this.redis.del(cacheKey);
      } else {
        // Invalidate all keys for environment
        const pattern = `${this.cachePrefix}${environment}:*`;
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      }

      // Publish change event for cluster-wide invalidation
      await this.redis.publish(
        this.pubsubChannel,
        JSON.stringify({
          environment,
          key: key || "*",
          timestamp: new Date().toISOString(),
        })
      );

      logger.debug({ environment, key }, "Cache invalidated");
    } catch (error) {
      logger.error({ error, environment, key }, "Failed to invalidate cache");
      throw error;
    }
  }

  /**
   * Subscribe to config change events for cache invalidation
   */
  private subscribeToChanges(): void {
    const subscriber = this.redis.duplicate();
    
    subscriber.subscribe(this.pubsubChannel, (err) => {
      if (err) {
        logger.error({ err }, "Failed to subscribe to config changes");
      } else {
        logger.info("Subscribed to config change events");
      }
    });

    subscriber.on("message", async (channel, message) => {
      if (channel === this.pubsubChannel) {
        try {
          const { environment, key } = JSON.parse(message);
          
          // Invalidate local cache
          if (key === "*") {
            const pattern = `${this.cachePrefix}${environment}:*`;
            const keys = await this.redis.keys(pattern);
            if (keys.length > 0) {
              await this.redis.del(...keys);
            }
          } else {
            const cacheKey = `${this.cachePrefix}${environment}:${key}`;
            await this.redis.del(cacheKey);
          }

          logger.debug({ environment, key }, "Cache invalidated via pub/sub");
        } catch (error) {
          logger.error({ error, message }, "Failed to process config change event");
        }
      }
    });
  }

  /**
   * Encrypt sensitive value
   */
  private encrypt(text: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(this.algorithm, this.encryptionKey, iv);
    
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    
    const authTag = cipher.getAuthTag();
    
    // Return: iv:authTag:encrypted
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  }

  /**
   * Decrypt sensitive value
   */
  private decrypt(encryptedText: string): any {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(":");
    
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = createDecipheriv(this.algorithm, this.encryptionKey, iv);
    
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    
    return JSON.parse(decrypted);
  }

  /**
   * Export configurations for an environment
   */
  async exportConfig(environment: string): Promise<Record<string, any>> {
    try {
      const configs = await this.getAll(environment);
      
      const exported: Record<string, any> = {};
      for (const config of configs) {
        exported[config.key] = config.value;
      }

      logger.info({ environment, count: configs.length }, "Config exported");
      return exported;
    } catch (error) {
      logger.error({ error, environment }, "Failed to export config");
      throw error;
    }
  }

  /**
   * Import configurations for an environment (bulk operation)
   */
  async importConfig(
    configs: Record<string, any>,
    environment: string,
    importedBy: string,
    importReason: string = "Bulk config import"
  ): Promise<void> {
    try {
      const keys = Object.keys(configs);
      
      for (const key of keys) {
        await this.set(key as ConfigKey, configs[key], {
          environment,
          changedBy: importedBy,
          changeReason: importReason,
        });
      }

      logger.info(
        { environment, count: keys.length, importedBy },
        "Config imported"
      );
    } catch (error) {
      logger.error({ error, environment }, "Failed to import config");
      throw error;
    }
  }
}
