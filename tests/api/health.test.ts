import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildServer } from "../../src/index.js";
import type { FastifyInstance } from "fastify";

describe("Health Check Endpoints", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe("GET /health", () => {
    it("should return simple health status", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/",
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toMatchObject({
        status: "ok",
        uptime: expect.any(Number),
        version: expect.any(String),
      });
      expect(new Date(payload.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe("GET /health/live", () => {
    it("should return liveness status", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/live",
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toMatchObject({
        status: "ok",
      });
      expect(new Date(payload.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe("GET /health/ready", () => {
    it("should return deep readiness status with 200 or 503", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/ready",
      });

      expect([200, 503]).toContain(response.statusCode);
      const payload = JSON.parse(response.payload);

      // Top-level shape
      expect(payload).toMatchObject({
        status: expect.stringMatching(/^ready$|^not_ready$/),
        checkedAt: expect.any(String),
        summary: {
          total: expect.any(Number),
          healthy: expect.any(Number),
          unhealthy: expect.any(Number),
          degraded: expect.any(Number),
          unknown: expect.any(Number),
        },
      });
      expect(new Date(payload.checkedAt)).toBeInstanceOf(Date);

      // checks block must be present
      expect(payload.checks).toBeDefined();
      expect(payload.checks.database).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
        checkedAt: expect.any(String),
      });
      expect(payload.checks.cache).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
        checkedAt: expect.any(String),
      });
      expect(payload.checks.outbox).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
        checkedAt: expect.any(String),
        pendingEvents: expect.any(Number),
        failedEvents: expect.any(Number),
        deadLetterEvents: expect.any(Number),
      });
      expect(Array.isArray(payload.checks.workers)).toBe(true);
      expect(Array.isArray(payload.checks.externalProviders)).toBe(true);
    });

    it("should return 503 when critical dependencies are unhealthy", async () => {
      // This test verifies the status code logic: 503 iff status === "not_ready"
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/ready",
      });
      const payload = JSON.parse(response.payload);
      if (payload.status === "not_ready") {
        expect(response.statusCode).toBe(503);
      } else {
        expect(response.statusCode).toBe(200);
      }
    });
  });

  describe("GET /health/detailed", () => {
    it("should return comprehensive system health", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/detailed",
      });

      expect([200, 503]).toContain(response.statusCode);
      const payload = JSON.parse(response.payload);
      expect(payload).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        uptime: expect.any(Number),
        version: expect.any(String),
        checks: {
          database: {
            status: expect.stringMatching(/healthy|degraded|unhealthy/),
            timestamp: expect.any(String),
            duration: expect.any(Number),
          },
          redis: {
            status: expect.stringMatching(/healthy|degraded|unhealthy/),
            timestamp: expect.any(String),
            duration: expect.any(Number),
          },
          externalApis: {
            status: expect.stringMatching(/healthy|degraded|unhealthy/),
            timestamp: expect.any(String),
            duration: expect.any(Number),
          },
          system: {
            status: expect.stringMatching(/healthy|degraded|unhealthy/),
            timestamp: expect.any(String),
            duration: expect.any(Number),
          },
        },
        summary: {
          total: 4,
          healthy: expect.any(Number),
          unhealthy: expect.any(Number),
          degraded: expect.any(Number),
        },
      });
      expect(new Date(payload.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe("GET /health/components/:component", () => {
    it("should return individual component health for database", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/components/database",
      });

      expect([200, 503]).toContain(response.statusCode);
      const payload = JSON.parse(response.payload);
      expect(payload).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        timestamp: expect.any(String),
        duration: expect.any(Number),
      });
    });

    it("should return individual component health for redis", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/components/redis",
      });

      expect([200, 503]).toContain(response.statusCode);
      const payload = JSON.parse(response.payload);
      expect(payload).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        timestamp: expect.any(String),
        duration: expect.any(Number),
      });
    });

    it("should return individual component health for external-apis", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/components/external-apis",
      });

      expect([200, 503]).toContain(response.statusCode);
      const payload = JSON.parse(response.payload);
      expect(payload).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        timestamp: expect.any(String),
        duration: expect.any(Number),
      });
    });

    it("should return individual component health for system", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/components/system",
      });

      expect([200, 503]).toContain(response.statusCode);
      const payload = JSON.parse(response.payload);
      expect(payload).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        timestamp: expect.any(String),
        duration: expect.any(Number),
      });
    });

    it("should return 404 for invalid component", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/components/invalid",
      });

      expect(response.statusCode).toBe(404);
      const payload = JSON.parse(response.payload);
      expect(payload).toMatchObject({
        error: "Component not found",
        validComponents: ["database", "redis", "external-apis", "system"],
      });
    });
  });

  describe("GET /health/metrics", () => {
    it("should return Prometheus-style metrics", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/v1/health/metrics",
      });

      expect([200, 503]).toContain(response.statusCode);
      expect(response.headers["content-type"]).toMatch(/^text\/plain/);
      
      const payload = response.payload;
      expect(payload).toContain("# HELP bridge_watch_health_status");
      expect(payload).toContain("# TYPE bridge_watch_health_status gauge");
      expect(payload).toContain("bridge_watch_health_status{component=\"database\"}");
      expect(payload).toContain("bridge_watch_health_status{component=\"redis\"}");
      expect(payload).toContain("bridge_watch_health_status{component=\"external_apis\"}");
      expect(payload).toContain("bridge_watch_health_status{component=\"system\"}");
      expect(payload).toContain("bridge_watch_health_status{component=\"overall\"}");
      
      expect(payload).toContain("# HELP bridge_watch_uptime_seconds");
      expect(payload).toContain("# TYPE bridge_watch_uptime_seconds counter");
      expect(payload).toContain("bridge_watch_uptime_seconds");
      
      expect(payload).toContain("# HELP bridge_watch_health_check_duration_seconds");
      expect(payload).toContain("# TYPE bridge_watch_health_check_duration_seconds gauge");
      expect(payload).toContain("bridge_watch_health_check_duration_seconds{component=\"database\"}");
    });
  });
});

describe("Health Check Service Unit Tests", () => {
  let HealthCheckService: any;
  let healthService: any;

  beforeAll(async () => {
    // Dynamic import to avoid module loading issues
    const module = await import("../../src/services/healthCheck.service.js");
    HealthCheckService = module.HealthCheckService;
    healthService = new HealthCheckService();
  });

  afterAll(async () => {
    if (healthService) {
      await healthService.disconnect();
    }
  });

  describe("getLiveness", () => {
    it("should return ok status", async () => {
      const result = await healthService.getLiveness();
      expect(result).toMatchObject({
        status: "ok",
      });
      expect(new Date(result.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe("getReadiness", () => {
    it("should return readiness status with checks", async () => {
      const result = await healthService.getReadiness();
      expect(result).toMatchObject({
        status: expect.stringMatching(/ready|not_ready/),
        checks: {
          database: expect.any(Boolean),
          redis: expect.any(Boolean),
        },
      });
      expect(new Date(result.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe("getSystemHealth", () => {
    it("should return comprehensive system health", async () => {
      const result = await healthService.getSystemHealth();
      expect(result).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        uptime: expect.any(Number),
        version: expect.any(String),
        checks: {
          database: expect.any(Object),
          redis: expect.any(Object),
          externalApis: expect.any(Object),
          system: expect.any(Object),
        },
        summary: {
          total: 4,
          healthy: expect.any(Number),
          unhealthy: expect.any(Number),
          degraded: expect.any(Number),
        },
      });
      expect(new Date(result.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe("checkDatabase", () => {
    it("should perform database health check", async () => {
      const result = await healthService.checkDatabase();
      expect(result).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        timestamp: expect.any(String),
        duration: expect.any(Number),
      });
      if (result.status === "healthy") {
        expect(result.details).toMatchObject({
          tableCount: expect.any(Number),
          connection: "postgresql",
        });
      }
      if (result.status === "unhealthy") {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("checkRedis", () => {
    it("should perform Redis health check", async () => {
      const result = await healthService.checkRedis();
      expect(result).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        timestamp: expect.any(String),
        duration: expect.any(Number),
      });
      if (result.status === "healthy") {
        expect(result.details).toMatchObject({
          usedMemory: expect.any(Number),
          connection: "redis",
        });
      }
      if (result.status === "unhealthy") {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("checkSystemResources", () => {
    it("should perform system resource check", async () => {
      const result = await healthService.checkSystemResources();
      expect(result).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        timestamp: expect.any(String),
        duration: expect.any(Number),
      });
      if (result.details) {
        expect(result.details).toMatchObject({
          memory: expect.any(Object),
          disk: expect.any(Object),
          thresholds: expect.any(Object),
        });
        expect(result.details.memory).toMatchObject({
          rss: expect.any(Number),
          heapUsed: expect.any(Number),
          heapTotal: expect.any(Number),
          external: expect.any(Number),
          systemUsagePercent: expect.any(Number),
        });
      }
    });
  });

  describe("checkExternalApis", () => {
    it("should perform external API health check", async () => {
      const result = await healthService.checkExternalApis();
      expect(result).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy/),
        timestamp: expect.any(String),
        duration: expect.any(Number),
      });
      if (result.details) {
        expect(result.details).toMatchObject({
          apis: expect.any(Array),
          healthyCount: expect.any(Number),
          totalCount: expect.any(Number),
        });
      }
    });
  });
});

describe("DeepReadinessService Unit Tests", () => {
  let DeepReadinessService: any;
  let deepReadinessService: any;

  beforeAll(async () => {
    const module = await import("../../src/services/deepReadiness.service.js");
    DeepReadinessService = module.DeepReadinessService;
    deepReadinessService = new DeepReadinessService();
  });

  afterAll(async () => {
    if (deepReadinessService) {
      await deepReadinessService.disconnect();
    }
  });

  describe("getDeepReadiness", () => {
    it("should return a structured deep readiness response", async () => {
      const result = await deepReadinessService.getDeepReadiness();

      expect(result).toMatchObject({
        status: expect.stringMatching(/^ready$|^not_ready$/),
        checkedAt: expect.any(String),
        summary: {
          total: expect.any(Number),
          healthy: expect.any(Number),
          unhealthy: expect.any(Number),
          degraded: expect.any(Number),
          unknown: expect.any(Number),
        },
      });
      expect(new Date(result.checkedAt)).toBeInstanceOf(Date);

      expect(result.checks).toBeDefined();
      expect(result.checks.database).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
        checkedAt: expect.any(String),
      });
      expect(result.checks.cache).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
        checkedAt: expect.any(String),
      });
      expect(result.checks.outbox).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
        checkedAt: expect.any(String),
        pendingEvents: expect.any(Number),
        failedEvents: expect.any(Number),
        deadLetterEvents: expect.any(Number),
      });
      expect(Array.isArray(result.checks.workers)).toBe(true);
      expect(Array.isArray(result.checks.externalProviders)).toBe(true);
    });

    it("status is not_ready when any unhealthy dependency exists", async () => {
      const result = await deepReadinessService.getDeepReadiness();
      const hasUnhealthy = result.summary.unhealthy > 0;
      if (hasUnhealthy) {
        expect(result.status).toBe("not_ready");
      } else {
        expect(result.status).toBe("ready");
      }
    });
  });

  describe("checkDatabase", () => {
    it("should return a DependencyResult", async () => {
      const result = await deepReadinessService.checkDatabase();
      expect(result).toMatchObject({
        status: expect.stringMatching(/healthy|unhealthy/),
        checkedAt: expect.any(String),
      });
    });
  });

  describe("checkCache", () => {
    it("should return a DependencyResult", async () => {
      const result = await deepReadinessService.checkCache();
      expect(result).toMatchObject({
        status: expect.stringMatching(/healthy|unhealthy/),
        checkedAt: expect.any(String),
      });
    });
  });

  describe("checkOutboxLag", () => {
    it("should return an OutboxLagResult with numeric counters", async () => {
      const result = await deepReadinessService.checkOutboxLag();
      expect(result).toMatchObject({
        status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
        checkedAt: expect.any(String),
        pendingEvents: expect.any(Number),
        failedEvents: expect.any(Number),
        deadLetterEvents: expect.any(Number),
      });
    });
  });

  describe("checkWorkerHeartbeats", () => {
    it("should return an array of WorkerHeartbeatResult", async () => {
      const results = await deepReadinessService.checkWorkerHeartbeats();
      expect(Array.isArray(results)).toBe(true);
      for (const r of results) {
        expect(r).toMatchObject({
          workerName: expect.any(String),
          status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
          checkedAt: expect.any(String),
          reachable: expect.any(Boolean),
        });
      }
    });
  });

  describe("checkExternalProviders", () => {
    it("should return an array (empty when table is missing)", async () => {
      const results = await deepReadinessService.checkExternalProviders();
      expect(Array.isArray(results)).toBe(true);
      for (const r of results) {
        expect(r).toMatchObject({
          providerKey: expect.any(String),
          displayName: expect.any(String),
          status: expect.stringMatching(/healthy|degraded|unhealthy|unknown/),
          checkedAt: expect.any(String),
        });
      }
    });
  });
});
