/**
 * Unit tests for the Zod-validated config loader (src/config/index.ts).
 *
 * The module is re-imported fresh for each scenario via vi.resetModules() so
 * that each test controls exactly which env vars are present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal set of env vars that satisfies the schema with no required fields. */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: "test",
  POSTGRES_HOST: "localhost",
  POSTGRES_PORT: "5432",
  POSTGRES_DB: "bridge_watch_test",
  POSTGRES_USER: "bridge_watch",
  POSTGRES_PASSWORD: "test_password",
  REDIS_HOST: "localhost",
  REDIS_PORT: "6379",
};

async function loadConfig(env: Record<string, string>) {
  // Patch process.env before importing the module
  Object.assign(process.env, env);

  // Each call gets a fresh module so Zod re-validates
  const mod = await import("../../src/config/index.js?" + Date.now());
  return mod.config;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config loader", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Snapshot the original env so we can restore it afterwards
    originalEnv = { ...process.env };

    // Clear everything so tests start from a known state
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }

    // Spy on process.exit and stderr so we can assert without crashing
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    vi.resetModules();
  });

  afterEach(() => {
    // Restore original environment
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.resetModules();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("parses a minimal valid environment without errors", async () => {
    const cfg = await loadConfig({ ...BASE_ENV });

    expect(cfg.NODE_ENV).toBe("test");
    expect(cfg.PORT).toBe(3001);          // default
    expect(cfg.POSTGRES_HOST).toBe("localhost");
    expect(cfg.REDIS_PORT).toBe(6379);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("applies all documented defaults", async () => {
    const cfg = await loadConfig({ ...BASE_ENV });

    expect(cfg.STELLAR_NETWORK).toBe("testnet");
    expect(cfg.LOG_LEVEL).toBe("info");
    expect(cfg.RATE_LIMIT_MAX).toBe(100);
    expect(cfg.EXPORT_STORAGE_PATH).toBe("./exports");
    expect(cfg.CORRELATION_THRESHOLD).toBe(0.6);
    expect(cfg.RECONCILIATION_INTERVAL_MS).toBe(600_000);
    expect(cfg.SOURCE_DECOMMISSION_CHECK_INTERVAL_MS).toBe(3_600_000);
    expect(cfg.PROVIDER_BREAKER_PROBE_INTERVAL_MS).toBe(30_000);
    expect(cfg.REPORT_DIR).toBe("./reports");
    expect(cfg.ARCHIVE_DIR).toBe("./archives");
  });

  it("coerces string numbers to numeric types", async () => {
    const cfg = await loadConfig({ ...BASE_ENV, PORT: "4000", REDIS_PORT: "6380" });

    expect(cfg.PORT).toBe(4000);
    expect(typeof cfg.PORT).toBe("number");
    expect(cfg.REDIS_PORT).toBe(6380);
  });

  it("coerces string booleans to boolean types", async () => {
    // Zod coerce.boolean: non-empty string → true, "0"/"false" → false
    const cfg = await loadConfig({ ...BASE_ENV, LOG_REQUEST_BODY: "true" });

    expect(cfg.LOG_REQUEST_BODY).toBe(true);
    expect(typeof cfg.LOG_REQUEST_BODY).toBe("boolean");
  });

  it("accepts all valid NODE_ENV values", async () => {
    for (const env of ["development", "production", "test", "sandbox"] as const) {
      vi.resetModules();
      const cfg = await loadConfig({ ...BASE_ENV, NODE_ENV: env });
      expect(cfg.NODE_ENV).toBe(env);
    }
  });

  it("accepts valid STELLAR_NETWORK values", async () => {
    for (const net of ["testnet", "mainnet"] as const) {
      vi.resetModules();
      const cfg = await loadConfig({ ...BASE_ENV, STELLAR_NETWORK: net });
      expect(cfg.STELLAR_NETWORK).toBe(net);
    }
  });

  // ── Optional / secret fields ───────────────────────────────────────────────

  it("allows optional secret fields to be absent", async () => {
    const cfg = await loadConfig({ ...BASE_ENV });

    expect(cfg.JWT_SECRET).toBeUndefined();
    expect(cfg.CONFIG_ENCRYPTION_KEY).toBeUndefined();
    expect(cfg.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(cfg.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(cfg.SMTP_PASSWORD).toBeUndefined();
    expect(cfg.CIRCLE_API_KEY).toBeUndefined();
    expect(cfg.ONEINCH_API_KEY).toBeUndefined();
    expect(cfg.COINMARKETCAP_API_KEY).toBeUndefined();
    expect(cfg.COINGECKO_API_KEY).toBeUndefined();
  });

  it("accepts secret fields when provided", async () => {
    const cfg = await loadConfig({
      ...BASE_ENV,
      JWT_SECRET: "a-very-long-secret-key-for-testing-purposes-here",
      CONFIG_ENCRYPTION_KEY: "another-very-long-encryption-key-32chars!",
    });

    expect(cfg.JWT_SECRET).toBeDefined();
    expect(cfg.CONFIG_ENCRYPTION_KEY).toBeDefined();
  });

  // ── Validation failures ────────────────────────────────────────────────────

  it("exits with code 1 when NODE_ENV is an invalid enum value", async () => {
    await loadConfig({ ...BASE_ENV, NODE_ENV: "staging" });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when PORT is not a number", async () => {
    await loadConfig({ ...BASE_ENV, PORT: "not-a-number" });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when STELLAR_NETWORK is invalid", async () => {
    await loadConfig({ ...BASE_ENV, STELLAR_NETWORK: "rinkeby" });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when LOG_LEVEL is invalid", async () => {
    await loadConfig({ ...BASE_ENV, LOG_LEVEL: "verbose" });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when STELLAR_HORIZON_URL is not a URL", async () => {
    await loadConfig({ ...BASE_ENV, STELLAR_HORIZON_URL: "not-a-url" });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Secret redaction ───────────────────────────────────────────────────────

  it("does not log secret values in the error output", async () => {
    const secretValue = "super-secret-password-should-not-appear";
    await loadConfig({
      ...BASE_ENV,
      NODE_ENV: "invalid-env",          // trigger a validation error
      POSTGRES_PASSWORD: secretValue,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);

    // The secret value must never appear in any stderr output
    const stderrCalls = stderrSpy.mock.calls
      .map((args) => String(args[0]))
      .join("");

    expect(stderrCalls).not.toContain(secretValue);
    // The field name should appear so the operator knows which field is affected
    expect(stderrCalls).toContain("[config]");
  });

  // ── SUPPORTED_ASSETS ───────────────────────────────────────────────────────

  it("exports SUPPORTED_ASSETS with correct structure", async () => {
    const { SUPPORTED_ASSETS } = await import("../../src/config/index.js?" + Date.now());

    expect(Array.isArray(SUPPORTED_ASSETS)).toBe(true);
    expect(SUPPORTED_ASSETS.length).toBeGreaterThan(0);

    for (const asset of SUPPORTED_ASSETS) {
      expect(asset).toHaveProperty("code");
      expect(asset).toHaveProperty("issuer");
      if (asset.issuer !== "native") {
        expect(asset.issuer).toHaveLength(56);
      }
    }
  });
});
