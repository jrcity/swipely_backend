import { EventEmitter } from "node:events";
import type { Knex } from "knex";
import { config } from "../config/index.js";
import { getDatabase } from "../database/connection.js";
import { redis } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import {
  categoryPreferenceSchemas,
  DEFAULT_PREFERENCES,
  type PreferenceCategory,
  type PreferenceDefaults,
} from "./preferences.validation.js";

export const CURRENT_PREFERENCE_SCHEMA_VERSION = 2;

type UserPreferenceRow = {
  user_id: string;
  category: PreferenceCategory;
  pref_key: string;
  value: unknown;
};

type UserPreferenceStateRow = {
  user_id: string;
  version: number;
  schema_version: number;
  updated_at: Date;
};

type PreferenceDefaultsRow = {
  category: PreferenceCategory;
  pref_key: string;
  value: unknown;
  schema_version?: number;
};

export interface EffectivePreferences {
  userId: string;
  version: number;
  schemaVersion: number;
  lastUpdatedAt: string;
  categories: PreferenceDefaults;
}

export interface PreferenceUpdateEvent {
  userId: string;
  version: number;
  schemaVersion: number;
  updatedAt: string;
}

export interface PreferenceExport {
  schemaVersion: number;
  version: number;
  exportedAt: string;
  categories: PreferenceDefaults;
}

interface PreferencePayloadV1 {
  notifications?: {
    emailEnabled?: boolean;
    pushNotifications?: boolean;
    digestFrequency?: "never" | "daily" | "weekly";
  };
  display?: {
    theme?: "light" | "dark" | "system";
    useCompactMode?: boolean;
    timezone?: string;
    currency?: string;
  };
  alerts?: {
    severity?: "low" | "medium" | "high" | "critical";
    channels?: Array<"in_app" | "email" | "webhook">;
    mutedAssets?: string[];
  };
}

interface PreferenceImportMigration {
  fromVersion: number;
  toVersion: number;
  name: string;
  apply: (payload: Record<string, unknown>) => Record<string, unknown>;
}

const updateEventBus = new EventEmitter();

const preferenceImportMigrations: PreferenceImportMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    name: "rename-legacy-preference-keys",
    apply: (payload) => {
      const typedPayload = payload as PreferencePayloadV1;

      const notifications = typedPayload.notifications ?? {};
      const display = typedPayload.display ?? {};
      const alerts = typedPayload.alerts ?? {};

      return {
        ...payload,
        notifications: {
          ...notifications,
          pushEnabled:
            notifications.pushNotifications ?? DEFAULT_PREFERENCES.notifications.pushEnabled,
        },
        display: {
          ...display,
          compactMode:
            display.useCompactMode ?? DEFAULT_PREFERENCES.display.compactMode,
        },
        alerts: {
          ...alerts,
          defaultSeverity:
            alerts.severity ?? DEFAULT_PREFERENCES.alerts.defaultSeverity,
        },
      };
    },
  },
];

export class PreferencesService {
  private get cacheTtlSeconds() {
    return Math.max(config.REDIS_CACHE_TTL_SEC, 30);
  }

  private cacheKey(userId: string): string {
    return `preferences:${userId}`;
  }

  async getPreferences(userId: string): Promise<EffectivePreferences> {
    const cached = await this.readFromCache(userId);
    if (cached) {
      return cached;
    }

    const db = getDatabase();

    await this.ensureDefaultRows(db);
    const state = await this.ensureUserState(db, userId);

    const [defaultRows, overrideRows] = await Promise.all([
      db<PreferenceDefaultsRow>("preference_defaults")
        .select("category", "pref_key", "value")
        .where("schema_version", CURRENT_PREFERENCE_SCHEMA_VERSION),
      db<UserPreferenceRow>("user_preferences")
        .select("user_id", "category", "pref_key", "value")
        .where({ user_id: userId }),
    ]);

    const merged = this.mergeDefaultsAndOverrides(defaultRows, overrideRows);
    const effectivePreferences: EffectivePreferences = {
      userId,
      version: state.version,
      schemaVersion: state.schema_version,
      lastUpdatedAt: state.updated_at.toISOString(),
      categories: merged,
    };

    await this.writeToCache(userId, effectivePreferences);

    return effectivePreferences;
  }

  async getPreference(
    userId: string,
    category: PreferenceCategory,
    key: string
  ): Promise<unknown> {
    const preferences = await this.getPreferences(userId);
    const categoryData = preferences.categories[category] as Record<string, unknown>;

    if (!(key in categoryData)) {
      return null;
    }

    return categoryData[key];
  }

  async setPreference(
    userId: string,
    category: PreferenceCategory,
    key: string,
    value: unknown
  ): Promise<EffectivePreferences> {
    this.validateSinglePreference(category, key, value);

    const db = getDatabase();
    const state = await db.transaction(async (trx) => {
      await this.ensureDefaultRows(trx);
      await this.ensureUserState(trx, userId);

      await trx("user_preferences")
        .insert({
          user_id: userId,
          category,
          pref_key: key,
          value: this.toJsonValue(trx, value),
        })
        .onConflict(["user_id", "category", "pref_key"])
        .merge({
          value: this.toJsonValue(trx, value),
          updated_at: trx.fn.now(),
        });

      return this.bumpVersion(trx, userId);
    });

    await this.invalidateCache(userId);
    this.publishUpdate({
      userId,
      version: state.version,
      schemaVersion: state.schema_version,
      updatedAt: state.updated_at.toISOString(),
    });

    return this.getPreferences(userId);
  }

  async bulkUpdatePreferences(
    userId: string,
    updates: Partial<Record<PreferenceCategory, Record<string, unknown>>>,
    expectedVersion?: number
  ): Promise<EffectivePreferences> {
    for (const [category, keys] of Object.entries(updates)) {
      if (!keys) {
        continue;
      }

      for (const [key, value] of Object.entries(keys)) {
        this.validateSinglePreference(category as PreferenceCategory, key, value);
      }
    }

    const db = getDatabase();

    const state = await db.transaction(async (trx) => {
      await this.ensureDefaultRows(trx);
      const currentState = await this.ensureUserState(trx, userId);

      if (expectedVersion !== undefined && expectedVersion !== currentState.version) {
        throw new Error(
          `Version conflict: expected ${expectedVersion}, current ${currentState.version}`
        );
      }

      const rows: Array<{
        user_id: string;
        category: string;
        pref_key: string;
        value: Knex.Raw;
      }> = [];

      for (const [category, keys] of Object.entries(updates)) {
        if (!keys) {
          continue;
        }

        for (const [key, value] of Object.entries(keys)) {
          rows.push({
            user_id: userId,
            category,
            pref_key: key,
            value: this.toJsonValue(trx, value),
          });
        }
      }

      if (rows.length > 0) {
        await trx("user_preferences")
          .insert(rows)
          .onConflict(["user_id", "category", "pref_key"])
          .merge({
            value: trx.raw("excluded.value"),
            updated_at: trx.fn.now(),
          });
      }

      return this.bumpVersion(trx, userId);
    });

    await this.invalidateCache(userId);
    this.publishUpdate({
      userId,
      version: state.version,
      schemaVersion: state.schema_version,
      updatedAt: state.updated_at.toISOString(),
    });

    return this.getPreferences(userId);
  }

  async resetPreference(
    userId: string,
    category: PreferenceCategory,
    key: string
  ): Promise<EffectivePreferences> {
    this.ensureKeyExists(category, key);

    const db = getDatabase();
    const state = await db.transaction(async (trx) => {
      await this.ensureUserState(trx, userId);

      await trx("user_preferences")
        .where({ user_id: userId, category, pref_key: key })
        .delete();

      return this.bumpVersion(trx, userId);
    });

    await this.invalidateCache(userId);
    this.publishUpdate({
      userId,
      version: state.version,
      schemaVersion: state.schema_version,
      updatedAt: state.updated_at.toISOString(),
    });

    return this.getPreferences(userId);
  }

  async exportPreferences(userId: string): Promise<PreferenceExport> {
    const preferences = await this.getPreferences(userId);

    return {
      schemaVersion: preferences.schemaVersion,
      version: preferences.version,
      exportedAt: new Date().toISOString(),
      categories: preferences.categories,
    };
  }

  async importPreferences(
    userId: string,
    payload: {
      schemaVersion: number;
      categories: Record<string, Record<string, unknown>>;
    },
    overwrite = true
  ): Promise<EffectivePreferences> {
    const migratedPayload = await this.applyImportMigrations(
      userId,
      payload.schemaVersion,
      payload.categories
    );

    if (overwrite) {
      const db = getDatabase();
      await db("user_preferences").where({ user_id: userId }).delete();
    }

    const updates: Partial<Record<PreferenceCategory, Record<string, unknown>>> = {};
    for (const category of Object.keys(migratedPayload)) {
      if (!(category in categoryPreferenceSchemas)) {
        continue;
      }
      updates[category as PreferenceCategory] = migratedPayload[category] as Record<
        string,
        unknown
      >;
    }

    return this.bulkUpdatePreferences(userId, updates);
  }

  onPreferencesUpdated(listener: (event: PreferenceUpdateEvent) => void): () => void {
    updateEventBus.on("updated", listener);
    return () => {
      updateEventBus.off("updated", listener);
    };
  }

  private publishUpdate(event: PreferenceUpdateEvent) {
    updateEventBus.emit("updated", event);
  }

  private async applyImportMigrations(
    userId: string,
    sourceSchemaVersion: number,
    categories: Record<string, Record<string, unknown>>
  ): Promise<Record<string, Record<string, unknown>>> {
    if (sourceSchemaVersion === CURRENT_PREFERENCE_SCHEMA_VERSION) {
      return categories;
    }

    let workingVersion = sourceSchemaVersion;
    let workingPayload = categories as Record<string, unknown>;

    while (workingVersion < CURRENT_PREFERENCE_SCHEMA_VERSION) {
      const migration = preferenceImportMigrations.find(
        (item) => item.fromVersion === workingVersion
      );

      if (!migration) {
        throw new Error(
          `No migration path from schema version ${workingVersion} to ${CURRENT_PREFERENCE_SCHEMA_VERSION}`
        );
      }

      workingPayload = migration.apply(workingPayload);
      await this.recordMigrationHistory(userId, migration, {
        sourceSchemaVersion,
      });
      workingVersion = migration.toVersion;
    }

    return workingPayload as Record<string, Record<string, unknown>>;
  }

  private async recordMigrationHistory(
    userId: string,
    migration: PreferenceImportMigration,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const db = getDatabase();
    await db("preference_migration_history").insert({
      user_id: userId,
      from_schema_version: migration.fromVersion,
      to_schema_version: migration.toVersion,
      migration_name: migration.name,
      metadata: db.raw("?::jsonb", [JSON.stringify(metadata)]),
    });
  }

  private mergeDefaultsAndOverrides(
    defaultRows: PreferenceDefaultsRow[],
    overrideRows: UserPreferenceRow[]
  ): PreferenceDefaults {
    const merged = this.cloneDefaults();

    for (const row of defaultRows) {
      const category = row.category;
      if (!(category in merged)) {
        continue;
      }

      const categoryData = merged[category] as Record<string, unknown>;
      if (row.pref_key in categoryData) {
        categoryData[row.pref_key] = row.value;
      }
    }

    for (const row of overrideRows) {
      const category = row.category;
      if (!(category in merged)) {
        continue;
      }

      const categoryData = merged[category] as Record<string, unknown>;
      if (row.pref_key in categoryData) {
        categoryData[row.pref_key] = row.value;
      }
    }

    return merged;
  }

  private cloneDefaults(): PreferenceDefaults {
    return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES)) as PreferenceDefaults;
  }

  private validateSinglePreference(
    category: PreferenceCategory,
    key: string,
    value: unknown
  ) {
    this.ensureKeyExists(category, key);
    const schemaMap = categoryPreferenceSchemas[category] as Record<
      string,
      { parse: (input: unknown) => unknown }
    >;
    const schema = schemaMap[key];

    schema.parse(value);
  }

  private ensureKeyExists(category: PreferenceCategory, key: string) {
    if (!(category in categoryPreferenceSchemas)) {
      throw new Error(`Unsupported preference category: ${category}`);
    }

    if (!(key in categoryPreferenceSchemas[category])) {
      throw new Error(`Unsupported preference key '${key}' for category '${category}'`);
    }
  }

  private async ensureDefaultRows(db: Knex | Knex.Transaction): Promise<void> {
    const rows = Object.entries(DEFAULT_PREFERENCES).flatMap(([category, keys]) =>
      Object.entries(keys).map(([key, value]) => ({
        category,
        pref_key: key,
        value: this.toJsonValue(db, value),
        schema_version: CURRENT_PREFERENCE_SCHEMA_VERSION,
      }))
    );

    await db("preference_defaults")
      .insert(rows)
      .onConflict(["category", "pref_key", "schema_version"])
      .ignore();
  }

  private async ensureUserState(
    db: Knex | Knex.Transaction,
    userId: string
  ): Promise<UserPreferenceStateRow> {
    await db("user_preference_state")
      .insert({
        user_id: userId,
        version: 1,
        schema_version: CURRENT_PREFERENCE_SCHEMA_VERSION,
      })
      .onConflict("user_id")
      .ignore();

    const state = await db<UserPreferenceStateRow>("user_preference_state")
      .where({ user_id: userId })
      .first();

    if (!state) {
      throw new Error("Failed to load preference state");
    }

    return state;
  }

  private async bumpVersion(
    db: Knex | Knex.Transaction,
    userId: string
  ): Promise<UserPreferenceStateRow> {
    const [updatedState] = await db<UserPreferenceStateRow>("user_preference_state")
      .where({ user_id: userId })
      .update({
        version: db.raw("version + 1"),
        schema_version: CURRENT_PREFERENCE_SCHEMA_VERSION,
        updated_at: db.fn.now(),
      })
      .returning("*");

    if (!updatedState) {
      throw new Error("Failed to update preference version");
    }

    return updatedState;
  }

  private toJsonValue(db: Knex | Knex.Transaction, value: unknown): Knex.Raw {
    return db.raw("?::jsonb", [JSON.stringify(value)]);
  }

  private async readFromCache(userId: string): Promise<EffectivePreferences | null> {
    try {
      const cacheValue = await redis.get(this.cacheKey(userId));
      if (!cacheValue) {
        return null;
      }

      const parsed = JSON.parse(cacheValue) as EffectivePreferences;
      return parsed;
    } catch (error) {
      logger.warn({ error, userId }, "Failed to read preferences from cache");
      return null;
    }
  }

  private async writeToCache(
    userId: string,
    value: EffectivePreferences
  ): Promise<void> {
    try {
      await redis.set(
        this.cacheKey(userId),
        JSON.stringify(value),
        "EX",
        this.cacheTtlSeconds
      );
    } catch (error) {
      logger.warn({ error, userId }, "Failed to write preferences cache");
    }
  }

  private async invalidateCache(userId: string): Promise<void> {
    try {
      await redis.del(this.cacheKey(userId));
    } catch (error) {
      logger.warn({ error, userId }, "Failed to invalidate preferences cache");
    }
  }
}
