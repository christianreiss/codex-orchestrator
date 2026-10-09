import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import { authPayloads, providerAccounts } from '../../db/schema.js';
import { ApiError, ServiceUnavailableError } from '../../http/errors.js';
import { readFleetEngineState, assertFleetEngineEnabledForAdmin } from '../engine-switch.js';
import { createGatewayBackends } from '../gateway-backends.js';
import { ProviderAccountsService } from '../provider-accounts.js';
import { createRunnerValidationService } from '../runner-validation.js';
import { createRunnerClient } from '../runner-client.js';
import { createGrokAuthOwner } from '../grok-auth-owner.js';
import { SettingsService } from '../settings.js';
import { inspectCredential } from '../auth-generation.js';
import {
  CHATTY_PROTOCOL,
  modelResponseSchema,
  type ChattySelection,
  type ChattySettings,
} from './contracts.js';
import type { Engine } from '../../util/engine.js';

export interface EngineAvailability {
  engine: Engine;
  ready: boolean;
  reason: string | null;
  models: Array<{ id: string; display_name: string }>;
  default_model: string | null;
}
export class ChattyInference {
  private backends;
  private capabilitiesCache: { until: number; engines: string[] } | null = null;
  private cooldown = new Map<string, number>();
  constructor(
    private ctx: RouteContext,
    private request: typeof fetch = fetch,
  ) {
    this.backends = createGatewayBackends(ctx);
  }
  private url(path: string) {
    const base = this.ctx.env.AUTH_RUNNER_URL;
    if (!base) throw new ServiceUnavailableError('Runner not configured', 'runner_unavailable');
    return new URL(`chatty/${path}`, new URL(base)).toString();
  }
  private headers() {
    return {
      'content-type': 'application/json',
      'x-runner-auth': this.ctx.env.AUTH_RUNNER_SHARED_SECRET ?? '',
    };
  }
  async runnerEngines(): Promise<string[]> {
    if (this.capabilitiesCache && this.capabilitiesCache.until > Date.now())
      return this.capabilitiesCache.engines;
    const res = await this.request(this.url('capabilities'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok)
      throw new ServiceUnavailableError('Chatty runner unavailable or incompatible', 'runner_unavailable');
    const payload = (await res.json()) as { protocol?: number; engines?: string[] };
    if (payload.protocol !== CHATTY_PROTOCOL || !Array.isArray(payload.engines))
      throw new ServiceUnavailableError('Chatty runner protocol mismatch', 'runner_incompatible');
    this.capabilitiesCache = { until: Date.now() + 30000, engines: payload.engines };
    return payload.engines;
  }
  async availability(settings: ChattySettings): Promise<EngineAvailability[]> {
    const flags = await readFleetEngineState(this.ctx.db);
    const candidates = await this.ctx.db
      .select({ id: providerAccounts.id, engine: providerAccounts.engine })
      .from(providerAccounts)
      .innerJoin(authPayloads, eq(authPayloads.id, providerAccounts.payloadId))
      .where(and(eq(providerAccounts.state, 'enabled'), eq(authPayloads.verificationState, 'verified')));
    let runner: string[] = [];
    try {
      if (settings.enabled && candidates.length) runner = await this.runnerEngines();
    } catch {
      /* status carries the cause without leaking transport details */
    }
    const accounts = new ProviderAccountsService(this.ctx.db, this.ctx.keyring);
    const policy = new SettingsService(this.ctx.db);
    const hardFail = await policy.getFlag('quota_hard_fail', false);
    const threshold = await policy.getInt('quota_limit_percent', 100);
    const eligible = new Set<Engine>();
    const authenticated = new Set<Engine>();
    const expired = new Set<Engine>();
    const validation = createRunnerValidationService({ db: this.ctx.db, keyring: this.ctx.keyring });
    for (const a of candidates) {
      const canonical = await validation.resolveCanonicalPayload(a.engine as Engine, a.id);
      const auth = canonical && validation.canonicalAuthFromPayload(canonical);
      if (!auth) continue;
      if (accessExpired(auth, a.engine as Engine)) {
        expired.add(a.engine as Engine);
        continue;
      }
      authenticated.add(a.engine as Engine);
      const usage = await accounts.usage(a.id, a.engine as Engine);
      const over = quotaExhausted(usage, threshold);
      if (!hardFail || !over) eligible.add(a.engine as Engine);
    }
    return Promise.all(
      settings.engine_order.map(async (engine) => {
        const backend = this.backends.get(engine);
        const models = await backend.models.catalog();
        let defaultModel: string | null = null;
        try {
          defaultModel = await backend.models.resolve(undefined);
        } catch {
          /* no enabled model */
        }
        const reason = !settings.enabled
          ? 'chatty_disabled'
          : !flags[engine]
            ? 'engine_disabled'
            : !candidates.some((a) => a.engine === engine)
              ? 'verified_account_required'
              : !authenticated.has(engine)
                ? expired.has(engine)
                  ? 'credential_expired'
                  : 'canonical_auth_unavailable'
                : !eligible.has(engine)
                  ? 'quota_exhausted'
                  : !runner.includes(engine)
                    ? 'runner_unavailable'
                    : !models.length || !defaultModel
                      ? 'model_unavailable'
                      : (this.cooldown.get(engine) ?? 0) > Date.now()
                        ? 'provider_temporarily_unavailable'
                        : null;
        return {
          engine,
          models: models.map(({ id, display_name }) => ({ id, display_name })),
          default_model: defaultModel,
          ready: !reason,
          reason,
        };
      }),
    );
  }
  async run(
    prompt: string,
    selection: ChattySelection,
    settings: ChattySettings,
    signal: AbortSignal,
    preferred?: Engine,
  ) {
    const available = await this.availability(settings);
    const choices = available.filter((v) => v.ready && (!selection.engine || selection.engine === v.engine));
    if (!selection.engine && preferred)
      choices.sort((a, b) => Number(b.engine === preferred) - Number(a.engine === preferred));
    if (!choices.length)
      throw new ServiceUnavailableError(
        'No usable AI access. Check Chatty status and provider accounts.',
        'chatty_unavailable',
      );
    for (const choice of choices) {
      signal.throwIfAborted();
      const engine = choice.engine;
      const model = await this.backends
        .get(engine)
        .models.resolve(selection.engine ? selection.model : choice.default_model);
      const accounts = new ProviderAccountsService(this.ctx.db, this.ctx.keyring);
      const validation = createRunnerValidationService({ db: this.ctx.db, keyring: this.ctx.keyring });
      const leaseId = randomUUID();
      let leased = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        await assertFleetEngineEnabledForAdmin(this.ctx.db, engine);
        const threshold = await new SettingsService(this.ctx.db).getInt('quota_limit_percent', 100);
        const lease = await accounts.acquire(0, engine, leaseId, leaseId, threshold);
        leased = true;
        const usage = await accounts.usage(lease.account.id, engine);
        const hardFail = await new SettingsService(this.ctx.db).getFlag('quota_hard_fail', false);
        if (hardFail && quotaExhausted(usage, threshold))
          throw new ServiceUnavailableError('Selected account quota is exhausted', 'quota_exhausted');
        timer = setInterval(() => {
          void accounts.heartbeat(0, engine, leaseId).catch(() => {});
        }, 30000);
        timer.unref();
        let auth: unknown;
        if (engine === 'grok') {
          const owner = createGrokAuthOwner({
            db: this.ctx.db,
            keyring: this.ctx.keyring,
            runner: createRunnerClient({ env: this.ctx.env }),
          });
          auth = (
            await owner.ensureFresh({
              accountId: lease.account.id,
              minValiditySeconds: settings.timeout_seconds + 300,
            })
          ).auth;
        } else {
          const row = await validation.resolveCanonicalPayload(engine, lease.account.id);
          auth = row ? validation.canonicalAuthFromPayload(row) : null;
        }
        if (!auth)
          throw new ServiceUnavailableError(
            'Selected account has no usable credentials',
            'account_unavailable',
          );
        if (accessExpired(auth as Record<string, unknown>, engine))
          throw new ServiceUnavailableError('Selected account access has expired', 'credential_expired');
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await this.request(this.url('turn'), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
              protocol: CHATTY_PROTOCOL,
              engine,
              model,
              auth_json: auth,
              prompt: attempt
                ? `${prompt}\nYour previous output was invalid. Return exactly one valid JSON object matching the specified protocol.`
                : prompt,
              timeout_seconds: settings.timeout_seconds,
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout((settings.timeout_seconds + 5) * 1000)]),
          });
          if (!response.ok) {
            const error = await response.text();
            if (attempt === 0 && error.includes('chatty_invalid_output')) continue;
            throw new ApiError('Chatty provider request failed', {
              status: 502,
              code: response.status === 429 ? 'chatty_runner_busy' : 'chatty_provider_failed',
            });
          }
          const wire = (await response.json()) as { protocol: number; response: unknown };
          const parsed = modelResponseSchema.safeParse(wire.response);
          if (wire.protocol === CHATTY_PROTOCOL && parsed.success)
            return { response: parsed.data, engine, model, fallback: engine !== choices[0]!.engine };
          lastError = new Error('Chatty returned an invalid response');
        }
        throw lastError;
      } catch (error) {
        signal.throwIfAborted();
        this.cooldown.set(engine, Date.now() + 30000);
        if (selection.engine || choice === choices.at(-1)) throw error;
      } finally {
        if (timer) clearInterval(timer);
        if (leased) await accounts.release(0, engine, leaseId).catch(() => {});
      }
    }
    throw new ServiceUnavailableError('Chatty could not select a provider', 'chatty_unavailable');
  }
}

function accessExpired(auth: Record<string, unknown>, engine: Engine) {
  const expiry = inspectCredential(auth, engine)?.accessExpiresAt;
  return !!expiry && Date.parse(expiry) <= Date.now();
}

export function quotaExhausted(usage: unknown, threshold: number, at = Date.now()): boolean {
  const data = usage as Record<string, unknown>;
  return [
    ['short_used_percent', 'short_resets_at'],
    ['weekly_used_percent', 'weekly_resets_at'],
  ].some(
    ([p, r]) =>
      typeof data[p!] === 'number' &&
      Number(data[p!]) >= threshold &&
      (!data[r!] || Date.parse(String(data[r!])) > at),
  );
}
