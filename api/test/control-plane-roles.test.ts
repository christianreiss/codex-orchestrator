import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../src/db/schema.js';
import type { Database } from '../src/db/client.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
import { CommandExecutor } from '../src/control-plane/commands.js';
import type { PersistenceTransaction } from '../src/control-plane/persistence.js';
import { DeadlineQueue } from '../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../src/control-plane/presence.js';
import {
  OwnerStateStore,
  OwnerStateSnapshot,
  type PreparedOwnerState,
} from '../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../src/control-plane/state/runtime.js';
import { sha256 } from '../src/security/hash.js';
import { createDbFake } from './helpers/db-fake.js';
import { RolesService } from '../src/services/roles.js';
import { SettingsService } from '../src/services/settings.js';
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function setup(extra: StateSeed = {}) {
  const sessionId = randomUUID(),
    addressId = randomUUID(),
    instance = randomUUID(),
    now = new Date().toISOString(),
    key = 'owner-coordination-host',
    token = 'bridge-proof';
  const seed = {
    ...extra,
    hosts: [
      {
        id: 1,
        fqdn: 'owner.test',
        apiKey: key,
        apiKeyHash: null,
        status: 'active',
        secure: 1,
        engines: 'codex',
        internalRole: null,
        expiresAt: null,
      },
    ],
    versions: [
      { name: 'agent_messaging_enabled', version: '1', updatedAt: now },
      { name: 'agent_coordination_enabled', version: '1', updatedAt: now },
      { name: 'roles_enabled', version: '1', updatedAt: now },
    ],
    agentSessions: [
      {
        id: sessionId,
        hostId: 1,
        agentBusAddressId: addressId,
        engine: 'codex',
        username: 'root',
        cwd: '/repo',
        workspace: null,
        launchName: 'Fixture',
        bindingGeneration: 1,
        bridgeTokenHash: sha256(token),
        hostAuthFingerprint: sha256(key),
        bridgeExpiresAt: '2099-01-01T00:00:00Z',
        endedAt: null,
        upstreamSessionId: null,
        adapterCapabilities: { scope_protocol_version: 1 },
      },
    ],
    agentBusAddresses: [
      {
        id: addressId,
        address: `agent:${addressId}`,
        hostId: 1,
        engine: 'codex',
        currentSessionId: sessionId,
        bindingGeneration: 1,
        enabled: 1,
        archivedAt: null,
        launchName: 'Fixture',
      },
    ],
  };
  const fake = createDbFake(
    new Map(
      Object.entries(seed).map(([name, rows]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone([...rows]),
      ]),
    ),
  );
  const db = fake as unknown as Database,
    select = vi.spyOn(fake, 'select');
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  closers.push(() => deadlines.close());
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(error) {
      throw error;
    },
    committed() {},
    notificationError(error) {
      throw error;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(fake as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const owner: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  bindOwnerRuntime(db, owner);
  const presence = new ConnectionPresence((error) => {
    throw error;
  });
  bindOwnerPresence(owner, presence);
  closers.push(() => presence.close());
  const attach = (native = instance) =>
    presence.attach({
      connectionId: randomUUID(),
      hostId: 1,
      username: 'root',
      scope: { topic: 'session', session_id: sessionId, binding_generation: 1, native_instance_id: native },
    });
  const live = attach();

  return { owner, state, select, fake, sessionId, token, instance, presence, attach, live, db };
}

const manifest = (body = 'Perform careful review.') => '---\nname: owner-role\nlabel: Reviewer\n---\n' + body;
const actor = { kind: 'admin' as const, admin_user_id: 7 };
describe('authoritative role commands', () => {
  it('publishes immutable versions and serves current/catalog metadata without SQL', async () => {
    const h = setup();
    const roles = new RolesService({ db: h.db, settings: new SettingsService(h.db), notifyOwned() {} });
    await roles.createRole({ slug: 'owner-role', display_name: 'Owner role', summary: 'Review' }, actor);
    await roles.saveDraft(
      'owner-role',
      { manifest: manifest(), files: [{ path: 'guide.md', content: 'Core guide', load: 'core' }] },
      actor,
    );
    expect(h.state.snapshot().table('agentRoleVersions').all()[0]).not.toHaveProperty('manifest');
    expect(h.state.snapshot().table('agentRoleVersions').all()[0]?.roleLabel).toBe('Reviewer');
    await roles.publishDraft('owner-role', {}, actor);
    const activated = await roles.activate(h.sessionId, h.token, {
      role: 'owner-role',
      reason: 'Operator assigned',
      client_request_id: randomUUID(),
    });
    expect(activated.role.version).toBe(1);
    expect(activated.core_files?.[0]?.text).toBe('Core guide');
    h.select.mockClear();
    const commands = vi.spyOn(h.owner, 'execute');
    expect((await roles.current(h.sessionId, h.token, {})).active).toBe(true);
    expect((await roles.catalog()).roles).toHaveLength(1);
    expect((await roles.listAdmin()).roles[0]?.holders).toBe(1);
    expect(h.select).not.toHaveBeenCalled();
    expect(commands).not.toHaveBeenCalled();
    await roles.release(h.sessionId, h.token, { reason: 'Finished assignment' });
    expect((await roles.current(h.sessionId, h.token, {})).active).toBeNull();
    await roles.updateRole('owner-role', { expected_version: 1, summary: 'Changed' });
    await expect(roles.updateRole('owner-role', { expected_version: 1, summary: 'Stale' })).rejects.toThrow(
      'changed since',
    );
  });
  it('composes proposals, gates and operator decisions', async () => {
    const h = setup();
    const roles = new RolesService({ db: h.db, settings: new SettingsService(h.db), notifyOwned() {} });
    await roles.createRole({ slug: 'owner-role', display_name: 'Owner role', summary: 'Review' }, actor);
    await roles.saveDraft('owner-role', { manifest: manifest() }, actor);
    await roles.publishDraft('owner-role', {}, actor);
    await roles.activate(h.sessionId, h.token, {
      role: 'owner-role',
      reason: 'Assigned',
      client_request_id: randomUUID(),
    });
    const first = await roles.propose(h.sessionId, h.token, {
      kind: 'file_add',
      title: 'Add guide',
      rationale: 'Reusable guidance',
      ops: [{ op: 'put', path: 'guide.md', content: 'Useful guidance' }],
      client_request_id: randomUUID(),
    });
    expect(first.proposal.status).toBe('checking');
    expect(first.proposal.gate_results?.passed).toBe(true);
    const before = h.state.revision().sequence,
      decided = await roles.decide(
        first.proposal.id,
        { verdict: 'accept', reason: 'Reviewed', expected_version: first.proposal.version },
        actor,
      );
    expect('proposal' in decided && decided.proposal.status).toBe('applied');
    expect(h.state.revision().sequence).toBe(before + 1n);
    expect(
      h.state
        .snapshot()
        .table('agentRoleVersions')
        .all()
        .filter((v) => v.state === 'published'),
    ).toHaveLength(2);
    await expect(
      roles.decide(
        first.proposal.id,
        { verdict: 'reject', reason: 'Stale operator', expected_version: first.proposal.version },
        actor,
      ),
    ).rejects.toThrow('changed since');
    await roles.withdraw('owner-role', 2, { reason: 'Faulty guidance' });
    expect((await roles.catalog()).roles[0]?.current_version).toBe(1);
  });
  it('rejects a stale external judge result and performs no idle SQL or commands', async () => {
    const h = setup();
    const judge = {
      model: 'fixture',
      async judge() {
        const proposal = h.state.snapshot().table('agentRoleProposals').all()[0]!;
        await roles.decide(
          proposal.id,
          {
            verdict: 'reject',
            reason: 'Operator rejects while judge is running',
            expected_version: proposal.version,
          },
          actor,
        );
        return { verdict: 'accept' as const, reason: 'Stale judgment', model: 'fixture' };
      },
    };
    const roles = new RolesService({
      db: h.db,
      settings: new SettingsService(h.db),
      judge,
      notifyOwned() {},
    });
    await roles.createRole({ slug: 'owner-role', display_name: 'Owner role', summary: 'Review' }, actor);
    await roles.saveDraft('owner-role', { manifest: manifest() }, actor);
    await roles.publishDraft('owner-role', {}, actor);
    await roles.activate(h.sessionId, h.token, {
      role: 'owner-role',
      reason: 'Assigned',
      client_request_id: randomUUID(),
    });
    await roles.propose(h.sessionId, h.token, {
      kind: 'file_add',
      title: 'Add guide',
      rationale: 'Reusable guidance',
      ops: [{ op: 'put', path: 'guide.md', content: 'Guidance' }],
      client_request_id: randomUUID(),
    });
    await roles.processDue(new Date(Date.now() + 2000));
    expect(h.state.snapshot().table('agentRoleProposals').all()[0]?.status).toBe('rejected');
    expect(h.state.snapshot().table('agentRoleVersions').all()).toHaveLength(1);
    h.select.mockClear();
    const commands = vi.spyOn(h.owner, 'execute');
    await roles.processDue();
    expect(h.select).not.toHaveBeenCalled();
    expect(commands).not.toHaveBeenCalled();
  });
});
