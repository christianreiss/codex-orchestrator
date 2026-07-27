import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Parses .env from the project root (one directory above /api). Process env
 * always wins over .env values. Required values fail fast with a structured
 * error listing every missing var.
 */

function loadDotEnv(): void {
  const envFile = process.env.ENV_FILE ?? resolve(import.meta.dirname, '..', '..', '.env');
  if (!existsSync(envFile)) return;
  const raw = readFileSync(envFile, 'utf8');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = v.toLowerCase().trim();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  });

const intish = (def?: number) =>
  z
    .union([z.string(), z.number(), z.undefined()])
    .transform((v) => {
      if (v === undefined || v === '') return def;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : def;
    })
    .pipe(z.number().int().or(z.undefined()));

const schema = z
  .object({
    NODE_ENV: z.string().default('production'),
    APP_ENV: z.string().default('production'),

    LISTEN_HOST: z.string().default('0.0.0.0'),
    LISTEN_PORT: intish(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: boolish.default(false),
    STATIC_ROOT: z.string().default(resolve(import.meta.dirname, '..', '..', 'public', 'admin')),

    DB_HOST: z.string().default('mysql'),
    DB_PORT: intish(3306).pipe(z.number().int()),
    DB_DATABASE: z.string(),
    DB_USERNAME: z.string(),
    DB_PASSWORD: z.string(),
    DB_CHARSET: z.string().default('utf8mb4'),
    DB_POOL_SIZE: intish(10),

    // Encryption (kept compatible with legacy AUTH_ENCRYPTION_KEY / KEYS / ACTIVE_KID)
    ENCRYPTION_ACTIVE_KEY: z.string().optional(),
    ENCRYPTION_KEYS: z.string().optional(),
    ENCRYPTION_ACTIVE_KID: z.string().optional(),
    AUTH_ENCRYPTION_KEY: z.string().optional(),
    AUTH_ENCRYPTION_KEYS: z.string().optional(),
    AUTH_ENCRYPTION_ACTIVE_KID: z.string().optional(),

    // Runner
    AUTH_RUNNER_URL: z.string().optional(),
    AUTH_RUNNER_SHARED_SECRET: z.string().optional(),
    AUTH_RUNNER_TIMEOUT: intish(8),
    AUTH_RUNNER_CODEX_BASE_URL: z.string().optional(),
    AUTH_RUNNER_IP_BYPASS: boolish.default(false),
    AUTH_RUNNER_BYPASS_SUBNETS: z.string().default(''),
    AUTH_RUNNER_PREFLIGHT_SECONDS: intish(28800),
    // Start-side launch-gate freshness: when a wrapper retrieves auth and the
    // served canonical was last runner-verified longer ago than this, the
    // background auth-verification worker refreshes it. Host startup reads the
    // stored verdict and never waits on a live runner probe.
    AUTH_RUNNER_VERIFY_TTL_SECONDS: intish(900),
    AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS: intish(300),
    AUTH_SEED_TOKEN_TTL_SECONDS: intish(900),

    // Admin
    ADMIN_ACCESS_MODE: z.enum(['mtls', 'cookie', 'open']).default('mtls'),
    ADMIN_SESSION_COOKIE: z.string().default('codex_admin_session'),
    ADMIN_SESSION_TTL_MINUTES: intish(60 * 24 * 30),
    ADMIN_WS_ENABLED: boolish.default(false),
    ADMIN_WS_PUBLIC_URL: z.string().optional(),
    ADMIN_WS_HEARTBEAT_SECONDS: intish(30),
    ADMIN_WS_BACKLOG_LIMIT: intish(200),
    ADMIN_WEBAUTHN_RP_ID: z.string().optional(),
    ADMIN_WEBAUTHN_ORIGIN: z.string().optional(),
    ADMIN_WEBAUTHN_RP_NAME: z.string().default('Codex Orchestrator'),

    // Public base URL
    PUBLIC_BASE_URL: z.string().optional(),
    PUBLIC_BASE_URL_REQUIRED: boolish.default(true),
    CODEX_SYNC_BASE_URL: z.string().optional(),

    // Cross-site origins (comma-separated) allowed to make credentialed CORS
    // requests against admin/host routes. Empty by default: those routes are
    // same-origin only. Does not affect /v1 and /anthropic/v1, which stay
    // open to any origin regardless of this setting.
    CORS_ALLOWED_ORIGINS: z.string().default(''),

    // Proxy trust
    TRUST_X_FORWARDED: boolish.default(false),
    TRUSTED_PROXY_CIDRS: z.string().default(''),

    // Behavior toggles
    STRICT_HOST_VALIDATION: boolish.default(true),
    MCP_ALLOW_REQUEST_HOST_ORIGIN: boolish.default(false),
    INSECURE_GRACE_MINUTES: intish(60),
    // Schema convergence. On by default: the API applies every pending file in
    // db/migrations before it opens a listener. Turning it off does not turn
    // off the *check* — boot still fails when a migration is pending, because a
    // schema the code does not expect is worse than a refused start.
    RUN_MIGRATIONS_ON_BOOT: boolish.default(true),
    // Seconds to wait for the migration advisory lock when several API
    // instances boot at once. A FULLTEXT build on a populated table can take a
    // while, so this is deliberately longer than a healthcheck window.
    MIGRATIONS_LOCK_TIMEOUT: intish(120),
    // Escape hatch for a non-standard layout; empty means "next to the bundle".
    MIGRATIONS_DIR: z.string().optional(),
    RUN_BACKFILLS_ON_BOOT: boolish.default(false),

    // MCP operator-capability auth + filesystem tools.
    // When MCP_OPERATOR_TOKEN is set, requests presenting `Authorization:
    // Bearer <token>` matching it are granted operator capability (full tool
    // registry). All other authenticated callers stay at host capability.
    MCP_OPERATOR_TOKEN: z.string().optional(),
    // fs_* tools are only registered when MCP_FS_ROOT resolves to an existing
    // directory. Every path argument is confined to this root after symlink
    // resolution.
    MCP_FS_ROOT: z.string().optional(),
    MCP_FS_MAX_READ_BYTES: intish(1024 * 1024),
    MCP_FS_MAX_LIST_ENTRIES: intish(1000),
    MCP_FS_MAX_SEARCH_HITS: intish(200),

    // Default engines
    DEFAULT_HOST_ENGINES: z.string().default('codex'),

    // Pricing
    GPT51_CACHED_PER_1K: z.string().optional(),
    GPT51_INPUT_PER_1K: z.string().optional(),
    GPT51_OUTPUT_PER_1K: z.string().optional(),
    PRICING_URL: z.string().optional(),
    PRICING_CURRENCY: z.string().default('USD'),
    CHATGPT_PLUS_PLAN_COST: z.string().optional(),
    CHATGPT_PRO_PLAN_COST: z.string().optional(),

    // Claude pricing
    CLAUDE_OPUS_CACHED_PER_1K: z.string().optional(),
    CLAUDE_OPUS_INPUT_PER_1K: z.string().optional(),
    CLAUDE_OPUS_OUTPUT_PER_1K: z.string().optional(),
    CLAUDE_SONNET_CACHED_PER_1K: z.string().optional(),
    CLAUDE_SONNET_INPUT_PER_1K: z.string().optional(),
    CLAUDE_SONNET_OUTPUT_PER_1K: z.string().optional(),
    CLAUDE_HAIKU_CACHED_PER_1K: z.string().optional(),
    CLAUDE_HAIKU_INPUT_PER_1K: z.string().optional(),
    CLAUDE_HAIKU_OUTPUT_PER_1K: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),

    // Quota cron
    CHATGPT_USAGE_CRON_INTERVAL: intish(900),
    CHATGPT_BASE_URL: z.string().default('https://chatgpt.com/backend-api'),
    CHATGPT_USAGE_TIMEOUT: z
      .union([z.string(), z.number(), z.undefined()])
      .transform((v) => {
        if (v === undefined || v === '') return 10;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) && n > 0 ? n : 10;
      }),
    CHATGPT_USAGE_HEALTH_PATH: z.string().default('/tmp/chatgpt-usage-health.json'),
    CHATGPT_USAGE_HEALTH_MAX_AGE_SECONDS: intish(),

    INSTALLATION_ID: z.string().optional(),
    DATA_ROOT: z.string().optional(),

    // SMTP
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: intish(),
    SMTP_USERNAME: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    SMTP_SECURE: boolish.default(false),
  })
  .superRefine((env, ctx) => {
    const activeKey = env.ENCRYPTION_ACTIVE_KEY ?? env.AUTH_ENCRYPTION_KEY;
    if (!activeKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_ACTIVE_KEY'],
        message:
          'Either ENCRYPTION_ACTIVE_KEY or AUTH_ENCRYPTION_KEY must be set (32 raw bytes, base64-encoded)',
      });
    }
    if (env.AUTH_RUNNER_URL && !env.AUTH_RUNNER_SHARED_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_RUNNER_SHARED_SECRET'],
        message: 'AUTH_RUNNER_SHARED_SECRET is required when AUTH_RUNNER_URL is set',
      });
    }
    if (env.ADMIN_WEBAUTHN_RP_ID && !env.ADMIN_WEBAUTHN_ORIGIN) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_WEBAUTHN_ORIGIN'],
        message: 'ADMIN_WEBAUTHN_ORIGIN is required when ADMIN_WEBAUTHN_RP_ID is set',
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${messages}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
