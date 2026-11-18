import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, mutateOwnerState, withOwnerRequestScope, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../src/control-plane/presence.js';
import { installOwnerResponseBoundary } from '../../../src/http/plugins/owner-response.js';
import { Keyring } from '../../../src/security/keyring.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';
import * as schema from '../../../src/db/schema.js';
import { LATEST_LOG_HEAD } from '../../../src/services/audit-log.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { createDbFake } from '../../helpers/db-fake.js';

function fixture(host?: Record<string, unknown>) {
  const db = createDbFake();
  if (host) db.tables.set(schema.hosts, [host]);
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, host ? { hosts: [host] } as never : {}));
  const deadlines = new DeadlineQueue(error => { throw error; });
  let transactions = 0;
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state, assertOwner() {}, loseOwner(error) { throw error; }, committed() {}, notificationError(error) { throw error; },
    persistence: {
      async receipt() { return undefined; },
      async transaction(run) { transactions++; await run(db as unknown as PersistenceTransaction); },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: command => executor.execute(command) };
  bindOwnerRuntime(db, runtime);
  bindOwnerPresence(runtime, new ConnectionPresence(error => { throw error; }));
  return { db, state, runtime, deadlines, transactions: () => transactions };
}

describe('host fleet defaults through the production owner writer', () => {
  it.each([
    ['codex', 'gpt-6.2-astra', 'ultra'], ['claude', 'claude-fable-5-2', 'high'],
    ['grok', 'grok-4.7', 'xhigh'], ['kimi', 'k3.1-pro', 'high'],
  ] as const)('commits %s config, source host and audit in one owner transaction', async (engine, model, effort) => {
    const h = fixture();
    try {
      const service = new ModelDefaultsService(h.db as never);
      expect(await service.set(engine, { model, reasoning_effort: effort }, 7)).toMatchObject({ model, reasoning_effort: effort });
      expect(h.transactions()).toBe(1);
      const configs = h.state.snapshot().table('clientConfigDocuments').all();
      expect(configs).toHaveLength(1);
      expect(configs[0]).toMatchObject({ engine, sourceHostId: 7, settings: { model } });
      expect(h.db.tables.get(schema.logs)).toEqual([expect.objectContaining({ hostId: 7, action: 'host.model_defaults.set' })]);
      expect(h.state.snapshot().table('versions').get(LATEST_LOG_HEAD)?.version).toBeTruthy();
      expect(await service.get(engine)).toMatchObject({ model, reasoning_effort: effort });
    } finally { h.deadlines.close(); }
  });

  it.each([['assignment', 401], ['fleet switch', 403]] as const)('rejects a queued host save after its %s is revoked', async (revoked, status) => {
    const key = 'owner-selector-test';
    const h = fixture({ id: 1, fqdn: 'selector.test', apiKey: key, apiKeyHash: hashApiKey(key),
      status: 'active', secure: 1, vip: 0, engines: 'codex,claude', allowRoamingIps: 0,
      reverseDnsMode: null, expiresAt: null, ip4: null, ip6: null, apiCalls: 0,
      insecureEnabledUntil: null, insecureGraceUntil: null, insecureSessionRenewalBlocked: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const env = { INSTALLATION_ID: 'test', ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      PUBLIC_BASE_URL: 'https://fleet.test', STATIC_ROOT: '' } as Parameters<typeof buildHostApiTestApp>[0]['env'];
    const errors: Error[] = [];
    const app = await buildHostApiTestApp({ db: h.db as never, env, keyring: Keyring.fromEnv(env),
      configure: app => {
        app.addHook('onError', (_req, _reply, error, done) => { errors.push(error); done(); });
        app.addHook('onRequest', (_req, _reply, done) => withOwnerRequestScope(done));
        installOwnerResponseBoundary(app, h.runtime);
      } });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = ModelDefaultsService.prototype.set;
    const spy = vi.spyOn(ModelDefaultsService.prototype, 'set').mockImplementation(async function (this: ModelDefaultsService, engine, payload, source) {
      entered(); await gate;
      return original.call(this, engine, payload, source);
    });
    try {
      const save = app.inject({ method: 'POST', url: '/host/model-defaults/codex', headers: { 'x-api-key': key },
        payload: { model: 'gpt-6.2-astra', reasoning_effort: 'ultra' } }).then(response => response);
      await Promise.race([started, save.then(response => { throw new Error(`Save did not reach its writer: ${response.statusCode} ${response.body} ${errors.map(error => error.stack).join('\n')}`); })]);
      await mutateOwnerState(h.runtime, { kind: 'test.revoke-engine', persistence: 'volatile', payload: {}, prepare(ctx) {
        if (revoked === 'assignment') ctx.draft.upsert('hosts', { ...ctx.draft.table('hosts').get(1)!, engines: 'claude' });
        else ctx.draft.upsert('versions', { name: 'codex_engine_disabled', version: '1', updatedAt: new Date().toISOString() });
        return null;
      } });
      release();
      const response = await save;
      expect(response.statusCode, response.body).toBe(status);
      expect(h.state.snapshot().table('clientConfigDocuments').all()).toHaveLength(0);
      expect(h.db.tables.get(schema.logs) ?? []).toHaveLength(0);
    } finally { release(); spy.mockRestore(); await app.close(); h.deadlines.close(); }
  });
});
