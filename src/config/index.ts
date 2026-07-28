import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------------------
// Secret fields — values are NEVER logged during validation failures.
// Only field *names* appear in error output.
// ---------------------------------------------------------------------------
const SECRET_FIELDS = new Set([
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
  "JWT_SECRET",
  "CONFIG_ENCRYPTION_KEY",
  "API_KEY_BOOTSTRAP_TOKEN",
  "CIRCLE_API_KEY",
  "COINBASE_API_KEY",
  "COINBASE_API_SECRET",
  "ONEINCH_API_KEY",
  "COINMARKETCAP_API_KEY",
  "COINGECKO_API_KEY",
  "SMTP_PASSWORD",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "WS_AUTH_SECRET",
  "REPORT_SIGNING_KEY_PATH",
]);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test", "sandbox"])
    .default("development"),
  PORT: z.coerce.number().default(3001),
  WS_PORT: z.coerce.number().default(3002),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(30_000),

  // CORS — comma-separated list of allowed origins for production
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // PostgreSQL + TimescaleDB
  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_DB: z.string().default("bridge_watch"),
  POSTGRES_USER: z.string().default("bridge_watch"),
  POSTGRES_PASSWORD: z.string().default("bridge_watch_dev"),

  // Redis
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().default(""),
  // Set to "true" in production to enable Redis Cluster mode
  REDIS_CLUSTER: z.string().optional(),

  // Security — required keys for JWT signing and config encryption
  JWT_SECRET: z.string().min(32).optional(),
  CONFIG_ENCRYPTION_KEY: z.string().min(32).optional(),

  // Stellar
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  STELLAR_HORIZON_URL: z
    .string()
    .url()
    .default("https://horizon-testnet.stellar.org"),
  SOROBAN_RPC_URL: z
    .string()
    .url()
    .default("https://soroban-testnet.stellar.org"),
  SOROBAN_MAINNET_RPC_URL: z.string().url().optional(),
  CIRCUIT_BREAKER_CONTRACT_ID: z.string().optional(),
  LIQUIDITY_CONTRACT_ADDRESS: z.string().optional(),

  // Ethereum / EVM chains
  ETHEREUM_RPC_URL: z.string().url().optional(),
  ETHEREUM_RPC_WS_URL: z.string().url().optional(),
  ETHEREUM_RPC_FALLBACK_URL: z.string().url().optional(),
  RPC_PROVIDER_TYPE: z.enum(["http", "ws"]).default("http"),
  USDC_BRIDGE_ADDRESS: z.string().optional(),
  EURC_BRIDGE_ADDRESS: z.string().optional(),
  USDC_TOKEN_ADDRESS: z.string().optional(),
  EURC_TOKEN_ADDRESS: z.string().optional(),
  // Polygon
  POLYGON_RPC_URL: z.string().url().optional(),
  POLYGON_RPC_FALLBACK_URL: z.string().url().optional(),
  // Base
  BASE_RPC_URL: z.string().url().optional(),
  BASE_RPC_FALLBACK_URL: z.string().url().optional(),

  // External APIs
  CIRCLE_API_KEY: z.string().optional(),
  // Circle API base URL — use sandbox for non-production environments
  CIRCLE_API_URL: z.string().url().default("https://api.circle.com"),
  // Request timeout for Circle API calls (ms)
  CIRCLE_API_TIMEOUT_MS: z.coerce.number().default(5000),
  // Redis TTL for cached Circle price responses (seconds)
  CIRCLE_CACHE_TTL_SEC: z.coerce.number().default(60),
  // Circle API rate limiting: max requests per window
  CIRCLE_RATE_LIMIT_MAX: z.coerce.number().default(30),
  // Circle API rate limiting: window duration (ms)
  CIRCLE_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  COINBASE_API_KEY: z.string().optional(),
  COINBASE_API_SECRET: z.string().optional(),
  ONEINCH_API_KEY: z.string().optional(),
  COINMARKETCAP_API_KEY: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
  API_KEY_BOOTSTRAP_TOKEN: z.string().optional(),

  // Logging
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  LOG_FILE: z.string().optional(),
  LOG_MAX_FILE_SIZE: z.coerce.number().default(100 * 1024 * 1024), // 100MB
  LOG_MAX_FILES: z.coerce.number().default(10),
  LOG_RETENTION_DAYS: z.coerce.number().default(30),
  LOG_REQUEST_BODY: z.coerce.boolean().default(false),
  LOG_RESPONSE_BODY: z.coerce.boolean().default(false),
  LOG_SENSITIVE_DATA: z.coerce.boolean().default(false),
  REQUEST_SLOW_THRESHOLD_MS: z.coerce.number().default(1000),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  // Burst allowance as a fraction of RATE_LIMIT_MAX (0.1 = 10% extra)
  RATE_LIMIT_BURST_MULTIPLIER: z.coerce.number().min(0).default(0.1),
  // Comma-separated IPs that bypass rate limiting entirely
  RATE_LIMIT_WHITELIST_IPS: z.string().optional(),
  // Comma-separated API keys that bypass rate limiting entirely
  RATE_LIMIT_WHITELIST_KEYS: z.string().optional(),

  // Enhanced Rate Limiting Configuration
  RATE_LIMIT_ENABLE_DYNAMIC: z.coerce.boolean().default(true),
  RATE_LIMIT_GLOBAL_ALERT_THRESHOLD: z.coerce.number().default(0.9),
  RATE_LIMIT_BURST_ALERT_THRESHOLD: z.coerce.number().default(0.8),
  RATE_LIMIT_SUSTAINED_ALERT_THRESHOLD: z.coerce.number().default(0.7),
  RATE_LIMIT_STATS_RETENTION_HOURS: z.coerce.number().default(168), // 7 days
  RATE_LIMIT_ENABLE_MONITORING: z.coerce.boolean().default(true),
  RATE_LIMIT_ADMIN_API_KEY_PREFIX: z.string().default("admin_"),
  // Only set to "true" inside API test suites that exercise rate-limit behaviour
  ENABLE_RATE_LIMIT_IN_TESTS: z.string().optional(),

  // Per-endpoint rate limits (requests per window)
  RATE_LIMIT_ENDPOINT_ASSETS: z.coerce.number().default(200),
  RATE_LIMIT_ENDPOINT_BRIDGES: z.coerce.number().default(150),
  RATE_LIMIT_ENDPOINT_ALERTS: z.coerce.number().default(50),
  RATE_LIMIT_ENDPOINT_ANALYTICS: z.coerce.number().default(100),
  RATE_LIMIT_ENDPOINT_CONFIG: z.coerce.number().default(30),
  RATE_LIMIT_ENDPOINT_HEALTH: z.coerce.number().default(1000),

  // Alert Thresholds
  PRICE_DEVIATION_THRESHOLD: z.coerce.number().default(0.02),
  BRIDGE_SUPPLY_MISMATCH_THRESHOLD: z.coerce.number().default(0.1),
  HEALTH_SCORE_THRESHOLD: z.coerce.number().default(0.5),

  // Reconciliation Alerting
  // Default threshold (percentage points, same scale as mismatchPercentage)
  // above which a reconciliation discrepancy raises a routed/deduplicated
  // alert. Can be overridden per-asset via RECONCILIATION_ALERT_THRESHOLDS_JSON.
  RECONCILIATION_ALERT_THRESHOLD: z.coerce.number().default(0.1),
  // Optional per-asset/source override, e.g. '{"USDC":0.05,"EURC":0.2}'
  RECONCILIATION_ALERT_THRESHOLDS_JSON: z.string().optional(),
  // Synthetic owner id used when routing reconciliation alerts through
  // alertRoutingService.routeAlert(). This does not correspond to a real
  // user/wallet — it exists only so routing preference lookups have a key
  // to check against (they fall back to sane defaults when no preferences
  // row exists). Actual delivery is controlled by the global, owner_address
  // = null routing rule seeded in migration 039.
  RECONCILIATION_ALERT_OWNER: z.string().default("system:reconciliation"),
  // Dedup window used by AlertDeduplicationService when collapsing repeated
  // reconciliation mismatches into a single open incident.
  RECONCILIATION_ALERT_DEDUP_WINDOW_MS: z.coerce.number().default(10 * 60 * 1000),

  // Schema Drift Alerting
  // Synthetic owner id used when routing schema drift alerts through
  // alertRoutingService.routeAlert(). Delivery is controlled by the global,
  // owner_address = null routing rule seeded in migration 043.
  SCHEMA_DRIFT_ALERT_OWNER: z.string().default("system:schema-drift"),
  // Dedup window used by AlertDeduplicationService when collapsing repeated
  // schema drift alerts for the same provider/field into a single open
  // incident, escalating severity on repeat rather than re-alerting.
  SCHEMA_DRIFT_ALERT_DEDUP_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000),

  // Verification & Retries
  RETRY_MAX: z.coerce.number().default(3),
  BRIDGE_VERIFICATION_INTERVAL_MS: z.coerce.number().default(300000),

  // Price Aggregation
  HORIZON_TIMEOUT_MS: z.coerce.number().default(500),
  REDIS_CACHE_TTL_SEC: z.coerce.number().default(30),
  REDIS_PRICE_CACHE_PREFIX: z.string().default("price:aggregated"),

  // WebSocket — set to a strong random string in production
  WS_AUTH_SECRET: z.string().optional(),

  // Health Score Weights
  HEALTH_WEIGHT_LIQUIDITY: z.coerce.number().default(0.25),
  HEALTH_WEIGHT_PRICE: z.coerce.number().default(0.25),
  HEALTH_WEIGHT_BRIDGE: z.coerce.number().default(0.20),
  HEALTH_WEIGHT_RESERVES: z.coerce.number().default(0.20),
  HEALTH_WEIGHT_VOLUME: z.coerce.number().default(0.10),

  // Export Service
  EXPORT_STORAGE_PATH: z.string().default("./exports"),
  EXPORT_DOWNLOAD_URL_EXPIRY_HOURS: z.coerce.number().default(24),
  EXPORT_COMPRESSION_THRESHOLD_BYTES: z.coerce.number().default(1048576), // 1MB
  EXPORT_STREAMING_PAGE_SIZE: z.coerce.number().default(1000),
  EXPORT_QUEUE_CONCURRENCY: z.coerce.number().default(3),
  EXPORT_MAX_DATE_RANGE_DAYS: z.coerce.number().default(90),

  // Email Configuration
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM_ADDRESS: z.string().default("noreply@bridgewatch.io"),
  SMTP_FROM_NAME: z.string().default("Bridge Watch"),

  // Discord Bot Configuration
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),

  // Telegram Bot Configuration
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_RATE_LIMIT_OUTBOUND_GLOBAL_PER_SEC: z.coerce.number().default(30),
  TELEGRAM_RATE_LIMIT_OUTBOUND_PER_CHAT_PER_SEC: z.coerce.number().default(1),
  TELEGRAM_RATE_LIMIT_INBOUND_COMMANDS_PER_WINDOW: z.coerce.number().default(5),
  TELEGRAM_RATE_LIMIT_INBOUND_WINDOW_SEC: z.coerce.number().default(30),
  TELEGRAM_ADMIN_CHAT_IDS: z.string().optional(),
  TELEGRAM_BOT_ENABLED: z.coerce.boolean().default(true),

  // Health Check Configuration
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().default(5000),
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().default(30000),
  HEALTH_CHECK_MEMORY_THRESHOLD: z.coerce.number().default(90),
  HEALTH_CHECK_DISK_THRESHOLD: z.coerce.number().default(80),
  HEALTH_CHECK_EXTERNAL_APIS: z.string().default("true"),
  MAINTENANCE_MODE: z.coerce.boolean().default(false),
  MAINTENANCE_MESSAGE: z.string().default(""),
  MAINTENANCE_SEVERITY: z.enum(["info", "warning", "critical"]).default("info"),
  STATUS_PAGE_URL: z.string().url().optional(),

  // Data Validation Configuration
  VALIDATION_STRICT_MODE: z.coerce.boolean().default(false),
  VALIDATION_ADMIN_BYPASS: z.coerce.boolean().default(true),
  VALIDATION_BATCH_SIZE: z.coerce.number().default(100),
  VALIDATION_MAX_BATCH_SIZE: z.coerce.number().default(1000),
  VALIDATION_DUPLICATE_CHECK: z.coerce.boolean().default(true),
  VALIDATION_NORMALIZATION: z.coerce.boolean().default(true),
  VALIDATION_CONSISTENCY_CHECKS: z.coerce.boolean().default(true),
  VALIDATION_ERROR_THRESHOLD: z.coerce.number().default(0.1),
  VALIDATION_WARNING_THRESHOLD: z.coerce.number().default(0.3),
  VALIDATION_DATA_QUALITY_THRESHOLD: z.coerce.number().default(70),

  // Compliance Report Service
  REPORT_DIR: z.string().default("./reports"),
  ARCHIVE_DIR: z.string().default("./archives"),
  // Path to a PEM key used to sign compliance reports; optional
  REPORT_SIGNING_KEY_PATH: z.string().optional(),

  // Correlation / anomaly detection
  CORRELATION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),

  // Background job intervals
  RECONCILIATION_INTERVAL_MS: z.coerce.number().default(600_000),
  SOURCE_DECOMMISSION_CHECK_INTERVAL_MS: z.coerce.number().default(3_600_000),
  PROVIDER_BREAKER_PROBE_INTERVAL_MS: z.coerce.number().default(30_000),

  // BullMQ queue rate limiting (per priority level)
  QUEUE_RATE_MAX_CRITICAL: z.coerce.number().default(1000),
  QUEUE_RATE_DURATION_MS_CRITICAL: z.coerce.number().default(1000),
  QUEUE_RATE_MAX_HIGH: z.coerce.number().default(1000),
  QUEUE_RATE_DURATION_MS_HIGH: z.coerce.number().default(1000),
  QUEUE_RATE_MAX_NORMAL: z.coerce.number().default(1000),
  QUEUE_RATE_DURATION_MS_NORMAL: z.coerce.number().default(1000),
  QUEUE_RATE_MAX_LOW: z.coerce.number().default(1000),
  QUEUE_RATE_DURATION_MS_LOW: z.coerce.number().default(1000),
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface StellarAssetConfig {
  code: string;
  issuer: string;
  /**
   * Optional per-asset override for the reconciliation alert threshold
   * (percentage points, same scale as VerificationResult.mismatchPercentage).
   * Falls back to config.RECONCILIATION_ALERT_THRESHOLD, then to any value
   * supplied via RECONCILIATION_ALERT_THRESHOLDS_JSON, when not set here.
   */
  reconciliationAlertThreshold?: number;
}

function validateIssuerAddress(asset: StellarAssetConfig): void {
  if (asset.issuer !== "native" && asset.issuer.length !== 56) {
    throw new Error(
      `[config] Invalid issuer for ${asset.code}: expected 56 chars, got ${asset.issuer.length}`
    );
  }
}

export const SUPPORTED_ASSETS: StellarAssetConfig[] = [
  { code: "XLM",   issuer: "native" },
  { code: "USDC",  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { code: "PYUSD", issuer: "GBHZAE5IQTOPQZ66TFWZYIYCHQ6T3GMWHDKFEXAKYWJ2BHLZQ227KRYE" },
  { code: "EURC",  issuer: "GDQOE23CFSUMSVZZ4YRVXGW7PCFNIAHLMRAHDE4Z32DIBQGH4KZZK2KZ" },
  { code: "FOBXX", issuer: "GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5" },
];

SUPPORTED_ASSETS.forEach(validateIssuerAddress);

// ---------------------------------------------------------------------------
// Parse & validate
// ---------------------------------------------------------------------------
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Build a sanitised error message — secret values are never printed.
  const issues = parsed.error.issues.map((issue) => {
    const field = issue.path.join(".");
    const label = SECRET_FIELDS.has(field) ? `${field} (value hidden)` : field;
    return `  • ${label}: ${issue.message}`;
  });

  // Use process.stderr.write so the message appears even when the logger
  // hasn't been initialised yet, and avoids piping through pino.
  process.stderr.write(
    `\n[config] ❌ Invalid environment — startup aborted.\n` +
    `         Fix the following variables in your .env file or environment:\n\n` +
    issues.join("\n") +
    `\n\n         See .env.example for a full reference.\n\n`
  );
  process.exit(1);
}

export const config: EnvConfig = parsed.data;

/**
 * Resolves the reconciliation alert threshold for a given asset code, in this
 * order of precedence:
 *   1. SUPPORTED_ASSETS[].reconciliationAlertThreshold (per-asset, in code)
 *   2. RECONCILIATION_ALERT_THRESHOLDS_JSON (per-asset, via env)
 *   3. RECONCILIATION_ALERT_THRESHOLD (global default)
 */
export function getReconciliationAlertThreshold(assetCode: string): number {
  const assetConfig = SUPPORTED_ASSETS.find((a) => a.code === assetCode);
  if (assetConfig?.reconciliationAlertThreshold !== undefined) {
    return assetConfig.reconciliationAlertThreshold;
  }

  if (config.RECONCILIATION_ALERT_THRESHOLDS_JSON) {
    try {
      const overrides = JSON.parse(config.RECONCILIATION_ALERT_THRESHOLDS_JSON) as Record<
        string,
        number
      >;
      if (typeof overrides[assetCode] === "number") {
        return overrides[assetCode];
      }
    } catch {
      // Malformed override JSON — fall through to the global default rather
      // than throwing, since this must never block a reconciliation run.
    }
  }

  return config.RECONCILIATION_ALERT_THRESHOLD;
}