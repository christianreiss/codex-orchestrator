import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ValidationError } from '../../../http/errors.js';
import { ProviderAccountsService } from '../../../services/provider-accounts.js';
import { createPooledAuthStoreService } from '../../../services/pooled-auth-store.js';
import { createRunnerValidationService } from '../../../services/runner-validation.js';
import { createRunnerClient } from '../../../services/runner-client.js';
import { wsPublisher } from '../../../ws/publisher.js';
import { AccountSwitchService, poolPosition } from '../../../services/account-switch.js';
import { readAccountPolicy, writeAccountPolicy } from '../../../services/account-policy.js';
import { isEngine } from '../../../util/engine.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';
import type { Engine } from '../../../util/engine.js';

const create = z
  .object({
    engine: z.enum(['codex', 'claude', 'grok', 'kimi']),
    label: z.string().trim().min(1).max(191).optional(),
    payload: z.string().min(1).max(262144),
  })
  .strict();
const update = z
  .object({
    label: z.string().trim().min(1).max(191).optional(),
    state: z.enum(['enabled', 'paused']).optional(),
  })
  .strict();
const idOf = (value: unknown) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('Invalid account ID');
  return id;
};
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid account input');
  return result.data;
}

export async function registerAdminAccountsRoutes(app: FastifyInstance, ctx: RouteContext) {
  const accounts = new ProviderAccountsService(ctx.db, ctx.keyring);
  const validation = createRunnerValidationService({ db: ctx.db, keyring: ctx.keyring });
  const store = createPooledAuthStoreService({
    db: ctx.db,
    keyring: ctx.keyring,
    runnerValidation: validation,
    runner: createRunnerClient({ env: ctx.env }),
  });
  app.get('/admin/accounts', { preHandler: [adminSpaHtmlPreHandler(ctx), app.requireAdmin] }, async () => {
    const now = Date.now();
    // Same scoring as the live-switching pool, so the console's quota state
    // agrees with what agents are told (`poolRecommendation`).
    return { accounts: (await accounts.list()).map((account) => ({ ...account, pool: poolPosition(account, now) })) };
  });
  const switches = new AccountSwitchService(ctx.db, ctx.keyring);
  const engineOf = (value: unknown): Engine => {
    if (typeof value !== 'string' || !isEngine(value)) throw new ValidationError('Unknown engine');
    return value;
  };
  app.get('/admin/accounts/policy/:engine', { preHandler: app.requireAdmin }, async (req) =>
    readAccountPolicy(ctx.db, engineOf((req.params as { engine: string }).engine)),
  );
  app.post('/admin/accounts/policy/:engine', { preHandler: app.requireAdmin }, async (req) => {
    const engine = engineOf((req.params as { engine: string }).engine);
    const policy = await writeAccountPolicy(ctx.db, engine, req.body, req.admin?.user.email ?? null);
    wsPublisher.publish('accounts.updated', { engine, policy: true });
    // A stricter band or ceiling may move running scopes right away.
    void switches.evaluate(engine).catch((err) => req.log.warn({ err }, 'account policy evaluation failed'));
    return policy;
  });
  app.get('/admin/accounts/scopes', { preHandler: app.requireAdmin }, async (req) =>
    switches.scopes(engineOf((req.query as { engine?: string }).engine ?? 'claude')),
  );
  app.post('/admin/accounts/scopes/switch', { preHandler: app.requireAdmin }, async (req) => {
    const input = parse(
      z
        .object({
          engine: z.enum(['codex', 'claude', 'grok', 'kimi']),
          host_id: z.number().int().positive(),
          scope_id: z.string().regex(/^[a-zA-Z0-9_-]{16,64}$/),
          account_id: z.union([z.number().int().positive(), z.literal('auto')]),
        })
        .strict(),
      req.body,
    );
    const result = await switches.requestSwitch({
      hostId: input.host_id,
      engine: input.engine,
      scopeId: input.scope_id,
      target: input.account_id,
      reason: 'admin',
      actor: req.admin?.user.email ?? null,
    });
    return { binding_generation: result.binding_generation, account_switch: result.account_switch };
  });
  app.post('/admin/accounts', { preHandler: app.requireAdmin }, async (req) => {
    const input = parse(create, req.body);
    const result = await store.storeCandidate({
      auth: decode(input.payload, input.engine),
      engine: input.engine,
      enrollAccount: true,
      sourceHostId: null,
      requireLastRefresh: false,
      sourceKind: 'admin',
      logAction: 'account.enrolled',
    });
    if (input.label && result.account_id) await accounts.update(result.account_id, { label: input.label });
    wsPublisher.publish('accounts.updated', { account_id: result.account_id });
    return metadata(result);
  });
  app.patch('/admin/accounts/:id', { preHandler: app.requireAdmin }, async (req) => {
    await accounts.update(idOf((req.params as { id: string }).id), parse(update, req.body));
    return { status: 'ok' };
  });
  app.delete('/admin/accounts/:id', { preHandler: app.requireAdmin }, async (req) => {
    await accounts.update(idOf((req.params as { id: string }).id), { state: 'removing' });
    return { status: 'ok' };
  });
  app.post('/admin/accounts/:id/credentials', { preHandler: app.requireAdmin }, async (req) => {
    const account = await accounts.get(idOf((req.params as { id: string }).id));
    const input = parse(z.object({ payload: z.string().min(1).max(262144) }).strict(), req.body);
    const engine = account.engine as Engine;
    const result = await store.storeCandidate({
      accountId: account.id,
      engine,
      auth: decode(input.payload, engine),
      sourceHostId: null,
      requireLastRefresh: false,
      sourceKind: 'admin',
      logAction: 'account.credentials.replaced',
    });
    wsPublisher.publish('accounts.updated', { account_id: account.id });
    return metadata(result);
  });
  app.post('/admin/accounts/:id/verify', { preHandler: app.requireAdmin }, async (req) => {
    const account = await accounts.get(idOf((req.params as { id: string }).id));
    const engine = account.engine as Engine;
    const row =
      (await validation.resolvePendingQuarantine?.(engine, account.id)) ??
      (await validation.resolveCanonicalPayload(engine, account.id));
    const decoded = validation.validateCanonicalPayload(row);
    if (!row || !decoded) throw new ValidationError('Account has no usable credential payload');
    const result = await store.ensureServedVerification({
      accountId: account.id,
      engine,
      hostId: null,
      row,
      auth: decoded.auth,
      digest: decoded.digest,
      lastRefresh: decoded.last_refresh,
      ttlSeconds: 0,
      forceLive: true,
    });
    wsPublisher.publish('accounts.updated', { account_id: account.id });
    return {
      account_id: account.id,
      verification_state: result.state,
      reason: result.reason,
      probe: result.probe,
    };
  });
}

function decode(payload: string, engine: Engine): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* A Claude API key is also accepted by the existing auth panel. */
  }
  if (engine === 'claude' && !payload.trim().startsWith('{')) return { api_key: payload.trim() };
  throw new ValidationError('Credentials must be a JSON object');
}

function metadata(result: {
  account_id?: number;
  status: string;
  verification_state: string;
  canonical_generation?: number;
}) {
  return {
    account_id: result.account_id,
    status: result.status,
    verification_state: result.verification_state,
    canonical_generation: result.canonical_generation,
  };
}
