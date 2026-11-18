import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clientConfigDocuments, hosts, logs } from '../../../src/db/schema.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';
import { Keyring } from '../../../src/security/keyring.js';
import { getTestDb } from '../../helpers/test-db.js';
import { buildHostApiTestApp } from '../../helpers/build-host-api-app.js';

const handle = await getTestDb();
describe.skipIf(!handle)('fleet defaults against disposable MySQL', () => {
  const key = randomUUID().replaceAll('-', '').repeat(2);
  const ownConfigIds = new Set<number>();
  let hostId: number;
  let app: Awaited<ReturnType<typeof buildHostApiTestApp>>;
  beforeAll(async () => {
    const at = new Date().toISOString();
    const [row] = await handle!.db.insert(hosts).values({ fqdn: `selector-${randomUUID()}.test`, apiKey: key,
      apiKeyHash: hashApiKey(key), engines: 'codex,claude,grok,kimi', secure: 1, vip: 0,
      modelOverride: 'gpt-6.1-sol', reasoningEffortOverride: 'high', createdAt: at, updatedAt: at });
    hostId = Number(row.insertId);
    const env = { INSTALLATION_ID: 'selector-test', ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      PUBLIC_BASE_URL: 'https://fleet.test', STATIC_ROOT: '', INSECURE_GRACE_MINUTES: 60 } as Parameters<typeof buildHostApiTestApp>[0]['env'];
    app = await buildHostApiTestApp({ db: handle!.db, env, keyring: Keyring.fromEnv(env) });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const own = await handle!.db.select().from(clientConfigDocuments).where(eq(clientConfigDocuments.sourceHostId, hostId));
    for (const row of own) ownConfigIds.add(row.id);
    if (ownConfigIds.size) await handle!.db.delete(clientConfigDocuments).where(inArray(clientConfigDocuments.id, [...ownConfigIds]));
    ownConfigIds.clear();
  });
  afterAll(async () => {
    await app?.close();
    if (hostId) {
      await handle!.db.delete(logs).where(eq(logs.hostId, hostId));
      await handle!.db.delete(hosts).where(eq(hosts.id, hostId));
    }
    await handle?.pool.end();
  });

  it.each(['codex', 'claude', 'grok', 'kimi'] as const)('serializes %s host-default save against a stale admin config edit', async engine => {
    const config = new ClientConfigService(handle!.db);
    const initial = await config.store({ settings: { orchestrator_mcp_enabled: true } }, null, engine);
    ownConfigIds.add(Number(initial.revision));
    const current = await new ModelDefaultsService(handle!.db).get(engine);
    const selected = current.catalog.find(entry => entry.model !== current.model)!;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = ClientConfigService.prototype.store;
    vi.spyOn(ClientConfigService.prototype, 'store').mockImplementation(async function (this: ClientConfigService, payload, sourceHostId, target, audit) {
      if (sourceHostId === hostId && target === engine) { entered(); await gate; }
      return original.call(this, payload, sourceHostId, target, audit);
    });
    const save = app.inject({ method: 'POST', url: `/host/model-defaults/${engine}`, headers: { 'x-api-key': key },
      payload: { model: selected.model, reasoning_effort: selected.default_effort } }).then(response => response);
    try {
      await started;
      const competing = config.store({ settings: { ...initial.settings, orchestrator_mcp_enabled: false }, expected_revision: initial.revision }, null, engine);
      release();
      const outcomes = await Promise.allSettled([save, competing]);
      expect(outcomes[0].status).toBe('fulfilled');
      if (outcomes[0].status === 'fulfilled') expect(outcomes[0].value.statusCode, outcomes[0].value.body).toBe(200);
      expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'config_revision_conflict' } });
      const final = await config.adminFetch(engine);
      expect(final.settings).toMatchObject({ model: selected.model, orchestrator_mcp_enabled: true });
      const loaded = await app.inject({ method: 'GET', url: `/host/model-defaults/${engine}`, headers: { 'x-api-key': key } });
      expect(loaded.json()).toMatchObject({ model: selected.model, reasoning_effort: selected.default_effort });
      const [host] = await handle!.db.select().from(hosts).where(eq(hosts.id, hostId));
      expect(host).toMatchObject({ modelOverride: 'gpt-6.1-sol', reasoningEffortOverride: 'high' });
    } finally { release(); }
  });

  it('rolls the default back when its audit insert fails', async () => {
    const config = new ClientConfigService(handle!.db);
    const initial = await config.store({ settings: { model: 'gpt-6-astra', orchestrator_mcp_enabled: true } }, null, 'codex');
    ownConfigIds.add(Number(initial.revision));
    await handle!.pool.query(`CREATE TRIGGER selector_fail_audit BEFORE INSERT ON logs FOR EACH ROW BEGIN IF NEW.action = 'host.model_defaults.set' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic selector audit failure'; END IF; END`);
    try {
      const response = await app.inject({ method: 'POST', url: '/host/model-defaults/codex', headers: { 'x-api-key': key },
        payload: { model: 'gpt-6.2-astra', reasoning_effort: 'ultra' } });
      expect(response.statusCode).toBe(500);
      expect((await config.adminFetch('codex')).revision).toBe(initial.revision);
    } finally { await handle!.pool.query('DROP TRIGGER selector_fail_audit'); }
  });
});
