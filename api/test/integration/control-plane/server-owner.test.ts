import { createCliAuthService } from '../../../src/services/cli-auth.js';
import { createHostRegistrationService } from '../../../src/services/host-registration.js';
import { createInsecureWindowService } from '../../../src/services/insecure-window.js';
import { HostSpawnService } from '../../../src/services/host-spawn.js';
import { HostManagementService } from '../../../src/services/host-management.js';
import { makeAdminEventsWriter } from '../../../src/services/admin-events-writer.js';
import { SettingsService } from '../../../src/services/settings.js';
import { withOwnerActionIdentity } from '../../../src/control-plane/state/runtime.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { loadBaseline } from '../../../src/db/migrator.js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { resetEnvCache } from '../../../src/env.js';
import { buildServer } from '../../../src/server.js';
import { McpSessionService } from '../../../src/services/mcp-session.js';
import { ClaudeUsageService } from '../../../src/services/claude-usage.js';
import { AuthorizationModeService } from '../../../src/services/authorization-mode.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { ChatAttachments } from '../../../src/services/agent-chat/attachments.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { agentBusGroups } from '../../../src/db/schema.js';
import { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import { flushGatewayKeyUsage } from '../../../src/services/gateway-key-usage.js';
import { acquireOfflineDatabase } from '../../../src/ops/offline-database.js';

const handle = await getTestDb();
describe.skipIf(!handle)('complete owner server composition', () => {
  afterAll(async () => {
    await handle?.pool.end();
  });
  it('boots the actual HTTP server under one owner, serves metadata without SQL, and releases ownership on close', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const root = await mkdtemp(join(tmpdir(), 'orchestrator-owner-test-'));
    const database = 'owner_server_' + randomUUID().replaceAll('-', '');
    await handle!.pool.query(`CREATE DATABASE \`${database}\``);
    const bootstrap = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
    });
    try {
      for (const statement of await loadBaseline()) await bootstrap.query(statement);
    } finally {
      await bootstrap.end();
    }
    testKeyring();
    for (const [name, value] of Object.entries({
      DB_HOST: url.hostname,
      DB_PORT: url.port || '3306',
      DB_USERNAME: decodeURIComponent(url.username),
      DB_PASSWORD: decodeURIComponent(url.password),
      DB_DATABASE: database,
      DATA_ROOT: root,
      AUTH_RUNNER_URL: '',
      AUTH_RUNNER_SHARED_SECRET: '',
      PUBLIC_BASE_URL: 'https://owner.fixture.test',
      RUN_MIGRATIONS_ON_BOOT: '1',
      MIGRATIONS_DIR: join(process.cwd(), 'src/db/migrations'),
    }))
      vi.stubEnv(name, value);
    resetEnvCache();
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      const pools = vi.spyOn(mysql, 'createPool');
      app = await buildServer();
      await app.ready();
      const pool = pools.mock.results.at(-1)!.value as mysql.Pool;
      pools.mockRestore();
      expect(app.controlPlane.ownership.status()).toBe('ready');
      expect((await app.inject('/healthz')).statusCode).toBe(200);
      const runtime = app.controlPlane.runtime;
      await expect(acquireOfflineDatabase(handle!.pool, database)).rejects.toThrow(
        'Another control-plane owner',
      );
      const host = runtime.state
        .snapshot()
        .hosts.all()
        .find((row) => row.internalRole === 'advisor')!;
      expect(host).toBeDefined();
      const tokens = new McpSessionService(app.db),
        issued = await tokens.issue(host.id);
      const keys = new OpenAiKeyService({ db: app.db, keyring: app.keyring });
      const issuedKeys = await Promise.all(
        (['codex', 'claude', 'grok'] as const).map(async (engine) => ({
          engine,
          ...(await keys.issue({ engine, name: engine + ' fixture' })),
        })),
      );
      const budget = installSqlBudget(pool);
      budget.track(app.controlPlane.ownership.heldConnection());
      try {
        const usage = new ClaudeUsageService(app.db),
          authorization = new AuthorizationModeService(app.db);
        budget.reset();
        for (let i = 0; i < 100; i++) {
          expect((await tokens.verify(issued.token))?.id).toBe(host.id);
          await authorization.getMode();
          await usage.latest();
        }
        for (let i = 0; i < 5; i++) expect((await app.inject('/readyz')).statusCode).toBe(503);
        for (const key of issuedKeys)
          for (let i = 0; i < 20; i++) {
            expect((await keys.findActiveByBearer(key.key, key.engine))?.id).toBe(key.record.id);
            await keys.touch(key.record.id);
          }
        expect(budget.snapshot()).toEqual([]);
      } finally {
        budget.restore();
      }
      await flushGatewayKeyUsage(runtime);
      for (const key of issuedKeys) {
        expect((await keys.findById(key.record.id))?.useCount).toBe(20);
        await keys.setActive(key.record.id, false, key.engine);
        expect(await keys.findActiveByBearer(key.key, key.engine)).toBeNull();
      }
      const registration = createHostRegistrationService({
        db: app.db,
        keyring: app.keyring,
        insecure: createInsecureWindowService({ db: app.db, env: app.env }),
        defaultHostEngines: 'codex,claude,grok',
      });
      const login = createCliAuthService({ db: app.db, keyring: app.keyring, registration });
      const started = await login.start({
        fqdn: 'cli-owner.fixture.test',
        secure: false,
        ip: null,
        userAgent: null,
      });
      const pollBudget = installSqlBudget(pool);
      pollBudget.track(app.controlPlane.ownership.heldConnection());
      try {
        for (let i = 0; i < 100; i++) {
          expect(await login.poll(started.request_id)).toEqual({ status: 'pending' });
          expect((await login.lookup(started.user_code))?.fqdn).toBe('cli-owner.fixture.test');
        }
        expect(pollBudget.snapshot()).toEqual([]);
      } finally {
        pollBudget.restore();
      }
      const principal = { principal: 'system:test', revalidate() {} };
      // A prepared action permits exactly one domain command, including Grok
      // first-use defaults, credentials, insecure window and approval resolution.
      const approved = await withOwnerActionIdentity(
        { id: randomUUID(), principal, revalidateTarget() {} },
        () => login.approve(started.user_code, 1, 'test'),
      );
      expect(runtime.state.snapshot().hosts.get(approved.host_id)?.engines).toBe('codex,claude,grok');
      expect(
        new Date(runtime.state.snapshot().hosts.get(approved.host_id)!.insecureEnabledUntil!).getTime(),
      ).toBeGreaterThan(Date.now());
      expect(runtime.state.snapshot().table('clientConfigDocuments').by('engine', 'grok')).toHaveLength(1);
      const consumed = await Promise.all([login.poll(started.request_id), login.poll(started.request_id)]);
      expect(consumed.map((x) => x.status).sort()).toEqual(['approved', 'consumed']);
      await expect(login.deny(started.user_code)).rejects.toThrow('already resolved');
      const race = await login.start({
        fqdn: 'cli-race.fixture.test',
        secure: true,
        ip: null,
        userAgent: null,
      });
      const decisions = await Promise.allSettled([
        login.approve(race.user_code, 1, 'test'),
        login.deny(race.user_code),
      ]);
      expect(decisions.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const hosts = new HostManagementService({
        db: app.db,
        keyring: app.keyring,
        env: app.env,
        events: makeAdminEventsWriter(app.db),
      });
      const source = await hosts.register({
        fqdn: 'spawn-source.fixture.test',
        engines: ['codex'],
        vip: true,
      });
      await new SettingsService(app.db).set('host_spawn_enabled', '1');
      await new SettingsService(app.db).set('agent_messaging_enabled', '1');
      const spawn = new HostSpawnService({ db: app.db, keyring: app.keyring, env: app.env } as RouteContext);
      const spawnInput = {
        fqdn: 'spawn-target.fixture.test',
        engines: ['codex', 'claude', 'grok'],
        secure: true,
        client_message_id: randomUUID(),
        daemon: { mode: 'permanent', username: 'root', default_cwd: '/tmp' },
      };
      const prepared = await withOwnerActionIdentity(
        { id: randomUUID(), principal, revalidateTarget() {} },
        () => spawn.prepare(spawnInput, source.host.id),
      );
      expect((await spawn.prepare(spawnInput, source.host.id)).operation_id).toBe(prepared.operation_id);
      await expect(
        spawn.prepare({ ...spawnInput, fqdn: 'different.fixture.test' }, source.host.id),
      ).rejects.toThrow('different input');
      expect(await spawn.status({ operation_id: prepared.operation_id }, source.host.id)).toMatchObject({
        state: 'registered',
        daemon_connected: false,
      });
      await spawn.complete(prepared.host_id);
      expect(await spawn.status({ operation_id: prepared.operation_id }, source.host.id)).toMatchObject({
        state: 'installed',
        daemon_connected: false,
      });
      const groupId = randomUUID(),
        now = new Date().toISOString();
      await mutateOwnerState(runtime, {
        kind: 'fixture.group',
        payload: { id: groupId },
        prepare(ctx) {
          const row = {
            id: groupId,
            slug: groupId,
            title: 'Upload fixture',
            description: null,
            createdByAddressId: randomUUID(),
            createdAt: now,
            updatedAt: now,
          };
          ctx.draft.upsert('agentBusGroups', row);
          ctx.write((tx) => tx.insert(agentBusGroups).values(row));
          return null;
        },
      });
      const files = new ChatAttachments(app.db, app.keyring, root),
        id = randomUUID(),
        bytes = Buffer.from('durable upload fixture'),
        digest = createHash('sha256').update(bytes).digest('hex');
      await files.create(groupId, 'room:admin:1', {
        id,
        name: 'fixture.txt',
        mime_type: 'text/plain',
        size_bytes: bytes.length,
        sha256: digest,
      });
      await files.put(groupId, 'room:admin:1', id, 0, bytes.subarray(0, 8).toString('base64'));
      // Lost metadata ACK after a partial file write: retry compares the prefix.
      const { appendFile } = await import('node:fs/promises');
      await appendFile(files.path(id), bytes.subarray(8, 12));
      await files.put(groupId, 'room:admin:1', id, 8, bytes.subarray(8).toString('base64'));
      await files.put(groupId, 'room:admin:1', id, 8, bytes.subarray(8).toString('base64'));
      await expect(
        files.put(groupId, 'room:admin:1', id, 8, Buffer.from('wrong').toString('base64')),
      ).rejects.toThrow('retry bytes differ');
      expect(await files.seal(groupId, 'room:admin:1', id)).toMatchObject({
        status: 'ready',
        sha256: digest,
        uploaded_bytes: bytes.length,
      });
      expect(runtime.state.snapshot().table('agentChatAttachments').get(id)).not.toHaveProperty(
        'metadataEnc',
      );
      await files.discard(groupId, 'room:admin:1', id);
      await expect(files.info(groupId, id)).rejects.toThrow('Attachment not found');
      await app.close();
      app = undefined;
      const replacement = new ControlPlaneOwnership(handle!.pool, database);
      try {
        await replacement.acquire();
      } finally {
        await replacement.close();
      }
    } finally {
      await app?.close();
      vi.unstubAllEnvs();
      resetEnvCache();
      await handle!.pool.query(`DROP DATABASE \`${database}\``);
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
