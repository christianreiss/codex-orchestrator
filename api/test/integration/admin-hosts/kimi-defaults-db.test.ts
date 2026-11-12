import type { ManagedHost } from '../../../src/control-plane/state/host-registration.js';
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
import { ENGINE_KIMI } from '../../../src/util/engine.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();

describe.skipIf(!handle)(
  'Kimi fleet defaults during explicit provisioning against a real database',
  { timeout: 120_000 },
  () => {
    let db: TestDb;
    const hostIds = new Set<number>();
    let management: HostManagementService;
    let configs: ClientConfigService;
    let defaults: ModelDefaultsService;

    function tracked(host: ManagedHost): ManagedHost {
      hostIds.add(host.id);
      return host;
    }

    const cleanup = async () => {
      await db.delete(clientConfigDocuments).where(eq(clientConfigDocuments.engine, ENGINE_KIMI));
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
      const env = {
        ...loadTestEnv(),
        PUBLIC_BASE_URL: 'https://kimi-defaults.test',
        DEFAULT_HOST_ENGINES: 'codex',
      };
      management = new HostManagementService({
        db,
        env,
        keyring: testKeyring(),
        events: makeAdminEventsWriter(db),
      });
      configs = new ClientConfigService(db);
      defaults = new ModelDefaultsService(db);
    });
    beforeEach(cleanup);
    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanup();
    });
    afterAll(async () => {
      await handle?.pool.end();
    });

    it('keeps read-only defaults and config retrieval unpersisted', async () => {
      expect(await defaults.get(ENGINE_KIMI)).toMatchObject({ model: 'k3.1-pro', reasoning_effort: 'max' });
      expect(await configs.adminFetch(ENGINE_KIMI)).toEqual({ status: 'missing', revision: null });
      const legacy = tracked(
        (
          await management.register({
            fqdn: `${randomUUID()}.kimi-read.test`,
            secure: true,
            engines: ['codex'],
          })
        ).host,
      );
      const out = await new HostAgentsService(db, {
        publicBaseUrl: 'https://kimi-defaults.test',
        keyring: testKeyring(),
      }).retrieveConfig(
        null,
        (await db.select().from(hosts).where(eq(hosts.id, legacy.id)))[0]!,
        ENGINE_KIMI,
      );
      expect(out).toEqual({ status: 'missing' });
      expect(await configs.adminFetch(ENGINE_KIMI)).toEqual({ status: 'missing', revision: null });
    });

    it.each([
      'register',
      'quick-register',
      'engine-switch',
      'installer-add',
      'cli-register',
      'cli-engine-add',
    ] as const)('initializes Kimi defaults and managed MCP through %s', async (operation) => {
      let host: ManagedHost;
      const fqdn = `${randomUUID()}.kimi-provision.test`;
      if (operation === 'register') {
        host = tracked((await management.register({ fqdn, secure: true, engines: ['kimi'] })).host);
      } else if (operation === 'quick-register') {
        host = tracked(
          (await management.quickRegister({ engines: ['codex', 'claude', 'grok', 'kimi'] })).host,
        );
      } else if (operation === 'engine-switch' || operation === 'installer-add') {
        const current = tracked((await management.register({ fqdn, secure: true, engines: ['codex'] })).host);
        expect(await configs.adminFetch(ENGINE_KIMI)).toEqual({ status: 'missing', revision: null });
        host =
          operation === 'engine-switch'
            ? await management.setEngines(current.id, ['codex', 'kimi'])
            : (await management.mintInstaller(current.id, ['kimi'])).host;
      } else {
        const env = loadTestEnv();
        const registration = createHostRegistrationService({
          db,
          keyring: testKeyring(),
          insecure: createInsecureWindowService({ db, env }),
        });
        if (operation === 'cli-engine-add') {
          tracked((await registration.registerOrRotate({ fqdn, engines: 'codex' })).host);
          expect(await configs.adminFetch(ENGINE_KIMI)).toEqual({ status: 'missing', revision: null });
        }
        host = tracked((await registration.registerOrRotate({ fqdn, engines: 'codex,kimi' })).host);
      }
      expect(await defaults.get(ENGINE_KIMI)).toMatchObject({ model: 'k3.1-pro', reasoning_effort: 'max' });
      const rendered = await new HostAgentsService(db, {
        publicBaseUrl: 'https://kimi-defaults.test',
        keyring: testKeyring(),
      }).retrieveConfig(null, (await db.select().from(hosts).where(eq(hosts.id, host.id)))[0]!, ENGINE_KIMI);
      expect(rendered.status).toBe('updated');
      expect(rendered.content).toContain('[mcp_servers.ckx]');
      expect(rendered.content).toContain('https://kimi-defaults.test/mcp');
      expect(rendered.owned_paths).toContain('default_model');
      expect(
        await db.select().from(clientConfigDocuments).where(eq(clientConfigDocuments.engine, ENGINE_KIMI)),
      ).toHaveLength(1);
    });

    it('preserves operator model, effort and MCP policy through every repeated provisioning path', async () => {
      const authored = await configs.store(
        {
          settings: {
            model: 'k3',
            reasoning_effort: 'low',
            orchestrator_mcp_enabled: false,
            mcp_servers: [{ name: 'operator', command: 'operator-mcp', args: ['--local'] }],
          },
        },
        null,
        ENGINE_KIMI,
      );
      const fqdn = `${randomUUID()}.kimi-preserve.test`;
      const host = tracked((await management.register({ fqdn, secure: true, engines: ['kimi'] })).host);
      await management.setEngines(host.id, ['codex', 'kimi']);
      await management.mintInstaller(host.id, ['kimi']);
      tracked((await management.quickRegister({ engines: ['kimi'] })).host);
      const env = loadTestEnv();
      await createHostRegistrationService({
        db,
        keyring: testKeyring(),
        insecure: createInsecureWindowService({ db, env }),
      }).registerOrRotate({ fqdn, engines: 'kimi' });
      expect(await defaults.ensureKimiDefaults()).toBe(false);
      expect(await configs.adminFetch(ENGINE_KIMI)).toMatchObject({
        sha256: authored.sha256,
        settings: {
          model: 'k3',
          reasoning_effort: 'low',
          orchestrator_mcp_enabled: false,
          mcp_servers: [expect.objectContaining({ name: 'operator', command: 'operator-mcp' })],
        },
      });
      expect(
        await db.select().from(clientConfigDocuments).where(eq(clientConfigDocuments.engine, ENGINE_KIMI)),
      ).toHaveLength(1);
    });

    it('collapses concurrent empty-fleet initializers onto one config head', async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () => new ModelDefaultsService(db).ensureKimiDefaults()),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(
        await db.select().from(clientConfigDocuments).where(eq(clientConfigDocuments.engine, ENGINE_KIMI)),
      ).toHaveLength(1);
    });

    it('keeps authored policy canonical when its write races a locked empty-fleet initializer', async () => {
      let releaseDefault!: () => void;
      let signalDefault!: () => void;
      const defaultGate = new Promise<void>((resolve) => {
        releaseDefault = resolve;
      });
      const defaultEntered = new Promise<void>((resolve) => {
        signalDefault = resolve;
      });
      let paused = false;
      const originalSet = ModelDefaultsService.prototype.set;
      vi.spyOn(ModelDefaultsService.prototype, 'set').mockImplementation(async function (
        this: ModelDefaultsService,
        engine,
        input,
      ) {
        if (!paused && engine === ENGINE_KIMI && (input as { model: string }).model === 'k3.1-pro') {
          paused = true;
          signalDefault();
          await defaultGate;
        }
        return originalSet.call(this, engine, input);
      });
      let authorStoreCalls = 0;
      const originalStore = ClientConfigService.prototype.store;
      vi.spyOn(ClientConfigService.prototype, 'store').mockImplementation(function (
        this: ClientConfigService,
        payload,
        sourceHostId,
        engine,
      ) {
        if (engine === ENGINE_KIMI && (payload.settings as { model?: string }).model === 'k3') {
          authorStoreCalls += 1;
        }
        return originalStore.call(this, payload, sourceHostId, engine);
      });
      const initialization = defaults.ensureKimiDefaults();
      await defaultEntered;
      const authored = configs.store(
        {
          settings: {
            model: 'k3',
            reasoning_effort: 'low',
            orchestrator_mcp_enabled: false,
            mcp_servers: [{ name: 'operator-race', command: 'local-policy-mcp' }],
          },
        },
        null,
        ENGINE_KIMI,
      );
      try {
        // The second store invocation is inside the real database write lock.
        await vi.waitFor(() => expect(authorStoreCalls).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
      } finally {
        releaseDefault();
      }
      await Promise.all([initialization, authored]);
      expect(await configs.adminFetch(ENGINE_KIMI)).toMatchObject({
        settings: {
          model: 'k3',
          reasoning_effort: 'low',
          orchestrator_mcp_enabled: false,
          mcp_servers: [expect.objectContaining({ name: 'operator-race', command: 'local-policy-mcp' })],
        },
      });
    });
  },
);
