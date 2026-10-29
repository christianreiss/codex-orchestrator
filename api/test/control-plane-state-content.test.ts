import { AgentRoomChat } from '../src/services/agent-room-chat/index.js';
import { projectRoomEventDeletion } from '../src/control-plane/state/room-heads.js';
import { mutateOwnerState } from '../src/control-plane/state/runtime.js';
import { AgentMessagingGroups } from '../src/services/agent-messaging/groups.js';
import { ownedAddress, ownedBridge, requireOwnedMessaging } from '../src/control-plane/state/messaging.js';
import { AdminMemoryLifecycle } from '../src/services/admin-memory-lifecycle.js';
import { withNativePrincipal } from '../src/control-plane/state/native-principal.js';
import { ProjectBoardService } from '../src/services/project-board.js';
import { HostProjectsService } from '../src/services/host-projects.js';
import { SharedMemoriesService } from '../src/services/shared-memories.js';
import { ProjectContentService } from '../src/services/project-content.js';
import { ProjectsService } from '../src/services/projects.js';
import { SecretsService } from '../src/services/secrets.js';
import { McpMemoriesService } from '../src/services/mcp-memories.js';
import { AgentsService } from '../src/services/agents.js';
import { HostClaudeArtifactsService } from '../src/services/host-claude-artifacts.js';
import type { Host } from '../src/db/schema.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../src/db/schema.js';
import type { Database } from '../src/db/client.js';
import { OWNED_TABLE_NAMES, type StateSeed } from '../src/control-plane/state/catalog.js';
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
import { AgentPolicyProfilesService } from '../src/services/agent-policy-profiles.js';
import { SkillsService } from '../src/services/skills.js';
import { ClaudeArtifactsService } from '../src/services/claude-artifacts.js';
import { AgentCoordination } from '../src/services/agent-coordination/index.js';
import type { AgentMessagingService } from '../src/services/agent-messaging.js';
import { sha256 } from '../src/security/hash.js';
import { createDbFake } from './helpers/db-fake.js';
import { loadTestEnv, testKeyring } from './helpers/test-keyring.js';

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
  const service = new AgentCoordination(db, loadTestEnv(), testKeyring(), {} as AgentMessagingService);
  return { owner, state, select, fake, service, sessionId, token, instance, presence, attach, live, db };
}
describe('owner canonical content metadata', () => {
  it('keeps room commands, event heads and read positions coherent with SQL-free room lists', async () => {
    const h = setup(),
      bus = { isEnabled: async () => true } as AgentMessagingService,
      service = new AgentRoomChat(h.db, loadTestEnv(), testKeyring(), bus),
      actor = { adminId: 7, name: 'Operator' };
    const created = await service.create(actor, {
        client_request_id: randomUUID(),
        kind: 'group',
        title: 'Owner room',
      }),
      roomId = String(created.room_id);
    const request = { room_id: roomId, client_request_id: randomUUID(), content: 'Private room text' };
    const first = await service.send(actor, request);
    expect((await service.send(actor, request)).id).toBe(first.id);
    expect(h.state.snapshot().table('agentBusGroups').get(roomId)?.roomHead.eventCount).toBe(1);
    expect(h.state.snapshot().table('agentRoomEvents').get(first.id)).not.toHaveProperty('bodyEnc');
    h.select.mockClear();
    const execute = vi.spyOn(h.owner, 'execute');
    expect((await service.list({ adminId: 8 })).rooms[0]?.unread).toBe(1);
    expect((await service.list(actor)).rooms[0]?.unread).toBe(0);
    await service.access(actor, roomId, true);
    expect(h.select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await service.markRead({ adminId: 8 }, roomId, new Date(Date.now() + 1000).toISOString());
    expect((await service.list({ adminId: 8 })).rooms[0]?.unread).toBe(0);
    await expect(service.send(actor, { ...request, content: 'Different retry' })).rejects.toThrow(
      'Retry payload differs',
    );
    expect(h.state.snapshot().table('agentBusGroups').get(roomId)?.roomHead.eventCount).toBe(1);
    const stored = h.state.snapshot().table('agentRoomEvents').get(first.id)!;
    await mutateOwnerState(h.owner, {
      kind: 'room.test-retention',
      payload: {},
      prepare: (ctx) => {
        projectRoomEventDeletion(ctx.draft, stored, null);
        return null;
      },
    });
    expect(h.state.snapshot().table('agentBusGroups').get(roomId)?.roomHead).toEqual({
      eventCount: 0,
      lastAt: null,
      actorCounts: {},
    });
  });

  it('records an agent read position in the owner transaction and shows it per member', async () => {
    const h = setup(),
      bus = { isEnabled: async () => true } as AgentMessagingService,
      service = new AgentRoomChat(h.db, loadTestEnv(), testKeyring(), bus),
      operator = { adminId: 7, name: 'Operator' },
      agent = { sessionId: h.sessionId, token: h.token };
    const address = h.state.snapshot().table('agentSessions').get(h.sessionId)!.agentBusAddressId!;
    const created = await service.create(operator, {
      client_request_id: randomUUID(),
      kind: 'group',
      title: 'Owner read position',
      members: [address],
    });
    const roomId = String(created.room_id);
    const sent = await service.send(operator, { room_id: roomId, client_request_id: randomUUID(), content: 'Please read' });
    const position = async () =>
      (await service.read(operator, { room_id: roomId })).room.members.find((m) => m.id === address)?.read_through;
    expect(await position()).toBeNull();
    const inserts = () => h.fake.inserts.filter((i) => i.table === schema.agentRoomAgentReads);
    const read = await service.read(agent, { room_id: roomId });
    expect(read.events.map((e) => e.id)).toEqual([sent.id]);
    expect(read.room.members.find((m) => m.id === address)?.read_through).toBe(sent.created_at);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.values).toMatchObject({ roomId, addressId: address, readThrough: sent.created_at });
    expect(await position()).toBe(sent.created_at);
    // A repeated read of the same history writes nothing new.
    await service.read(agent, { room_id: roomId });
    expect(inserts()).toHaveLength(1);
  });

  it('keeps room reactions and pins cold, logs their changes and returns them on operator reads', async () => {
    const h = setup(),
      bus = { isEnabled: async () => true } as AgentMessagingService,
      service = new AgentRoomChat(h.db, loadTestEnv(), testKeyring(), bus),
      operator = { adminId: 7, name: 'Operator' },
      other = { adminId: 8, name: 'Other' };
    const roomId = String(
      (await service.create(operator, { client_request_id: randomUUID(), kind: 'group', title: 'Annotated' })).room_id,
    );
    const sent = await service.send(operator, { room_id: roomId, client_request_id: randomUUID(), content: 'Ship the release' });
    const changes = (kind: string) =>
      h.fake.inserts.filter((i) => i.table === schema.agentRoomChanges && (i.values as { kind: string }).kind === kind);
    const reaction = { room_id: roomId, event_id: sent.id, emoji: '👍', on: true, client_request_id: randomUUID() };
    expect(await service.react(operator, reaction)).toMatchObject({
      changed: true,
      reactions: [{ emoji: '👍', count: 1, mine: true }],
    });
    // A retry is a no-op by construction: no second row, no second change.
    expect((await service.react(operator, reaction)).changed).toBe(false);
    await service.react(other, { ...reaction, client_request_id: randomUUID() });
    expect(h.fake.inserts.filter((i) => i.table === schema.agentRoomReactions)).toHaveLength(2);
    expect(changes('reaction')).toHaveLength(2);
    expect(changes('reaction')[0]!.values).toMatchObject({ roomId, refId: sent.id });
    // Cold: nothing reaches owner RAM.
    expect(OWNED_TABLE_NAMES).not.toContain('agentRoomReactions');
    expect(OWNED_TABLE_NAMES).not.toContain('agentRoomPins');
    const read = await service.read(operator, { room_id: roomId });
    expect(read.events.find((e) => e.id === sent.id)?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect(read.pinned).toEqual([]);
    const pinRequest = { room_id: roomId, event_id: sent.id, on: true, client_request_id: randomUUID() };
    expect(await service.pin(operator, pinRequest)).toMatchObject({ changed: true, pinned: [sent.id] });
    // The operation receipt replays the original result; a changed body under the same id conflicts.
    expect(await service.pin(operator, pinRequest)).toMatchObject({ changed: true, pinned: [sent.id] });
    await expect(service.pin(operator, { ...pinRequest, on: false })).rejects.toThrow('Operation retry differs');
    expect(h.fake.inserts.filter((i) => i.table === schema.agentRoomPins)).toHaveLength(1);
    expect(changes('pin')).toHaveLength(1);
    expect((await service.read(other, { room_id: roomId })).pinned).toEqual([sent.id]);
    expect(await service.pins(operator, roomId)).toEqual({
      room_id: roomId,
      pins: [
        {
          event_id: sent.id,
          pinned_by: 'admin:7',
          pinned_at: expect.any(String),
          event: expect.objectContaining({ id: sent.id, snippet: 'Ship the release', name: 'Operator' }),
        },
      ],
    });
    await service.react(operator, { ...reaction, on: false, client_request_id: randomUUID() });
    const after = await service.read(operator, { room_id: roomId });
    expect(after.events.find((e) => e.id === sent.id)?.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    await expect(
      service.react(operator, { ...reaction, event_id: randomUUID(), client_request_id: randomUUID() }),
    ).rejects.toMatchObject({ status: 404, code: 'room_event_not_found' });
    // Agents never author reactions or pins.
    await expect(service.react({ sessionId: h.sessionId, token: h.token }, reaction)).rejects.toMatchObject({ status: 403 });
  });

  it('commits project content and event cursors together without retaining bodies', async () => {
    const now = new Date().toISOString(),
      h = setup({
        coordProjects: [
          {
            id: 42,
            slug: 'owner-project',
            title: 'Owner',
            description: '',
            about: null,
            latestEventSeq: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        ],
      } as unknown as StateSeed);
    const service = new ProjectContentService(h.db, new ProjectsService(h.db));
    const first = await service.upsertNote('owner-project', null, { header: 'First', body: 'Private body' });
    expect(h.state.snapshot().table('coordProjectNotes').get(first.note.id)).not.toHaveProperty('body');
    expect(h.state.snapshot().table('coordProjects').get(42)?.latestEventSeq).toBe(1);
    await service.upsertNote('owner-project', first.note.id, { header: 'Changed', body: 'New body' });
    await service.deleteNote('owner-project', first.note.id);
    const file = await service.upsertFile('owner-project', {
      stored_name: 'example.txt',
      content: 'Private file',
    });
    expect(h.state.snapshot().table('coordProjectFiles').get(file.file.id)).not.toHaveProperty('content');
    await service.deleteFile('owner-project', file.file.id);
    const feedback = await service.createFeedback('owner-project', {
      title: 'Issue',
      body: 'Detailed private issue',
    });
    expect(h.state.snapshot().table('coordProjectFeedback').get(feedback.feedback.id)).not.toHaveProperty(
      'body',
    );
    expect(h.state.snapshot().table('coordProjects').get(42)?.latestEventSeq).toBe(6);
    expect(h.select).not.toHaveBeenCalled();
  });
  it('serializes shared memory append and preserves compare-and-swap metadata', async () => {
    const h = setup(),
      service = new SharedMemoriesService(h.db);
    await service.write({ slug: 'owner.document', content: 'First body', title: 'Owner document' });
    await Promise.all([
      service.append({ slug: 'owner.document', content: 'Second' }),
      service.append({ slug: 'owner.document', content: 'Third' }),
    ]);
    const row = h.state.snapshot().table('sharedMemories').by('slug', 'owner.document')[0]!;
    expect(row.revision).toBe(3);
    expect(row.highestRevision).toBe(3);
    expect(row).not.toHaveProperty('content');
    expect(row.contentPreview).toContain('Second');
    expect(row.contentPreview).toContain('Third');
    await expect(
      service.write({ slug: 'owner.document', content: 'Overwrite', expected_sha256: '0'.repeat(64) }),
    ).rejects.toThrow();
    await service.delete({ slug: 'owner.document' });
    expect(h.state.snapshot().table('sharedMemories').get(row.id)?.deletedAt).toBeTruthy();
  });
  it('creates board todos and dependency metadata in one owner command', async () => {
    const now = new Date().toISOString(),
      h = setup({
        coordProjects: [
          {
            id: 42,
            slug: 'owner-project',
            aboutJson: { title: 'Owner' },
            rosterMarkdown: '',
            latestEventSeq: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        ],
      } as unknown as StateSeed);
    const projects = new HostProjectsService(h.db),
      board = new ProjectBoardService({ db: h.db, projects });
    const first = await board.todoCreate('owner-project', { title: 'First', detail: 'Task detail' }, 1);
    expect(first.todo.id).toBe(1);
    expect(h.state.snapshot().table('coordProjectCards').all()).toHaveLength(1);
    expect(h.state.snapshot().table('coordProjectBoardColumns').all()).toHaveLength(7);
    h.select.mockClear();
    expect(await board.todoRowsFor(42)).toHaveLength(1);
    expect(h.select).not.toHaveBeenCalled();
    await board.todoUpdate('owner-project', 1, { title: 'Updated', detail: 'Updated task' }, 1);
    await board.todoDelete('owner-project', 1, 1);
    expect(await board.todoRowsFor(42)).toHaveLength(0);
  });
  it.each([['timed', true], ['timed', false], ['connection', true]] as const)('keeps persisted %s board ownership semantics after restart (expired=%s)', async (mode, expired) => {
    const now = new Date().toISOString(), h = setup({ coordProjects: [{ id: 42, slug: 'owner-project', aboutJson: { title: 'Owner' }, rosterMarkdown: '', latestEventSeq: 0, createdAt: now, updatedAt: now, archivedAt: null }] } as unknown as StateSeed);
    const board = new ProjectBoardService({ db: h.db, projects: new HostProjectsService(h.db) });
    await board.todoCreate('owner-project', { title: 'Legacy', detail: 'Task' }, 1);
    const card = h.state.snapshot().table('coordProjectCards').all()[0]!;
    await mutateOwnerState(h.owner, { kind: 'test.legacy-board-claim', payload: {}, prepare(ctx) {
      ctx.draft.upsert('coordProjectCards', { ...card, claimRole: 'code', claimedByHostId: 1, claimedByUsername: 'old-owner', claimedAt: '2026-01-01T00:00:00Z', claimExpiresAt: expired ? '2026-01-01T00:30:00Z' : '2099-01-01T00:30:00Z', claimReleasedAt: null, claimOwnershipMode: mode, claimUncertaintyReason: 'owner_restart' }); return null;
    } });
    const result = await withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () => board.claimCard({ slug: 'owner-project', card: 1, role: 'code', username: 'root', worktree_path: '/repo' }, { id: 1 } as Host, 'codex'));
    expect(result.claimed).toBe(mode === 'timed' && expired);
    const final = h.state.snapshot().table('coordProjectCards').get(card.id)!;
    expect(final.claimOwnershipMode).toBe(mode === 'timed' && expired ? 'connection' : mode);
    expect(final.claimNativeInstanceId).toBe(mode === 'timed' && expired ? h.instance : null);
  });
  it('binds card claims to authenticated native identity and never frees on disconnect', async () => {
    const now = new Date().toISOString(),
      h = setup({
        coordProjects: [
          {
            id: 42,
            slug: 'owner-project',
            aboutJson: { title: 'Owner' },
            rosterMarkdown: '',
            latestEventSeq: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        ],
      } as unknown as StateSeed);
    const board = new ProjectBoardService({ db: h.db, projects: new HostProjectsService(h.db) }),
      host = { id: 1 } as Host;
    await board.todoCreate('owner-project', { title: 'First', detail: 'Task' }, 1);
    const args = { slug: 'owner-project', card: 1, role: 'code', username: 'root', worktree_path: '/repo' };
    await expect(board.claimCard(args, host, 'codex')).rejects.toThrow('Authenticated native session');
    const run = () =>
      withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () =>
        board.claimCard(args, host, 'codex'),
      );
    expect((await run()).claimed).toBe(true);
    const card = h.state.snapshot().table('coordProjectCards').all()[0]!;
    expect(card.claimSessionId).toBe(h.sessionId);
    expect(card.claimNativeInstanceId).toBe(h.instance);
    expect(card.claimExpiresAt).toBeNull();
    h.live.detach();
    await expect(run()).rejects.toThrow('native instance');
    expect(h.state.snapshot().table('coordProjectCards').get(card.id)?.claimReleasedAt).toBeNull();
    const wrong = h.attach(randomUUID());
    expect((await run()).claimed).toBe(false);
    wrong.detach();
    h.attach();
    expect((await run()).claimed).toBe(true);
  });
  it('accepts the workspace bound by agent_context_update as the card worktree and names a differing field', async () => {
    const now = new Date().toISOString(),
      h = setup({ coordProjects: [{ id: 42, slug: 'owner-project', aboutJson: { title: 'Owner' }, rosterMarkdown: '', latestEventSeq: 0, createdAt: now, updatedAt: now, archivedAt: null }] } as unknown as StateSeed);
    const board = new ProjectBoardService({ db: h.db, projects: new HostProjectsService(h.db) }),
      host = { id: 1 } as Host;
    await board.todoCreate('owner-project', { title: 'First', detail: 'Task' }, 1);
    await board.todoCreate('owner-project', { title: 'Second', detail: 'Task' }, 1);
    // The session launched in /repo, then rebound itself to a linked worktree
    // (nested repository: cwd below the worktree root). session.cwd stays /repo.
    await h.service.update(h.sessionId, h.token, {
      workspace: { cwd: '/tmp/worktrees/task/mobile', git_status: 'repository', git_root: '/tmp/worktrees/task', git_common_dir: '/repo/.git', branch: 'task' },
      project_slug: 'owner-project',
    });
    expect(h.state.snapshot().sessions.get(h.sessionId)?.cwd).toBe('/repo');
    const claim = (args: Record<string, unknown>, onHost: Host = host, engine = 'codex') =>
      withNativePrincipal({ sessionId: h.sessionId, bridgeToken: h.token }, () =>
        board.claimCard({ slug: 'owner-project', role: 'code', ...args }, onHost, engine),
      );
    expect((await claim({ card: 1, username: 'root', worktree_path: '/tmp/worktrees/task' })).claimed).toBe(true);
    expect((await claim({ card: 2, worktree_path: '/tmp/worktrees/task/mobile' })).claimed).toBe(true);
    expect((await claim({ card: 1 })).claimed).toBe(true);
    const cards = h.state.snapshot().table('coordProjectCards').all();
    expect(cards.map((card) => card.claimedWorktreePath)).toEqual(['/tmp/worktrees/task', '/tmp/worktrees/task']);
    expect(cards.every((card) => card.claimSessionId === h.sessionId && card.claimedByUsername === 'root')).toBe(true);
    // A genuinely different actor stays refused, and the error names the field.
    const mismatch = async (args: Record<string, unknown>, field: string, onHost?: Host, engine?: string) => {
      const error = await claim({ card: 1, ...args }, onHost, engine).then(() => null, (e: unknown) => e as { code?: string; message: string; extra?: { fields?: string[] } });
      expect(error?.code).toBe('card_identity_mismatch');
      expect(error?.message).toContain(field);
      expect(error?.extra?.fields).toEqual([field]);
    };
    await mismatch({ worktree_path: '/repo' }, 'worktree_path');
    await mismatch({ worktree_path: '/tmp/worktrees/other' }, 'worktree_path');
    await mismatch({ username: 'mallory', worktree_path: '/tmp/worktrees/task' }, 'username');
    await mismatch({}, 'engine', host, 'claude');
    await mismatch({}, 'host', { id: 2 } as Host);
  });
  it('keeps admin memory ETags, shared revisions and audit changes in the owner transaction', async () => {
    const now = new Date().toISOString(),
      h = setup({
        coordProjects: [
          {
            id: 42,
            slug: 'owner-project',
            aboutJson: { title: 'Owner' },
            rosterMarkdown: '',
            latestEventSeq: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        ],
      } as unknown as StateSeed),
      service = new AdminMemoryLifecycle(h.db);
    for (const scope of ['host', 'project', 'shared'] as const) {
      const created = await service.create(
        scope,
        {
          id: 'admin.fixture',
          content: 'Initial',
          ...(scope === 'host'
            ? { host_id: 1 }
            : scope === 'project'
              ? { project_slug: 'owner-project' }
              : {}),
        },
        7,
      );
      expect(created.memory.content).toBe('Initial');
      const updated = await service.update(
        scope,
        created.memory.record_id,
        { content: 'Changed', expected_etag: created.memory.etag },
        7,
      );
      expect(updated.memory.content).toBe('Changed');
      await expect(
        service.update(
          scope,
          created.memory.record_id,
          { content: 'Stale', expected_etag: created.memory.etag },
          7,
        ),
      ).rejects.toThrow();
      let current = updated.memory;
      if (scope === 'shared') {
        const appended = await service.appendShared(current.record_id, 'Append', 7);
        expect(appended.memory.content).toContain('Append');
        current = appended.memory;
      }
      await service.remove(scope, current.record_id, current.etag, 7);
    }
    expect(h.state.snapshot().table('mcpMemories').all()).toHaveLength(0);
    expect(h.state.snapshot().table('coordProjectMemories').all()).toHaveLength(0);
    expect(h.state.snapshot().table('sharedMemories').all()).toHaveLength(0);
  });
  it('answers group discovery from RAM and persists publication idempotency with membership', async () => {
    const h = setup(),
      groups = new AgentMessagingGroups({
        db: h.db,
        keyring: testKeyring(),
        requireEnabledLocked: async () => requireOwnedMessaging(h.state.snapshot()),
        authenticateBridge: async (id, token) => ownedBridge(h.state.snapshot(), id, token),
        requireAddressLocked: async (_db, id) => ownedAddress(h.state.snapshot(), id),
        assertSessionAddressLocked: async () => {},
        assertAddressEligibleLocked: async (_db, address) => {
          ownedAddress(h.state.snapshot(), address.id);
        },
      } as ConstructorParameters<typeof AgentMessagingGroups>[0]);
    const created = await groups.createForAgent(h.sessionId, h.token, {
      slug: 'owner-group',
      title: 'Owner group',
    });
    expect(created.created).toBe(true);
    await groups.subscribe(h.sessionId, h.token, 'group:owner-group', true);
    const publication = {
      topic: 'group:owner-group',
      content: 'Informational',
      clientMessageId: randomUUID(),
    };
    const first = await groups.publishForAgent(h.sessionId, h.token, publication);
    expect(first.created).toBe(true);
    expect(first.recipient_count).toBe(0);
    expect((await groups.publishForAgent(h.sessionId, h.token, publication)).created).toBe(false);
    h.select.mockClear();
    const execute = vi.spyOn(h.owner, 'execute');
    expect((await groups.listForAgent(h.sessionId, h.token)).groups[0]?.member_count).toBe(1);
    expect((await groups.detailForAgent(h.sessionId, h.token, 'owner-group')).members).toHaveLength(1);
    expect((await groups.subscriptionsForAgent(h.sessionId, h.token)).subscriptions).toHaveLength(1);
    expect(h.select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await groups.deleteForAgent(h.sessionId, h.token, 'owner-group');
    expect(h.state.snapshot().table('agentBusGroups').all()).toHaveLength(0);
    expect(h.state.snapshot().table('agentBusSubscriptions').all()).toHaveLength(0);
    expect(h.state.snapshot().table('agentBusPublications').all()).toHaveLength(1);
  });
  it('publishes profile creation, assignment and default changes before RAM resolution', async () => {
    const h = setup(),
      profiles = new AgentPolicyProfilesService(h.db);
    const profile = await profiles.create({ name: 'owner profile' });
    await profiles.assign(1, profile.id);
    await profiles.setDefault(profile.id);
    expect((await profiles.list())[0]?.host_ids).toEqual([1]);
    expect(await profiles.resolveForHost(1)).toEqual(profile.levels);
    await expect(profiles.remove(profile.id)).rejects.toThrow('default profile');
    expect(h.select).not.toHaveBeenCalled();
  });
  it('stages skill and Claude metadata without retaining content bodies', async () => {
    const h = setup(),
      skills = new SkillsService(h.db),
      artifacts = new ClaudeArtifactsService(h.db);
    await skills.store({ slug: 'owner-fixture', manifest: '# Owner fixture' });
    const skill = h.state.snapshot().table('skills').by('slug', 'owner-fixture')[0]!;
    expect(skill.sha256).toHaveLength(64);
    expect(skill).not.toHaveProperty('manifest');
    await skills.store({ slug: 'owner-fixture', manifest: '# Changed fixture' });
    expect(h.state.snapshot().table('skills').get(skill.id)?.sha256).not.toBe(skill.sha256);
    await skills.softDelete('owner-fixture');
    expect(h.state.snapshot().table('skills').get(skill.id)?.deletedAt).toBeTruthy();
    await artifacts.store('command', {
      slug: 'owner-command',
      description: 'Explain a change',
      content: 'Explain the change',
    });
    const artifact = h.state.snapshot().table('claudeArtifacts').by('slug', 'owner-command')[0]!;
    expect(artifact).not.toHaveProperty('body');
    await artifacts.softDelete('command', 'owner-command');
    expect(h.state.snapshot().table('claudeArtifacts').get(artifact.id)?.deletedAt).toBeTruthy();
    expect(h.select).not.toHaveBeenCalled();
  });
  it('publishes generated document identities and prunes only unpinned history', async () => {
    const h = setup(),
      agents = new AgentsService(h.db, async () => 1);
    const first = await agents.store('First canonical policy', null, null, 'codex');
    expect(h.state.snapshot().table('agentsDocuments').get(first.version_id)?.sha256).toBe(first.sha256);
    await agents.setServeMode('locked', first.version_id, 'codex');
    await agents.store('Second canonical policy', null, null, 'codex');
    await agents.store('Third canonical policy', null, null, 'codex');
    expect(h.state.snapshot().table('agentsDocuments').get(first.version_id)).toBeDefined();
    expect(h.state.snapshot().table('agentsDocuments').all()).toHaveLength(3);
    expect(h.state.snapshot().table('agentsDocumentState').get(1)?.activeDocumentId).toBe(first.version_id);
  });
  it('answers unchanged Claude bundles from metadata without SQL', async () => {
    const h = setup(),
      artifacts = new ClaudeArtifactsService(h.db),
      hosts = new HostClaudeArtifactsService(h.db);
    const stored = await artifacts.store('command', {
      slug: 'metadata-command',
      description: 'Metadata fixture',
      content: 'Explain',
    });
    const result = await hosts.bundle({ id: 1 } as Host, 'claude', {
      command: { 'metadata-command': stored.sha256 },
    });
    expect(result.command[0]?.status).toBe('unchanged');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('stores host memory metadata without retaining its private content', async () => {
    const h = setup(),
      service = new McpMemoriesService(h.db),
      host = { id: 1 } as Host;
    const result = await service.store({ id: 'fixture', content: 'private memory' }, host, 'codex');
    expect(result.status).toBe('created');
    expect(h.state.snapshot().table('mcpMemories').all()[0]).not.toHaveProperty('content');
    await service.delete({ id: 'fixture' }, host);
    expect(h.state.snapshot().table('mcpMemories').all()[0]?.deletedAt).toBeTruthy();
  });
  it('audits secret access without putting ciphertext or plaintext into owner state or receipts', async () => {
    const h = setup(),
      service = new SecretsService({ db: h.db, keyring: testKeyring() }),
      host = { id: 1 } as Host;
    await service.setEnabled(true);
    const command = vi.spyOn(h.owner, 'execute');
    await service.storeForHost(
      { slug: 'owner-secret', name: 'Owner secret', value: 'private fixture value' },
      host,
      'codex',
    );
    const row = h.state.snapshot().table('secrets').all()[0]!;
    expect(row).not.toHaveProperty('valueEnc');
    h.select.mockClear();
    expect(await service.listForHost(1)).toHaveLength(1);
    expect(h.select).not.toHaveBeenCalled();
    expect((await service.getForHost('owner-secret', host, 'codex')).value).toBe('private fixture value');
    for (const result of command.mock.results)
      expect(JSON.stringify(await result.value)).not.toContain('private fixture value');
    await expect(
      service.storeForHost(
        { slug: 'owner-secret', name: 'Other', value: 'overwrite' },
        { id: 2 } as Host,
        'claude',
      ),
    ).rejects.toThrow('another host');
    await service.deleteForHost('owner-secret', host, 'codex');
    await expect(service.getForHost('owner-secret', host, 'codex')).rejects.toThrow('No such secret');
  });
});
