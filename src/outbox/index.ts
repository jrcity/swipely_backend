/**
 * Outbox Pattern Integration Module
 * 
 * This module provides the main integration point for the Transactional Outbox Pattern
 * in Bridge-Watch. It exports all necessary components and provides a unified
 * initialization interface.
 */

export { OutboxProducer } from "./eventProducer.js";
export { OutboxDispatcher, DEFAULT_DISPATCHER_CONFIG } from "./eventDispatcher.js";
export { OutboxAdminApi } from "./adminApi.js";

// Outbox-integrated services
export { OutboxAlertService } from "../services/alert.service.outbox.js";
export { OutboxWebhookService } from "../services/webhook.service.outbox.js";

// Types
export type {
  OutboxEvent,
  OutboxEventType,
  OutboxEventRecord,
} from "./eventProducer.js";

export type {
  DispatcherConfig,
} from "./eventDispatcher.js";

export type {
  OutboxAdminStats,
  DeadLetterEvent,
} from "./adminApi.js";

import type { Knex } from "knex";
import { logger } from "../utils/logger.js";
import { OutboxDispatcher, DEFAULT_DISPATCHER_CONFIG } from "./eventDispatcher.js";
import { OutboxAdminApi } from "./adminApi.js";

/**
 * Outbox System Manager
 * Handles initialization, startup, and shutdown of the outbox system
 */
export class OutboxSystem {
  private dispatcher: OutboxDispatcher | null = null;
  private adminApi: OutboxAdminApi;
  private isInitialized = false;

  constructor(
    private db: Knex,
    private config = DEFAULT_DISPATCHER_CONFIG
  ) {
    this.adminApi = new OutboxAdminApi(db);
  }

  /**
   * Initialize the outbox system
   * Should be called during application startup
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Outbox system already initialized");
      return;
    }

    try {
      // Verify database schema
      await this.verifySchema();

      // Initialize dispatcher
      this.dispatcher = new OutboxDispatcher(this.db, this.config);
      
      // Update admin API with dispatcher reference
      this.adminApi = new OutboxAdminApi(this.db, this.dispatcher);

      this.isInitialized = true;
      logger.info("Outbox system initialized successfully");
    } catch (error) {
      logger.error({ error }, "Failed to initialize outbox system");
      throw error;
    }
  }

  /**
   * Start the outbox dispatcher
   * Should be called after application is fully initialized
   */
  async start(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error("Outbox system not initialized. Call initialize() first.");
    }

    if (!this.dispatcher) {
      throw new Error("Dispatcher not available");
    }

    await this.dispatcher.start();
    logger.info("Outbox system started");
  }

  /**
   * Stop the outbox system
   * Should be called during application shutdown
   */
  async stop(): Promise<void> {
    if (this.dispatcher) {
      await this.dispatcher.stop();
      logger.info("Outbox system stopped");
    }
  }

  async beginDrain(): Promise<void> {
    await this.dispatcher?.beginDrain();
  }

  /**
   * Get the admin API instance
   */
  getAdminApi(): OutboxAdminApi {
    return this.adminApi;
  }

  /**
   * Get the dispatcher instance
   */
  getDispatcher(): OutboxDispatcher | null {
    return this.dispatcher;
  }

  /**
   * Health check for the outbox system
   */
  async healthCheck(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    details: {
      initialized: boolean;
      dispatcherRunning: boolean;
      pendingEvents: number;
      failedEvents: number;
      deadLetterEvents: number;
    };
  }> {
    const details = {
      initialized: this.isInitialized,
      dispatcherRunning: this.dispatcher !== null,
      pendingEvents: 0,
      failedEvents: 0,
      deadLetterEvents: 0,
    };

    try {
      if (this.isInitialized) {
        const stats = await this.adminApi.getStats();
        details.pendingEvents = stats.outbox.pending;
        details.failedEvents = stats.outbox.failed;
        details.deadLetterEvents = stats.deadLetter.total;
      }

      // Determine health status
      let status: "healthy" | "degraded" | "unhealthy" = "healthy";
      
      if (!details.initialized || !details.dispatcherRunning) {
        status = "unhealthy";
      } else if (details.failedEvents > 100 || details.deadLetterEvents > 50) {
        status = "degraded";
      } else if (details.pendingEvents > 1000) {
        status = "degraded";
      }

      return { status, details };
    } catch (error) {
      logger.error({ error }, "Outbox health check failed");
      return {
        status: "unhealthy",
        details: {
          ...details,
          initialized: false,
          dispatcherRunning: false,
        },
      };
    }
  }

  /**
   * Verify that the required database schema exists
   */
  private async verifySchema(): Promise<void> {
    try {
      // Check if outbox tables exist
      const hasOutboxEvents = await this.db.schema.hasTable("outbox_events");
      const hasDeadLetterEvents = await this.db.schema.hasTable("dead_letter_events");
      const hasSequenceTable = await this.db.schema.hasTable("outbox_events_sequence");

      if (!hasOutboxEvents || !hasDeadLetterEvents || !hasSequenceTable) {
        throw new Error(
          "Outbox database schema not found. Please run migrations: npm run migrate"
        );
      }

      // Verify the sequence function exists
      const [functionExists] = await this.db.raw(`
        SELECT EXISTS (
          SELECT 1 FROM pg_proc 
          WHERE proname = 'get_next_outbox_sequence'
        ) as exists
      `);

      if (!functionExists.exists) {
        throw new Error(
          "Outbox sequence function not found. Please run migrations: npm run migrate"
        );
      }

      logger.debug("Outbox database schema verified");
    } catch (error) {
      logger.error({ error }, "Outbox schema verification failed");
      throw error;
    }
  }
}

/**
 * Global outbox system instance
 * Initialized during application startup
 */
let globalOutboxSystem: OutboxSystem | null = null;

/**
 * Initialize the global outbox system
 */
export async function initializeOutboxSystem(
  db: Knex,
  config = DEFAULT_DISPATCHER_CONFIG
): Promise<OutboxSystem> {
  if (globalOutboxSystem) {
    logger.warn("Global outbox system already initialized");
    return globalOutboxSystem;
  }

  globalOutboxSystem = new OutboxSystem(db, config);
  await globalOutboxSystem.initialize();
  
  return globalOutboxSystem;
}

/**
 * Get the global outbox system instance
 */
export function getOutboxSystem(): OutboxSystem {
  if (!globalOutboxSystem) {
    throw new Error("Outbox system not initialized. Call initializeOutboxSystem() first.");
  }
  return globalOutboxSystem;
}

/**
 * Start the global outbox system
 */
export async function startOutboxSystem(): Promise<void> {
  const system = getOutboxSystem();
  await system.start();
}

/**
 * Stop the global outbox system
 */
export async function stopOutboxSystem(): Promise<void> {
  if (globalOutboxSystem) {
    await globalOutboxSystem.stop();
    globalOutboxSystem = null;
  }
}
