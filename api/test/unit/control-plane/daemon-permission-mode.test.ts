import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../src/control-plane/presence.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring, loadTestEnv } from '../../helpers/test-keyring.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import {
  PLAN_MODE_ADDENDUM,
  assertPermissionMode,
  permissionModesFor,
  planModePrompt,
  storedPermissionMode,
} from '../../../src/services/host-daemon/permission-mode.js';

const queues: DeadlineQueue[] = [];
afterEach(() => queues.splice(0).forEach((q) => q.close()));

/** Owner-mode daemon harness (same shape as daemon-owned.test.ts). */
function harness() {
  const now = new Date().toISOString();
  const seed = {
    hosts: [{ id: 1, fqdn: 'fixture', apiKey: 'test', apiKeyHash: null, status: 'active', configVersion: 0, secure: 1, authDigest: 'a', claudeAuthDigest: 'a', grokAuthDigest: 'a',
      engines: 'codex,claude,grok', internalRole: null, expiresAt: null, insecureEnabledUntil: null }],
    hostDaemons: [{ hostId: 1, settings: daemonSettingsSchema.parse({ enabled: true, username: 'user' }), runtime: null, enabledAt: now, updatedAt: now }],
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
  };
  const fake = createDbFake(
    new Map(Object.entries(seed).map(([name, values]) => [(schema as unknown as Record<string, unknown>)[name], structuredClone(values)])),
  );
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed));
  const deadlines = new DeadlineQueue((e) => { throw e; });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) { throw e; },
    committed() {},
    notificationError(e) { throw e; },
    persistence: {
      async receipt() { return undefined; },
      async transaction(run) { await run(fake as unknown as PersistenceTransaction); },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  bindOwnerRuntime(fake, runtime);
  bindOwnerPresence(runtime, new ConnectionPresence((e) => { throw e; }));
  const ctx = { db: fake, keyring: testKeyring(), env: loadTestEnv() } as unknown as RouteContext;
  return { state, service: new HostDaemonService(ctx) };
}
const connect = (h: ReturnType<typeof harness>, capable: boolean) =>
  h.service.connect(1, {
    instance_id: randomUUID(),
    username: 'user',
    version: capable ? '0.9.146' : '0.9.145',
    engines: ['codex', 'claude', 'grok'],
    error: null,
    ...(capable ? { permission_mode_version: 1 } : {}),
  });
const start = (h: ReturnType<typeof harness>, engine: 'codex' | 'claude' | 'grok', key: string, mode?: 'plan' | 'default') =>
  h.service.start(
    { host_id: 1, engine, title: 'plan', prompt: 'Refactor the parser', client_message_id: key, ...(mode ? { permission_mode: mode } : {}) },
    'admin:1',
  );

describe('permission mode policy', () => {
  it('advertises plan only for Claude and Grok on a capable wrapper', () => {
    expect(permissionModesFor('claude', 1)).toEqual(['default', 'plan']);
    expect(permissionModesFor('grok', 1)).toEqual(['default', 'plan']);
    expect(permissionModesFor('codex', 1)).toEqual(['default']);
    expect(permissionModesFor('claude', 0)).toEqual(['default']);
    expect(permissionModesFor('claude', undefined)).toEqual(['default']);
  });
  it('rejects Codex with 422 and an old wrapper with 409; default always passes', () => {
    expect(() => assertPermissionMode('codex', 'plan', { permission_mode_version: 1 })).toThrow(
      expect.objectContaining({ status: 422, code: 'permission_mode_engine_unsupported' }),
    );
    expect(() => assertPermissionMode('claude', 'plan', { permission_mode_version: 0 })).toThrow(
      expect.objectContaining({ status: 409, code: 'permission_mode_unsupported' }),
    );
    expect(() => assertPermissionMode('claude', 'plan', null)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => assertPermissionMode('codex', 'default', null)).not.toThrow();
    expect(() => assertPermissionMode('grok', 'plan', { permission_mode_version: 1 })).not.toThrow();
  });
  it('stores only plan and appends the plan addendum only in plan mode', () => {
    expect(storedPermissionMode('plan')).toBe('plan');
    expect(storedPermissionMode('default')).toBeNull();
    expect(storedPermissionMode(undefined)).toBeNull();
    expect(planModePrompt('task', 'plan')).toBe(`task\n\n${PLAN_MODE_ADDENDUM}`);
    expect(planModePrompt('task', null)).toBe('task');
    expect(PLAN_MODE_ADDENDUM).toContain('cxx portal ask');
    expect(PLAN_MODE_ADDENDUM).toMatch(/approve.*reject.*revise/i);
  });
});

describe('owner-mode daemon sessions with a permission mode', () => {
  it('rejects plan for Codex and for a wrapper without the capability', async () => {
    const h = harness();
    await connect(h, false);
    await expect(start(h, 'claude', randomUUID(), 'plan')).rejects.toMatchObject({ status: 409, code: 'permission_mode_unsupported' });
    await expect(start(h, 'codex', randomUUID(), 'plan')).rejects.toMatchObject({ status: 422 });
    expect(h.state.snapshot().table('hostDaemonSessions').all()).toEqual([]);
  });
  it('persists plan, offers it with the addendum on every turn and keeps idempotency exact', async () => {
    const h = harness();
    const hello = await connect(h, true);
    const key = randomUUID();
    const started = await start(h, 'claude', key, 'plan');
    expect(h.state.snapshot().table('hostDaemonSessions').get(started.session_id)?.permissionMode).toBe('plan');
    expect(await start(h, 'claude', key, 'plan')).toEqual(started);
    await expect(start(h, 'claude', key)).rejects.toThrow('Idempotency key reused');
    const offer = await h.service.offer(1, hello.generation);
    expect(offer?.permission_mode).toBe('plan');
    expect(offer?.prompt).toBe(`Refactor the parser\n\n${PLAN_MODE_ADDENDUM}`);
  });
  it('treats an explicit default exactly like no mode', async () => {
    const h = harness();
    const hello = await connect(h, false);
    const key = randomUUID();
    const started = await start(h, 'codex', key, 'default');
    expect(await start(h, 'codex', key)).toEqual(started);
    expect(h.state.snapshot().table('hostDaemonSessions').get(started.session_id)?.permissionMode).toBeNull();
    const offer = await h.service.offer(1, hello.generation);
    expect(offer?.permission_mode).toBe('');
    expect(offer?.prompt).toBe('Refactor the parser');
  });
  it('never offers a plan turn to a daemon that reconnected without the capability', async () => {
    const h = harness();
    await connect(h, true);
    const started = await start(h, 'grok', randomUUID(), 'plan');
    const downgraded = await connect(h, false);
    expect(await h.service.offer(1, downgraded.generation)).toBeNull();
    expect(h.state.snapshot().table('hostDaemonOperations').get(started.operation_id)?.status).toBe('queued');
  });
  it('switches to default for the next offer, idempotently, for the owner only', async () => {
    const h = harness();
    const hello = await connect(h, true);
    const started = await start(h, 'claude', randomUUID(), 'plan');
    await expect(h.service.setPermissionMode(started.session_id, 'default', 'admin:2')).rejects.toThrow('creating agent');
    expect(await h.service.setPermissionMode(started.session_id, 'default', 'admin:1')).toEqual({
      session_id: started.session_id,
      permission_mode: 'default',
      changed: true,
    });
    expect((await h.service.setPermissionMode(started.session_id, 'default', 'admin:1')).changed).toBe(false);
    const offer = await h.service.offer(1, hello.generation);
    expect(offer?.permission_mode).toBe('');
    expect(offer?.prompt).toBe('Refactor the parser');
    await expect(h.service.setPermissionMode(randomUUID(), 'plan', 'admin:1')).rejects.toThrow('not found');
  });
  it('refuses a mode change on an ended session', async () => {
    const h = harness();
    await connect(h, true);
    const started = await start(h, 'claude', randomUUID());
    await h.service.stop(started.session_id, 'admin:1');
    await expect(h.service.setPermissionMode(started.session_id, 'plan', 'admin:1')).rejects.toMatchObject({
      status: 409,
      code: 'daemon_session_unavailable',
    });
  });
});

describe('companion start schema with a permission mode', () => {
  it('accepts plan with a task, rejects plan without one and unknown modes', async () => {
    const { companionStartSchema } = await import('../../../src/services/companion/remote.js');
    const base = { host_id: 1, engine: 'claude', client_message_id: randomUUID() };
    expect(companionStartSchema.parse({ ...base, task: 'Plan the refactor', permission_mode: 'plan' }).permission_mode).toBe('plan');
    expect(companionStartSchema.parse({ ...base }).permission_mode).toBeUndefined();
    expect(companionStartSchema.safeParse({ ...base, permission_mode: 'plan' }).success).toBe(false);
    expect(companionStartSchema.safeParse({ ...base, task: 'x', permission_mode: 'bypassPermissions' }).success).toBe(false);
  });
});
