/**
 * GET  /admin/doctor           — read-only system-health snapshot for the
 *                                 admin "Doctor" page.
 * POST /admin/doctor/test-key  — fires a minimal models-list request through
 *                                 the real OpenAI/Anthropic-compat auth path
 *                                 using a *pasted* key, never a stored one.
 *
 * Doctor has zero mutating controls: every row is read-only and any
 * remediation is a link (`owner_route`) to the page that already owns that
 * setting, never an inline control here.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ok } from '../../../http/reply.js';
import { ApiError } from '../../../http/errors.js';
import { createSetupStatusService, type SetupCheck } from '../../../services/setup-status.js';
import { SettingsService } from '../../../services/settings.js';
import { OpenAiKeyService } from '../../../services/openai-keys.js';
import { buildModelList } from '../../../services/openai-models.js';
import { createClaudeModelsService } from '../../../services/claude-models.js';
import { encrypt, decrypt } from '../../../security/secret-box.js';
import { nowIso } from '../../../util/timestamp.js';
import { ENGINE_CODEX, ENGINE_CLAUDE } from '../../../util/engine.js';

type DoctorStatus = 'ok' | 'warn' | 'fail';

interface DoctorRow {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  hint: string | null;
  owner_route: string | null;
}

interface DoctorResponse {
  generated_at: string;
  rows: DoctorRow[];
  hosts: { total: number; synced: number };
  canonical_auth: { codex: boolean; claude: boolean };
}

const API_KEYS_ROUTE = '/api-keys';

/**
 * The subset of `OpenAiKeyService` the doctor route needs — deliberately
 * narrow so a test double can prove `test-key` never reaches an id-based
 * lookup: nothing shaped like `findById` is even in this interface.
 */
type KeyLookup = Pick<OpenAiKeyService, 'findActiveByBearer' | 'touch' | 'listByEngine'>;

/** Truncates/collapses an error message the same way setup-status.ts's
 * private `safeError` does, so a raw internal error can't dump arbitrary
 * text into the admin UI. Duplicated locally — that helper isn't exported. */
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

function checkHint(check: SetupCheck): string | null {
  if (check.ok) return null;
  switch (check.id) {
    case 'migrations':
      return 'Run pending database migrations on the API host.';
    case 'runner':
      return 'Check AUTH_RUNNER_URL / AUTH_RUNNER_SHARED_SECRET and that the runner service is reachable.';
    case 'signer':
      return 'The wrapper signing key is generated automatically at boot; check server logs if this persists.';
    case 'wrappers':
      return 'Wrapper binary artifacts are missing or checksum-mismatched; rebuild/republish the wrapper bin registry.';
    case 'public_base_url':
      return "Set PUBLIC_BASE_URL to this server's externally reachable HTTPS origin.";
    default:
      return null;
  }
}

function setupCheckRow(check: SetupCheck): DoctorRow {
  return {
    id: check.id,
    label: check.label,
    status: check.ok ? 'ok' : 'fail',
    detail: check.detail,
    hint: checkHint(check),
    owner_route: null,
  };
}

async function keyringRow(ctx: RouteContext): Promise<DoctorRow> {
  const active = ctx.keyring.active();
  const configuredCount = ctx.keyring.all().length;
  const canaryPlaintext = `doctor-canary-${Date.now()}`;
  let canaryOk: boolean;
  try {
    const envelope = encrypt(canaryPlaintext, ctx.keyring);
    canaryOk = decrypt(envelope, ctx.keyring) === canaryPlaintext;
  } catch {
    canaryOk = false;
  }
  return {
    id: 'keyring',
    label: 'Encryption keyring',
    status: canaryOk ? 'ok' : 'fail',
    detail: canaryOk
      ? `active key '${active.kid}'; ${configuredCount} key(s) configured; canary round-trip passed`
      : `active key '${active.kid}'; ${configuredCount} key(s) configured; canary round-trip failed`,
    hint: canaryOk ? null : 'Encrypt/decrypt with the active key failed; check ENCRYPTION_ACTIVE_KEY / ENCRYPTION_KEYS.',
    owner_route: null,
  };
}

async function killSwitchRow(
  settings: SettingsService,
  id: string,
  label: string,
  flagName: string,
): Promise<DoctorRow> {
  const disabled = await settings.getFlag(flagName, false);
  return {
    id,
    label,
    // A disabled switch is an intentional admin action, not a fault.
    status: disabled ? 'warn' : 'ok',
    detail: disabled ? `${label} is disabled by administrator` : `${label} is enabled`,
    hint: disabled ? 'Re-enable from API Keys if this was not intended.' : null,
    owner_route: API_KEYS_ROUTE,
  };
}

async function issuedKeysRow(
  keys: KeyLookup,
  id: string,
  label: string,
  engine: typeof ENGINE_CODEX | typeof ENGINE_CLAUDE,
): Promise<DoctorRow> {
  const rows = await keys.listByEngine(engine);
  const active = rows.filter((row) => row.isActive === 1).length;
  const total = rows.length;
  return {
    id,
    label,
    status: 'ok',
    detail: `${active} active / ${total} total`,
    hint: null,
    owner_route: API_KEYS_ROUTE,
  };
}

interface TestKeyResult {
  ok: boolean;
  status: number | null;
  latency_ms: number;
  model_count?: number;
  error?: string;
}

/**
 * Resolves `key` exactly as `/v1/*`'s Bearer-auth preHandler would: hash it,
 * look up an active row scoped to `engine`, hit the same rate-limit bucket,
 * and bump `use_count` on success. Never looks a key up by id — the pasted
 * string is the only input that can produce a match.
 */
async function testEngineKey(
  ctx: RouteContext,
  app: FastifyInstance,
  req: FastifyRequest,
  keys: KeyLookup,
  engine: typeof ENGINE_CODEX | typeof ENGINE_CLAUDE,
  disabledFlag: string,
  disabledLabel: string,
  rateLimitBucketPrefix: string,
  key: string,
): Promise<TestKeyResult> {
  const start = Date.now();
  const settings = new SettingsService(ctx.db);
  if (await settings.getFlag(disabledFlag, false)) {
    return {
      ok: false,
      status: 503,
      latency_ms: Date.now() - start,
      error: `${disabledLabel} is disabled by administrator.`,
    };
  }

  const record = await keys.findActiveByBearer(key, engine);
  if (!record) {
    return {
      ok: false,
      status: 401,
      latency_ms: Date.now() - start,
      error: 'Incorrect API key provided.',
    };
  }

  const rpm = record.rateLimitRpm > 0 ? record.rateLimitRpm : 60;
  const limited = await app.rateLimiter.hit(req.clientIp || '0.0.0.0', `${rateLimitBucketPrefix}:${record.id}`, {
    limit: rpm,
    windowSeconds: 60,
  });
  if (!limited.ok) {
    return {
      ok: false,
      status: 429,
      latency_ms: Date.now() - start,
      error: 'Rate limit exceeded. Please retry shortly.',
    };
  }

  // Unlike the hot proxy path (which fire-and-forgets this to keep client
  // latency down), this is an on-demand diagnostic call whose whole point is
  // reporting latency truthfully — await it so "increments use_count" is an
  // observable fact by the time the response is sent, not a race.
  await keys.touch(record.id);

  try {
    const modelCount =
      engine === ENGINE_CODEX
        ? buildModelList().data.length
        : (await createClaudeModelsService(ctx.db).modelsResponse()).data.length;
    return { ok: true, status: 200, latency_ms: Date.now() - start, model_count: modelCount };
  } catch (error) {
    return { ok: false, status: null, latency_ms: Date.now() - start, error: safeError(error) };
  }
}

const testKeySchema = z.object({
  engine: z.enum(['openai', 'claude']),
  key: z.string().trim().min(1, 'key is required'),
});

/** Optional test seam — mirrors `OpenAiCompatOverrides` in `routes/v1/index.ts`. */
export interface AdminDoctorOverrides {
  keys?: KeyLookup;
}

export async function registerAdminDoctorRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  overrides: AdminDoctorOverrides = {},
): Promise<void> {
  const setupStatus = createSetupStatusService(ctx.db, ctx.env, ctx.keyring);
  const settings = new SettingsService(ctx.db);
  const keys = overrides.keys ?? new OpenAiKeyService({ db: ctx.db, keyring: ctx.keyring });

  app.get('/admin/doctor', {
    preHandler: [app.requireAdmin],
    handler: async () => {
      // keyringRow needs no database access, so it's collected unconditionally —
      // it stays informative even during a DB outage, which is exactly the kind
      // of moment this page exists for.
      const rows: DoctorRow[] = [await keyringRow(ctx)];
      let hosts = { total: 0, synced: 0 };
      let canonicalAuth = { codex: false, claude: false };

      try {
        const status = await setupStatus.status();
        rows.push(
          ...status.checks.map(setupCheckRow),
          await killSwitchRow(settings, 'kill_switch_master', 'Master API kill switch', 'api_disabled'),
          await killSwitchRow(settings, 'kill_switch_openai', 'OpenAI kill switch', 'openai_api_disabled'),
          await killSwitchRow(settings, 'kill_switch_claude', 'Claude kill switch', 'claude_api_disabled'),
          await issuedKeysRow(keys, 'keys_openai', 'OpenAI issued keys', ENGINE_CODEX),
          await issuedKeysRow(keys, 'keys_claude', 'Claude issued keys', ENGINE_CLAUDE),
        );
        hosts = status.hosts;
        canonicalAuth = status.canonical_auth;
      } catch (error) {
        // A page whose job is diagnosing outages must not itself 500 when the
        // database is the thing that's down — report the failure as a row.
        rows.push({
          id: 'doctor_status',
          label: 'Doctor status collection',
          status: 'fail',
          detail: safeError(error),
          hint: 'The underlying status/database queries failed; check API server logs and database connectivity.',
          owner_route: null,
        });
      }

      const response: DoctorResponse = {
        generated_at: nowIso(),
        rows,
        hosts,
        canonical_auth: canonicalAuth,
      };
      return ok(response);
    },
  });

  app.post('/admin/doctor/test-key', {
    preHandler: [app.requireAdmin],
    handler: async (req) => {
      const parsed = testKeySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ApiError(first?.message ?? 'Invalid request body', {
          status: 400,
          code: 'invalid_request',
          type: 'invalid_request_error',
          param: first?.path?.join('.'),
        });
      }
      // Only `engine` and `key` are ever read from the body — any other field
      // (e.g. an id) is dropped by zod's default strip behavior above and
      // never reaches a lookup.
      const { engine, key } = parsed.data;
      const result =
        engine === 'openai'
          ? await testEngineKey(ctx, app, req, keys, ENGINE_CODEX, 'openai_api_disabled', 'OpenAI API', 'openai', key)
          : await testEngineKey(ctx, app, req, keys, ENGINE_CLAUDE, 'claude_api_disabled', 'Claude API', 'anthropic', key);
      return ok(result);
    },
  });
}
