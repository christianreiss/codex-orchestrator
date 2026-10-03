import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientConfigDocuments, hosts, type Host } from '../../../src/db/schema.js';
import { ClientConfigService } from '../../../src/services/client-config.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { HostManagementService } from '../../../src/services/host-management.js';
import { HostAgentsService } from '../../../src/services/host-agents.js';
import { createHostRegistrationService } from '../../../src/services/host-registration.js';
import { createInsecureWindowService } from '../../../src/services/insecure-window.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { ENGINE_GROK } from '../../../src/util/engine.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();

describe.skipIf(!handle)('Grok fleet defaults during explicit provisioning against a real database', { timeout: 120_000 }, () => {
  let db: TestDb;
  const hostIds = new Set<number>();
  let management: HostManagementService;
  let configs: ClientConfigService;
  let defaults: ModelDefaultsService;

  function tracked(host: Host): Host {
    hostIds.add(host.id);
    return host;
  }

  const cleanup = async () => {
    await db.delete(clientConfigDocuments).where(eq(clientConfigDocuments.engine, ENGINE_GROK));
    for (const id of hostIds) {
      for (const table of ['install_tokens', 'mcp_session_tokens', 'admin_events', 'logs']) {
        await db.execute(sql.raw(`DELETE FROM ${table} WHERE host_id = ${id}`));
      }
    }
    if (hostIds.size) await db.delete(hosts).where(inArray(hosts.id, [...hostIds]));
    hostIds.clear();
  };

  beforeAll(() => {
    db = handle!.db;
    const env = { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://grok-defaults.test', DEFAULT_HOST_ENGINES: 'codex' };
    management = new HostManagementService({ db, env, keyring: testKeyring(), events: makeAdminEventsWriter(db) });
    configs = new ClientConfigService(db);
    defaults = new ModelDefaultsService(db);
  });
  beforeEach(cleanup);
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });
  afterAll(async () => { await handle?.pool.end(); });

  it('keeps read-only defaults and config retrieval unpersisted', async () => {
    expect(await defaults.get(ENGINE_GROK)).toMatchObject({ model: 'grok-4.7', reasoning_effort: 'high' });
    expect(await configs.adminFetch(ENGINE_GROK)).toEqual({ status: 'missing' });
    const legacy = tracked((await management.register({ fqdn: `${randomUUID()}.grok-read.test`, secure: true, engines: ['codex'] })).host);
    const out = await new HostAgentsService(db, { publicBaseUrl: 'https://grok-defaults.test', keyring: testKeyring() })
      .retrieveConfig(null, legacy, ENGINE_GROK);
    expect(out).toEqual({ status: 'missing' });
    expect(await configs.adminFetch(ENGINE_GROK)).toEqual({ status: 'missing' });
  });

  it.each(['register', 'quick-register', 'engine-switch', 'installer-add', 'cli-register', 'cli-engine-add'] as const)('initializes Grok defaults and managed MCP through %s', async operation => {
      let host: Host;
      const fqdn = `${randomUUID()}.grok-provision.test`;
      if (operation === 'register') {
        host = tracked((await management.register({ fqdn, secure: true, engines: ['grok'] })).host);
      } else if (operation === 'quick-register') {
        host = tracked((await management.quickRegister({ engines: ['codex', 'claude', 'grok'] })).host);
      } else if (operation === 'engine-switch' || operation === 'installer-add') {
        const current = tracked((await management.register({ fqdn, secure: true, engines: ['codex'] })).host);
        expect(await configs.adminFetch(ENGINE_GROK)).toEqual({ status: 'missing' });
        host = operation === 'engine-switch'
          ? await management.setEngines(current.id, ['codex', 'grok'])
          : (await management.mintInstaller(current.id, ['grok'])).host;
      } else {
        const env = loadTestEnv();
        const registration = createHostRegistrationService({
          db, keyring: testKeyring(), insecure: createInsecureWindowService({ db, env }),
        });
        if (operation === 'cli-engine-add') {
          tracked((await registration.registerOrRotate({ fqdn, engines: 'codex' })).host);
          expect(await configs.adminFetch(ENGINE_GROK)).toEqual({ status: 'missing' });
        }
        host = tracked((await registration.registerOrRotate({ fqdn, engines: 'codex,grok' })).host);
      }
      expect(await defaults.get(ENGINE_GROK)).toMatchObject({ model: 'grok-4.7', reasoning_effort: 'high' });
      const rendered = await new HostAgentsService(db, { publicBaseUrl: 'https://grok-defaults.test', keyring: testKeyring() })
        .retrieveConfig(null, host, ENGINE_GROK);
      expect(rendered.status).toBe('updated');
      expect(rendered.content).toContain('[mcp_servers.cgx]');
      expect(rendered.content).toContain('https://grok-defaults.test/mcp');
      expect(rendered.owned_paths).toContain('mcp_servers.cgx');
      expect(await db.select().from(clientConfigDocuments).where(eq(clientConfigDocuments.engine, ENGINE_GROK))).toHaveLength(1);
    });

  it('preserves operator model, effort and MCP policy through every repeated provisioning path', async () => {
    const authored = await configs.store({ settings: {
      model: 'grok-4.5', reasoning_effort: 'low', orchestrator_mcp_enabled: false,
      mcp_servers: [{ name: 'operator', command: 'operator-mcp', args: ['--local'] }],
    } }, null, ENGINE_GROK);
    const fqdn = `${randomUUID()}.grok-preserve.test`;
    const host = tracked((await management.register({ fqdn, secure: true, engines: ['grok'] })).host);
    await management.setEngines(host.id, ['codex', 'grok']);
    await management.mintInstaller(host.id, ['grok']);
    tracked((await management.quickRegister({ engines: ['grok'] })).host);
    const env = loadTestEnv();
    await createHostRegistrationService({ db, keyring: testKeyring(), insecure: createInsecureWindowService({ db, env }) })
      .registerOrRotate({ fqdn, engines: 'grok' });
    expect(await defaults.ensureGrokDefaults()).toBe(false);
    expect(await configs.adminFetch(ENGINE_GROK)).toMatchObject({ sha256: authored.sha256, settings: {
      model: 'grok-4.5', reasoning_effort: 'low', orchestrator_mcp_enabled: false,
      mcp_servers: [expect.objectContaining({ name: 'operator', command: 'operator-mcp' })],
    } });
    expect(await db.select().from(clientConfigDocuments).where(eq(clientConfigDocuments.engine, ENGINE_GROK))).toHaveLength(1);
  });

  it('collapses concurrent empty-fleet initializers onto one config head', async () => {
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => new ModelDefaultsService(db).ensureGrokDefaults()));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(clientConfigDocuments).where(eq(clientConfigDocuments.engine, ENGINE_GROK))).toHaveLength(1);
  });

  it('keeps authored policy canonical when its write races a locked empty-fleet initializer', async () => {
    let releaseDefault!: () => void;
    let signalDefault!: () => void;
    const defaultGate = new Promise<void>(resolve => { releaseDefault = resolve; });
    const defaultEntered = new Promise<void>(resolve => { signalDefault = resolve; });
    let paused = false;
    const originalSet = ModelDefaultsService.prototype.set;
    vi.spyOn(ModelDefaultsService.prototype, 'set').mockImplementation(async function(this: ModelDefaultsService, engine, input) {
      if (!paused && engine === ENGINE_GROK && (input as { model: string }).model === 'grok-4.7') {
        paused = true;
        signalDefault();
        await defaultGate;
      }
      return originalSet.call(this, engine, input);
    });
    let authorStoreCalls = 0;
    const originalStore = ClientConfigService.prototype.store;
    vi.spyOn(ClientConfigService.prototype, 'store').mockImplementation(function(this: ClientConfigService, payload, sourceHostId, engine) {
      if (engine === ENGINE_GROK && (payload.settings as { model?: string }).model === 'grok-4.5') {
        authorStoreCalls += 1;
      }
      return originalStore.call(this, payload, sourceHostId, engine);
    });
    const initialization = defaults.ensureGrokDefaults();
    await defaultEntered;
    const authored = configs.store({ settings: {
      model: 'grok-4.5', reasoning_effort: 'low', orchestrator_mcp_enabled: false,
      mcp_servers: [{ name: 'operator-race', command: 'local-policy-mcp' }],
    } }, null, ENGINE_GROK);
    try {
      // The second store invocation is inside the real database write lock.
      await vi.waitFor(() => expect(authorStoreCalls).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    } finally {
      releaseDefault();
    }
    await Promise.all([initialization, authored]);
    expect(await configs.adminFetch(ENGINE_GROK)).toMatchObject({ settings: {
      model: 'grok-4.5', reasoning_effort: 'low', orchestrator_mcp_enabled: false,
      mcp_servers: [expect.objectContaining({ name: 'operator-race', command: 'local-policy-mcp' })],
    } });
  });
});
