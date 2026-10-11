import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerInstallRoutes } from '../../src/routes/install/index.js';
import { McpToolsRegistry, type ToolDeps } from '../../src/services/mcp-tools.js';
import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestDb } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { HostSpawnService, HOST_SPAWN_ENABLED_KEY } from '../../src/services/host-spawn.js';
import { SettingsService } from '../../src/services/settings.js';
import { HostDaemonService } from '../../src/services/host-daemon/service.js';
import { invalidateFleetEngineState } from '../../src/services/engine-switch.js';
import { hosts, hostSpawns, installTokens, hostDaemons, hostDaemonOperations, hostDaemonSessions, adminEvents } from '../../src/db/schema.js';
const handle = await getTestDb();
describe.skipIf(!handle)('durable system provisioning', () => {
  let source: number, service: HostSpawnService, daemon: HostDaemonService, settings: SettingsService;
  const created: number[] = [];
  const request = (engine = 'codex') => ({ fqdn: `spawn-${randomUUID()}.test`, engines: [engine], client_message_id: randomUUID() });
  beforeAll(async () => {
    const ctx = { db: handle!.db, env: loadTestEnv(), keyring: testKeyring() };
    ctx.env.PUBLIC_BASE_URL = 'https://spawn.example.test';
    service = new HostSpawnService(ctx); daemon = new HostDaemonService(ctx); settings = new SettingsService(ctx.db);
    await settings.setFlag(HOST_SPAWN_ENABLED_KEY, true);
    await settings.setFlag('agent_messaging_enabled', true);
    for (const engine of ['codex', 'claude', 'grok']) await settings.setFlag(`${engine}_engine_disabled`, false);
    invalidateFleetEngineState(ctx.db);
    const result = await ctx.db.insert(hosts).values({ fqdn: `source-${randomUUID()}.test`,
      apiKey: randomUUID(), status: 'active', vip: 1, secure: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    source = Number(result[0].insertId);
  });
  afterAll(async () => {
    await handle!.db.delete(adminEvents).where(inArray(adminEvents.hostId, [source, ...created]));
    await handle!.db.delete(installTokens).where(inArray(installTokens.hostId, created.length ? created : [0]));
    await handle!.db.delete(hosts).where(inArray(hosts.id, [source, ...created]));
    await handle!.pool.end();
  });
  it.each(['codex', 'claude', 'grok'])('provisions %s securely without granting VIP', async engine => {
    const result = await service.prepare(request(engine), source); created.push(result.host_id);
    const [target] = await handle!.db.select().from(hosts).where(eq(hosts.id, result.host_id));
    expect(target).toMatchObject({ secure: 1, vip: 0, engines: engine });
    expect(result.installer.url).toContain('/install/');
    const [stored] = await handle!.db.select().from(hostSpawns).where(eq(hostSpawns.id, result.operation_id));
    expect(stored!.installerEnc).not.toContain(result.installer.token);
    expect(stored!.installerEnc).toMatch(/^sbox:v1/);
    expect((await service.status({ operation_id: result.operation_id }, source)).state).toBe('registered');
    await service.complete(result.host_id);
    expect((await service.status({ operation_id: result.operation_id }, source)).state).toBe('installed');
  });
  it('MCP uses the authenticated source and refuses forged source/VIP arguments', async () => {
    const registry = new McpToolsRegistry({ hostSpawn: service, memories: {}, projects: {}, skills: {} } as unknown as ToolDeps);
    const [caller] = await handle!.db.select().from(hosts).where(eq(hosts.id, source));
    const accepted = await registry.dispatch('host_spawn_prepare', request(), caller!);
    expect(accepted.isError).toBeFalsy();
    const result = JSON.parse((accepted.content as { text: string }[])[0]!.text);
    created.push(result.host_id);
    expect((await registry.dispatch('host_spawn_prepare', { ...request(), source_host_id: source }, caller!)).isError).toBe(true);
    expect((await registry.dispatch('host_spawn_prepare', request(), { ...caller!, id: result.host_id, vip: 1 })).isError).toBe(true);
  });
  it('blocks disabled engines without registering a partial host', async () => {
    const input = request('grok');
    await settings.setFlag('grok_engine_disabled', true); invalidateFleetEngineState(handle!.db);
    try { await expect(service.prepare(input, source)).rejects.toThrow(/disabled/); }
    finally { await settings.setFlag('grok_engine_disabled', false); invalidateFleetEngineState(handle!.db); }
    expect(await handle!.db.select().from(hosts).where(eq(hosts.fqdn, input.fqdn))).toHaveLength(0);
  });
  it('installer GET checks the global switch before consuming a token and embeds completion before success exit', async () => {
    const result = await service.prepare(request(), source); created.push(result.host_id);
    const app = Fastify();
    const env = loadTestEnv(); env.PUBLIC_BASE_URL = 'https://spawn.example.test';
    await registerInstallRoutes(app, { db: handle!.db, env, keyring: testKeyring() });
    try {
      await settings.setFlag(HOST_SPAWN_ENABLED_KEY, false);
      const refused = await app.inject({ url: new URL(result.installer.url).pathname });
      expect(refused.headers['x-installer-error']).toBe('host_spawn_disabled');
      await settings.setFlag(HOST_SPAWN_ENABLED_KEY, true);
      expect((await service.status({ operation_id: result.operation_id }, source)).installer_used).toBe(false);
      const installed = await app.inject({ url: new URL(result.installer.url).pathname });
      expect(installed.headers['x-installer-error']).toBeUndefined();
      expect(installed.body).toContain('$BASE_URL/host/spawn/setup-complete');
      expect(installed.body.indexOf('$BASE_URL/host/spawn/setup-complete')).toBeLessThan(installed.body.indexOf('  exit 0\nfi\n\nui_result_fail'));
      expect((await service.status({ operation_id: result.operation_id }, source)).state).toBe('installer_downloaded');
    } finally { await app.close(); }
  });
  it('serializes concurrent retries and rejects altered inputs and existing FQDNs without key rotation', async () => {
    const input = request();
    const [a, b] = await Promise.all([service.prepare(input, source), service.prepare(input, source)]); created.push(a.host_id);
    expect(a).toEqual(b);
    const [before] = await handle!.db.select().from(hosts).where(eq(hosts.id, a.host_id));
    await expect(service.prepare({ ...input, secure: false }, source)).rejects.toThrow(/Idempotency/);
    await expect(service.prepare({ ...input, client_message_id: randomUUID() }, source)).rejects.toThrow(/already registered/);
    const [after] = await handle!.db.select().from(hosts).where(eq(hosts.id, a.host_id));
    expect(after!.apiKeyHash).toBe(before!.apiKeyHash);
  });
  it('supports insecure targets and gates every request on current VIP, status and global state', async () => {
    const result = await service.prepare({ ...request(), secure: false }, source); created.push(result.host_id);
    const [target] = await handle!.db.select().from(hosts).where(eq(hosts.id, result.host_id));
    expect(target!.insecureEnabledUntil).toBeTruthy();
    await settings.setFlag(HOST_SPAWN_ENABLED_KEY, false);
    await expect(service.prepare(request(), source)).rejects.toThrow(/disabled/);
    await expect(service.status({ operation_id: result.operation_id }, source)).rejects.toThrow(/disabled/);
    await settings.setFlag(HOST_SPAWN_ENABLED_KEY, true);
    await handle!.db.update(hosts).set({ vip: 0 }).where(eq(hosts.id, source));
    await expect(service.prepare(request(), source)).rejects.toThrow(/VIP/);
    await expect(service.status({ operation_id: result.operation_id }, source)).rejects.toThrow(/VIP/);
    await handle!.db.update(hosts).set({ vip: 1, status: 'suspended' }).where(eq(hosts.id, source));
    await expect(service.prepare(request(), source)).rejects.toThrow(/VIP/);
    await handle!.db.update(hosts).set({ status: 'active' }).where(eq(hosts.id, source));
  });
  it('distinguishes download from installation and renews once per UUID without changing host keys', async () => {
    const result = await service.prepare(request(), source); created.push(result.host_id);
    const [before] = await handle!.db.select().from(hosts).where(eq(hosts.id, result.host_id));
    const renewal = { operation_id: result.operation_id, renew_installer: true, client_message_id: randomUUID() };
    await expect(service.status(renewal, source)).rejects.toThrow(/still available/);
    await handle!.db.update(installTokens).set({ usedAt: new Date().toISOString() }).where(eq(installTokens.hostId, result.host_id));
    expect((await service.status({ operation_id: result.operation_id }, source)).state).toBe('installer_downloaded');
    const renewed = await service.status(renewal, source);
    expect(renewed.installer.token).not.toBe(result.installer.token);
    expect((await service.status(renewal, source)).installer).toEqual(renewed.installer);
    const [after] = await handle!.db.select().from(hosts).where(eq(hosts.id, result.host_id));
    expect(after!.apiKeyHash).toBe(before!.apiKeyHash);
    await expect(service.prepare(request(), result.host_id)).rejects.toThrow(/VIP/);
  });
  it('starts a fixed deadline at first connection, fences new work and drains accepted work', async () => {
    const result = await service.prepare({ ...request(), daemon: { mode: 'timed', username: 'root', default_cwd: '/tmp', duration_minutes: 1 } }, source);
    created.push(result.host_id);
    expect((await daemon.settings(result.host_id)).settings.expires_at).toBeFalsy();
    const hello = await daemon.connect(result.host_id, { instance_id: randomUUID(), username: 'root', version: '0.9.53', engines: ['codex'], error: null });
    const deadline = hello.settings.expires_at!;
    const connected = await daemon.connect(result.host_id, { instance_id: (await daemon.settings(result.host_id)).runtime!.instance_id,
      username: 'root', version: '0.9.53', engines: ['codex'], error: null });
    expect(connected.settings.expires_at).toBe(deadline);
    const start = await daemon.start({ host_id: result.host_id, engine: 'codex', prompt: 'test', title: 'test', client_message_id: randomUUID() }, 'test');
    const offered = await daemon.offer(result.host_id, connected.generation);
    await daemon.accept(result.host_id, start.operation_id, offered!.claim_id);
    const queued = await daemon.start({ host_id: result.host_id, engine: 'codex', prompt: 'queued', title: 'queued', client_message_id: randomUUID() }, 'test');
    const settings = (await daemon.settings(result.host_id)).settings;
    await handle!.db.update(hostDaemons).set({ settings: { ...settings, expires_at: new Date(Date.now() - 1).toISOString() } }).where(eq(hostDaemons.hostId, result.host_id));
    await expect(daemon.start({ host_id: result.host_id, engine: 'codex', prompt: 'new', title: 'new', client_message_id: randomUUID() }, 'test')).rejects.toThrow(/available/);
    await daemon.heartbeat(result.host_id, connected.generation, ['codex'], null);
    const [pending] = await handle!.db.select().from(hostDaemonOperations).where(eq(hostDaemonOperations.id, queued.operation_id));
    expect(pending!.status).toBe('canceled');
    const [active] = await handle!.db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.id, start.session_id));
    expect(active!.status).toBe('running');
    await daemon.complete(result.host_id, start.operation_id, offered!.claim_id, { status: 'completed', reply: 'done' });
    expect((await daemon.session(start.session_id)).status).toBe('closed');
  });
});
