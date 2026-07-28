import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/api/**/*.test.ts",
      "tests/services/**/*.test.ts",
      "tests/workers/**/*.test.ts",
      "tests/jobs/**/*.test.ts",
      "tests/testing/**/*.test.ts",
      "tests/contracts/**/*.test.ts",
    ],
    // These API suites boot the real Fastify server (buildServer) and/or open
    // live Postgres/Redis connections. They are integration tests, not unit
    // tests, so they are excluded from the unit run. Run them against a real
    // database via the integration config / a DB-backed CI job.
    exclude: [
      "tests/api/smoke.test.ts",
      "tests/api/analytics.test.ts",
      "tests/api/circuitBreaker.test.ts",
      "tests/api/exports.test.ts",
      // Needs live Redis + Postgres (health/ready endpoint hits both).
      "tests/api/health.test.ts",
      "node_modules/**",
    ],
    fileParallelism: false,
  },
});
