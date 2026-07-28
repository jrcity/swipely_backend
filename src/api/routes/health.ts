import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HealthCheckService } from "../../services/healthCheck.service.js";
import { DeepReadinessService } from "../../services/deepReadiness.service.js";

const healthService = new HealthCheckService();
const deepReadinessService = new DeepReadinessService();

/**
 * Health check routes for monitoring and Kubernetes probes
 * 
 * Endpoints:
 * - GET /health - Simple health check (existing)
 * - GET /health/ready - Readiness probe (Kubernetes)
 * - GET /health/live - Liveness probe (Kubernetes)
 * - GET /health/detailed - Comprehensive system health
 */

export async function healthRoutes(server: FastifyInstance) {
  // Simple health check (backward compatibility)
  // Using empty string instead of "/" to avoid route conflicts
  server.get(
    "/",
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      return { 
        status: "ok", 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: process.env.npm_package_version || "0.1.0"
      };
    }
  );

  // Kubernetes liveness probe
  // Checks if the process is running and responsive
  server.get(
    "/live",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const liveness = await healthService.getLiveness();
        reply.code(liveness.status === "ok" ? 200 : 503);
        return liveness;
      } catch (error) {
        server.log.error({ error }, "Liveness probe failed");
        reply.code(503);
        return {
          status: "error",
          timestamp: new Date().toISOString(),
        };
      }
    }
  );

  // Deep readiness probe
  // Aggregates: database, cache, outbox lag, worker heartbeats, external providers.
  // Returns 200 when all critical checks pass; 503 when any critical dependency is unhealthy.
  server.get(
    "/ready",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const readiness = await deepReadinessService.getDeepReadiness();
        reply.code(readiness.status === "ready" ? 200 : 503);
        return readiness;
      } catch (error) {
        server.log.error({ error }, "Deep readiness probe failed");
        reply.code(503);
        return {
          status: "not_ready",
          checkedAt: new Date().toISOString(),
          checks: {
            database: { status: "unknown", checkedAt: new Date().toISOString() },
            cache: { status: "unknown", checkedAt: new Date().toISOString() },
            outbox: { status: "unknown", checkedAt: new Date().toISOString(), pendingEvents: 0, failedEvents: 0, deadLetterEvents: 0 },
            workers: [],
            externalProviders: [],
          },
          summary: { total: 0, healthy: 0, unhealthy: 0, degraded: 0, unknown: 0 },
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  // Comprehensive health check
  // Detailed system health for monitoring dashboards
  server.get(
    "/detailed",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const health = await healthService.getSystemHealth();
        reply.code(health.status === "unhealthy" ? 503 : 200);
        return health;
      } catch (error) {
        server.log.error({ error }, "Detailed health check failed");
        reply.code(503);
        return {
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          version: process.env.npm_package_version || "0.1.0",
          checks: {
            database: { status: "unhealthy", timestamp: new Date().toISOString(), duration: 0 },
            redis: { status: "unhealthy", timestamp: new Date().toISOString(), duration: 0 },
            externalApis: { status: "unhealthy", timestamp: new Date().toISOString(), duration: 0 },
            system: { status: "unhealthy", timestamp: new Date().toISOString(), duration: 0 },
          },
          summary: { total: 4, healthy: 0, unhealthy: 4, degraded: 0 },
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  // Individual component checks
  server.get(
    "/components/:component",
    async (
      request: FastifyRequest<{ Params: { component: string } }>,
      reply: FastifyReply
    ) => {
      const { component } = request.params;
      
      try {
        const health = await healthService.getSystemHealth();
        let result;
        
        switch (component) {
          case "database":
            result = health.checks.database;
            break;
          case "redis":
            result = health.checks.redis;
            break;
          case "external-apis":
            result = health.checks.externalApis;
            break;
          case "system":
            result = health.checks.system;
            break;
          default:
            reply.code(404);
            return {
              error: "Component not found",
              validComponents: ["database", "redis", "external-apis", "system"],
            };
        }
        
        // Return appropriate HTTP status
        switch (result.status) {
          case "healthy":
            reply.code(200);
            break;
          case "degraded":
            reply.code(200);
            break;
          case "unhealthy":
            reply.code(503);
            break;
        }
        
        return result;
      } catch (error) {
        server.log.error({ component, error }, "Component health check failed");
        reply.code(503);
        return {
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          message: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  // Health check metrics endpoint
  // Returns metrics for monitoring systems
  server.get(
    "/metrics",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const health = await healthService.getSystemHealth();
        
        // Prometheus-style metrics
        const metrics = [
          `# HELP bridge_watch_health_status Health check status (1=healthy, 0.5=degraded, 0=unhealthy)`,
          `# TYPE bridge_watch_health_status gauge`,
          `bridge_watch_health_status{component="database"} ${health.checks.database.status === "healthy" ? 1 : health.checks.database.status === "degraded" ? 0.5 : 0}`,
          `bridge_watch_health_status{component="redis"} ${health.checks.redis.status === "healthy" ? 1 : health.checks.redis.status === "degraded" ? 0.5 : 0}`,
          `bridge_watch_health_status{component="external_apis"} ${health.checks.externalApis.status === "healthy" ? 1 : health.checks.externalApis.status === "degraded" ? 0.5 : 0}`,
          `bridge_watch_health_status{component="system"} ${health.checks.system.status === "healthy" ? 1 : health.checks.system.status === "degraded" ? 0.5 : 0}`,
          `bridge_watch_health_status{component="overall"} ${health.status === "healthy" ? 1 : health.status === "degraded" ? 0.5 : 0}`,
          "",
          `# HELP bridge_watch_uptime_seconds Application uptime in seconds`,
          `# TYPE bridge_watch_uptime_seconds counter`,
          `bridge_watch_uptime_seconds ${health.uptime}`,
          "",
          `# HELP bridge_watch_health_check_duration_seconds Health check duration in seconds`,
          `# TYPE bridge_watch_health_check_duration_seconds gauge`,
          `bridge_watch_health_check_duration_seconds{component="database"} ${(health.checks.database.duration || 0) / 1000}`,
          `bridge_watch_health_check_duration_seconds{component="redis"} ${(health.checks.redis.duration || 0) / 1000}`,
          `bridge_watch_health_check_duration_seconds{component="external_apis"} ${(health.checks.externalApis.duration || 0) / 1000}`,
          `bridge_watch_health_check_duration_seconds{component="system"} ${(health.checks.system.duration || 0) / 1000}`,
          "",
        ];

        reply.type("text/plain");
        return metrics.join("\n") + "\n";
      } catch (error) {
        server.log.error({ error }, "Health metrics failed");
        reply.code(503);
        return {
          error: "Failed to generate metrics",
          timestamp: new Date().toISOString(),
        };
      }
    }
  );
}
