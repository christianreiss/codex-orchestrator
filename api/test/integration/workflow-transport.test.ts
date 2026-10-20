import Fastify from 'fastify';
import { ZodError } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentBusAddresses, agentBusGroups, agentBusMessages, agentBusSubscriptions, agentChatAttachments, agentRoomDeliveries, agentRoomEvents, agentSessions, hosts, workflowRunMembers, workflowRuns } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrator.js';
import { AgentMessagingService } from '../../src/services/agent-messaging.js';
import { AgentRoomChat } from '../../src/services/agent-room-chat/index.js';
import { createWorkflowCollaboration } from '../../src/services/agent-messaging/workflows.js';
import { createWorkflowsService, registerWorkflowBridgeRoutes } from '../../src/routes/agent-messaging/workflows.js';
import type { RouteContext } from '../../src/routes/index.js';
import { assertWorkflowAttachmentWrite } from '../../src/services/workflow-run-group.js';
import { SettingsService } from '../../src/services/settings.js';
import { ApiError } from '../../src/http/errors.js';
import { McpToolsRegistry } from '../../src/services/mcp-tools.js';
import { McpResourcesService } from '../../src/services/mcp-resources.js';
import type { WorkflowActor } from '../../src/services/workflows/contract.js';
import { decrypt } from '../../src/security/secret-box.js';
import { getTestDb } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { markPersistentHost, persistRelayUsers } from '../helpers/persistent-host.js';

const handle = await getTestDb();
describe.skipIf(!handle)('workflow collaboration transport with MySQL', { timeout: 120000 }, () => {
  const db = handle?.db as NonNullable<typeof handle>['db'];
  const runId = randomUUID(), admin = { adminId: 8675309, name: 'Workflow operator' };
  const peers: { hostId: number; sessionId: string; token: string; addressId: string; actor: WorkflowActor }[] = [];
  const bridgeRuns: string[] = [], workflowIds: string[] = [];
  let bus: AgentMessagingService, chat: AgentRoomChat, collaboration: ReturnType<typeof createWorkflowCollaboration>, root: string, groupId: string;
  const roomActor = (i: number) => ({ sessionId: peers[i]!.sessionId, token: peers[i]!.token });
  const active = () => peers.slice(0, 3).map(p => p.actor);
  const txn = <T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(async tx => { await collaboration.lock(tx, peers[0]!.actor); return fn(tx); });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-transport-'));
    await runMigrations(handle!.pool);
    const env = { ...loadTestEnv(), DATA_ROOT: root };
    bus = persistRelayUsers(db, new AgentMessagingService(db, env, testKeyring()));
    await bus.setEnabled(true);
    chat = new AgentRoomChat(db, env, testKeyring(), bus);
    collaboration = createWorkflowCollaboration(bus, 'https://workflow.example');
    for (const [index, engine] of ['codex', 'claude', 'grok', 'codex'].entries()) {
      const now = new Date().toISOString(), fqdn = `ztest-workflow-transport-${index}.example`;
      await db.execute(sql`INSERT INTO hosts (fqdn,api_key,status,secure,engines,wrapper_version,agent_messaging_enabled,created_at,updated_at) VALUES (${fqdn},${randomBytes(32).toString('hex')},'active',1,${engine},'0.9.111',1,${now},${now})`);
      const host = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
      await markPersistentHost(db, host.id);
      const sessionId = randomUUID(), token = randomBytes(32).toString('base64url');
      const registered = await bus.registerSession(host, { engine: engine as 'codex' | 'claude' | 'grok', username: 'workflow-test', cwd: `/tmp/workflow-${index}`, sessionId, bridgeToken: token, invocationKind: 'interactive', adapterProtocol: 'workflow-test-v1', adapterCapabilities: { workflow_protocol_version: 1, shared_room_chat_version: 1, execution_contract_version: 2 } });
      const addressId = String((registered.address as { id: string }).id);
      const actor = await db.transaction(tx => collaboration.resolveTarget(tx, addressId));
      peers.push({ hostId: host.id, sessionId, token, addressId, actor });
    }
    const now = new Date().toISOString();
    await db.insert(workflowRuns).values({ id: runId, workflowId: randomUUID(), workflowVersionId: randomUUID(), workflowVersion: 1, workflowSha256: '0'.repeat(64), title: 'Transport acceptance', inputs: {}, status: 'running', actor: { ...peers[0]!.actor }, createdAt: now, updatedAt: now });
    for (const p of peers.slice(0, 3)) await db.insert(workflowRunMembers).values({ id: randomUUID(), runId, agentAddressId: p.addressId, sessionId: p.sessionId, bindingGeneration: p.actor.binding_generation!, status: 'active', actor: { ...p.actor }, createdAt: now, updatedAt: now });
  });
  afterAll(async () => {
    const moreRooms = bridgeRuns.length ? await db.select({ id: workflowRuns.communicationGroupId }).from(workflowRuns).where(inArray(workflowRuns.id, bridgeRuns)) : [];
    for (const id of moreRooms.map(r => r.id).filter(Boolean) as string[]) {
      await db.execute(sql`DELETE FROM agent_bus_subscriptions WHERE topic IN (SELECT CONCAT('group:',slug) FROM agent_bus_groups WHERE id=${id})`);
      await db.delete(agentBusGroups).where(eq(agentBusGroups.id, id));
    }
    for (const id of bridgeRuns) for (const table of ['workflow_run_events', 'workflow_task_attempts', 'workflow_run_evaluations', 'workflow_run_invitations', 'workflow_run_tasks', 'workflow_run_members'])
      await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE run_id=${id}`);
    if (bridgeRuns.length) await db.delete(workflowRuns).where(inArray(workflowRuns.id, bridgeRuns));
    for (const id of workflowIds) { await db.execute(sql`DELETE FROM workflow_versions WHERE workflow_id=${id}`); await db.execute(sql`DELETE FROM workflows WHERE id=${id}`); }
    if (groupId) {
      const events = await db.select({ id: agentRoomEvents.id }).from(agentRoomEvents).where(eq(agentRoomEvents.roomId, groupId));
      if (events.length) await db.delete(agentRoomDeliveries).where(inArray(agentRoomDeliveries.eventId, events.map(e => e.id)));
      await db.delete(agentRoomEvents).where(eq(agentRoomEvents.roomId, groupId));
      await db.delete(agentChatAttachments).where(eq(agentChatAttachments.sessionId, groupId));
      await db.delete(agentBusSubscriptions).where(eq(agentBusSubscriptions.topic, `group:workflow-run-${runId}`));
      await db.delete(agentBusGroups).where(eq(agentBusGroups.id, groupId));
    }
    await db.delete(workflowRunMembers).where(eq(workflowRunMembers.runId, runId));
    await db.delete(workflowRuns).where(eq(workflowRuns.id, runId));
    const ids = peers.map(p => p.addressId), hostIds = peers.map(p => p.hostId);
    if (ids.length) {
      await db.delete(agentBusMessages).where(inArray(agentBusMessages.targetAddressId, ids));
      await db.execute(sql`DELETE FROM agent_bus_conversations WHERE address_b_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
      await db.delete(agentSessions).where(inArray(agentSessions.hostId, hostIds));
      await db.delete(agentBusAddresses).where(inArray(agentBusAddresses.id, ids));
      await db.delete(hosts).where(inArray(hosts.id, hostIds));
    }
    if (root) await rm(root, { recursive: true, force: true });
    await handle?.pool.end();
  });
  it('atomically enqueues cross-host invitations and rolls back queue on failed membership transaction', async () => {
    const input = { actor: peers[0]!.actor, target: peers[1]!.actor, invitation_id: randomUUID(), run_id: runId, goal: 'Produce evidence', reason: 'Need another host', task_ids: ['second'], report_url: 'https://workflow.example/admin/workflows/runs/'+runId, client_request_id: randomUUID() };
    const before = (await db.select().from(agentBusMessages)).length;
    await expect(txn(async tx => { await collaboration.invite(tx, input); throw new Error('rollback invitation'); })).rejects.toThrow('rollback invitation');
    expect((await db.select().from(agentBusMessages)).length).toBe(before);
    const result = await txn(tx => collaboration.invite(tx, input));
    const [message] = await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, result.message_id));
    expect(message).toMatchObject({ kind: 'message', deliveryClass: 'coordination', targetAddressId: peers[1]!.addressId, targetSessionId: peers[1]!.sessionId, clientMessageId: input.invitation_id });
    expect(decrypt(message!.contentEnc, testKeyring())).toContain(`WORKFLOW-INVITE/1 invitation_id=${input.invitation_id}`);
  });
  it('creates exactly one managed group for concurrent second/third accepts and synchronizes members', async () => {
    expect(await txn(tx => collaboration.syncGroup(tx, { run_id: runId, group_id: null, members: active().slice(0, 1), closed: false }))).toBeNull();
    const sync = () => txn(async tx => {
      const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for('update');
      const group = await collaboration.syncGroup(tx, { run_id: runId, group_id: run!.communicationGroupId, members: active(), closed: false });
      await tx.update(workflowRuns).set({ communicationGroupId: group!.group_id, communication: group }).where(eq(workflowRuns.id, runId));
      return group!;
    });
    const [a, b] = await Promise.all([sync(), sync()]);
    expect(a.group_id).toBe(b.group_id); groupId = a.group_id;
    expect(a.communication_url).toContain('/admin/agents?view=live&room=');
    expect(await db.select().from(agentBusGroups).where(eq(agentBusGroups.slug, `workflow-run-${runId}`))).toHaveLength(1);
    expect(await db.select().from(agentBusSubscriptions).where(eq(agentBusSubscriptions.topic, a.group_topic))).toHaveLength(3);
  });
  it('rejects generic subscribe/unsubscribe/delete/manage paths and outsider subscriptions do not grant chat', async () => {
    const topic = `group:workflow-run-${runId}`;
    await expect(bus.subscribe(peers[3]!.sessionId, peers[3]!.token, topic)).rejects.toMatchObject({ code: 'workflow_group_managed' });
    await expect(bus.unsubscribe(peers[0]!.sessionId, peers[0]!.token, topic)).rejects.toMatchObject({ code: 'workflow_group_managed' });
    await expect(bus.deleteAdminGroup(`workflow-run-${runId}`)).rejects.toMatchObject({ code: 'workflow_group_managed' });
    await expect(chat.manage(admin, { client_request_id: randomUUID(), room_id: groupId, action: 'invite', address_id: peers[3]!.addressId })).rejects.toMatchObject({ code: 'workflow_group_managed' });
    await db.insert(agentBusSubscriptions).values({ id: randomUUID(), topic, subscriberAddressId: peers[3]!.addressId, createdAt: new Date().toISOString() });
    await expect(chat.read(roomActor(3), { room_id: groupId })).rejects.toMatchObject({ code: 'workflow_member_required' });
    await expect(chat.access(roomActor(3), groupId, true)).rejects.toMatchObject({ code: 'workflow_member_required' });
    await db.delete(agentBusSubscriptions).where(and(eq(agentBusSubscriptions.topic, topic), eq(agentBusSubscriptions.subscriberAddressId, peers[3]!.addressId)));
  });
  it('delivers targeted participant questions and keeps replies passive without ping-pong', async () => {
    const question = await chat.send(roomActor(0), { client_request_id: randomUUID(), room_id: groupId, content: 'What did host B observe?', recipients: [peers[1]!.addressId] });
    const [delivery] = await db.select().from(agentRoomDeliveries).where(eq(agentRoomDeliveries.eventId, question.id));
    const [message] = await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, delivery!.messageId!));
    expect(message!.deliveryClass).toBe('coordination');
    const text = decrypt(message!.contentEnc, testKeyring());
    expect(text).toContain(`WORKFLOW-QUESTION/1 run_id=${runId}`); expect(text).not.toContain('The operator requests');
    await chat.send(roomActor(1), { client_request_id: randomUUID(), room_id: groupId, content: 'Verified on B', reply_to: question.id });
    expect(await db.select().from(agentRoomDeliveries).where(eq(agentRoomDeliveries.eventId, question.id))).toHaveLength(1);
    await expect(chat.send(roomActor(1), { client_request_id: randomUUID(), room_id: groupId, content: 'Answer and ask again', reply_to: question.id, recipients: [peers[0]!.addressId] })).rejects.toThrow('cannot start another');
    await expect(chat.send(roomActor(0), { client_request_id: randomUUID(), room_id: groupId, content: 'self', recipients: [peers[0]!.addressId] })).rejects.toThrow('other participants');
    await expect(chat.send(roomActor(0), { client_request_id: randomUUID(), room_id: groupId, content: 'all', ask_all: true })).rejects.toThrow('Only an operator');
  });
  it('refreshes attachment access after a completed run under MySQL repeatable-read', async () => {
    const owner = (await chat.access(roomActor(0), groupId, true)).owner;
    let ready!: () => void, proceed!: () => void;
    const observed = new Promise<void>(resolve => { ready = resolve; });
    const continueWrite = new Promise<void>(resolve => { proceed = resolve; });
    const staleWrite = db.transaction(async tx => {
      const [before] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      expect(before!.status).toBe('running'); ready();
      await continueWrite;
      await assertWorkflowAttachmentWrite(tx, groupId, owner);
    });
    await observed;
    await txn(tx => tx.update(workflowRuns).set({ status: 'completed' }).where(eq(workflowRuns.id, runId)));
    proceed();
    await expect(staleWrite).rejects.toMatchObject({ code: 'workflow_group_closed' });
    await txn(tx => tx.update(workflowRuns).set({ status: 'running' }).where(eq(workflowRuns.id, runId)));
  });
  it('rolls back membership and group changes when a participant subscription limit is reached', async () => {
    const peer = peers[3]!, reserved = Array.from({ length: 64 }, () => ({ id: randomUUID(), topic: `agent:${randomUUID()}`, subscriberAddressId: peer.addressId, createdAt: new Date().toISOString() }));
    await db.insert(agentBusSubscriptions).values(reserved);
    try {
      await expect(txn(async tx => {
        const now = new Date().toISOString();
        await tx.insert(workflowRunMembers).values({ id: randomUUID(), runId, agentAddressId: peer.addressId, sessionId: peer.sessionId, bindingGeneration: peer.actor.binding_generation!, status: 'active', actor: { ...peer.actor }, createdAt: now, updatedAt: now });
        await collaboration.syncGroup(tx, { run_id: runId, group_id: groupId, members: peers.map(p => p.actor), closed: false });
      })).rejects.toMatchObject({ code: 'agent_messaging_subscription_limit' });
      expect(await db.select().from(workflowRunMembers).where(and(eq(workflowRunMembers.runId, runId), eq(workflowRunMembers.agentAddressId, peer.addressId)))).toHaveLength(0);
      expect(await db.select().from(agentBusSubscriptions).where(eq(agentBusSubscriptions.topic, `group:workflow-run-${runId}`))).toHaveLength(3);
    } finally { await db.delete(agentBusSubscriptions).where(inArray(agentBusSubscriptions.id, reserved.map(r => r.id))); }
  });
  it('fences stale run chat bindings even when the native session ID stays the same', async () => {
    await db.update(agentBusAddresses).set({ bindingGeneration: peers[0]!.actor.binding_generation! + 1 }).where(eq(agentBusAddresses.id, peers[0]!.addressId));
    try {
      await expect(chat.send(roomActor(0), { client_request_id: randomUUID(), room_id: groupId, content: 'stale' })).rejects.toMatchObject({ code: 'workflow_member_required' });
      await expect(chat.send(roomActor(1), { client_request_id: randomUUID(), room_id: groupId, content: 'stale recipient', recipients: [peers[0]!.addressId] })).rejects.toThrow('active participants');
    } finally { await db.update(agentBusAddresses).set({ bindingGeneration: peers[0]!.actor.binding_generation! }).where(eq(agentBusAddresses.id, peers[0]!.addressId)); }
  });
  it('cancels across three recipients with stable distinct IDs and tolerates an unavailable member', async () => {
    await db.update(agentSessions).set({ endedAt: new Date().toISOString() }).where(eq(agentSessions.id, peers[3]!.sessionId));
    const input = { actor: { kind: 'admin' as const, id: '42' }, run_id: runId, members: peers.map(p => p.actor), reason: 'Stop new work', client_request_id: randomUUID() };
    const receipts = await txn(tx => collaboration.notifyCancel!(tx, input));
    expect(receipts).toMatchObject({ deliveries: expect.any(Array), skipped: expect.any(Array) });
    const messages = await db.select().from(agentBusMessages).where(inArray(agentBusMessages.targetAddressId, peers.slice(0, 3).map(p => p.addressId)));
    const canceled = messages.filter(m => decrypt(m.contentEnc, testKeyring()).startsWith('WORKFLOW-CANCEL/1'));
    expect(canceled).toHaveLength(3); expect(new Set(canceled.map(m => m.clientMessageId)).size).toBe(3);
    expect(decrypt(canceled[0]!.contentEnc, testKeyring())).toContain('sender=admin:42');
  });
  it('uses authenticated bridge actors for A→B→C invites, replays lost ACKs and serves the read-only catalog', async () => {
    const app = Fastify();
    app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ApiError ? error.status : error instanceof ZodError ? 422 : 500).send({ code: error instanceof ApiError ? error.code : 'validation_failed', message: error instanceof Error ? error.message : 'Request failed' }));
    const workflows = createWorkflowsService({ db, env: { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://workflow.example' }, keyring: testKeyring() } as RouteContext, bus);
    registerWorkflowBridgeRoutes(app, workflows, bus);
    const call = (i: number, suffix: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/host/agent-sessions/${peers[i]!.sessionId}/agent-messaging/workflows/${suffix}`, headers: { 'x-agent-bridge-token': peers[i]!.token }, payload: body });
    try {
      await new SettingsService(db).setFlag('workflows_enabled', true);
      const document = { schema_version: 1, title: 'Transport workflow', summary: 'Cross-engine collaboration', goal: { statement: 'Inspect evidence', success_criteria: [{ id: 'verified', text: 'Evidence verified' }] }, inputs: [], knowledge: [], tasks: [{ id: 'inspect', title: 'Inspect', instructions: 'Inspect the evidence', acceptance_criteria: ['Evidence verified'], depends_on: [], knowledge_ids: [] }] };
      const create = { client_request_id: randomUUID(), slug: `transport-${randomUUID().slice(0, 8)}`, document, reason: 'Transport acceptance' };
      const first = await call(0, 'create', create); expect(first.statusCode, first.body).toBe(200);
      const workflowId = String(first.json().workflow_id); workflowIds.push(workflowId);
      expect((await call(0, 'create', create)).json()).toEqual(first.json());
      expect((await call(0, 'create', { ...create, agent_uuid: peers[1]!.addressId })).statusCode).toBe(422);
      const started = await call(0, 'run-create', { client_request_id: randomUUID(), workflow_id: workflowId, title: 'Shared run', inputs: {} });
      expect(started.statusCode, started.body).toBe(200);
      const id = String(started.json().run_id); bridgeRuns.push(id);
      const invite = { client_request_id: randomUUID(), run_id: id, target_address_id: peers[1]!.addressId, reason: 'Inspect from host B', task_ids: ['inspect'] };
      const invited = await call(0, 'invite', invite); expect(invited.statusCode, invited.body).toBe(200);
      expect((await call(0, 'invite', invite)).json()).toEqual(invited.json());
      const accept = { client_request_id: randomUUID(), run_id: id, invitation_id: invited.json().invitation_id, action: 'accept', reason: 'Access verified' };
      expect((await call(2, 'membership', accept)).statusCode).toBe(403);
      const accepted = await call(1, 'membership', accept); expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await call(1, 'membership', accept)).json()).toEqual(accepted.json());
      const c = await call(1, 'invite', { ...invite, client_request_id: randomUUID(), target_address_id: peers[2]!.addressId, reason: 'Need Grok inspection' });
      expect(c.statusCode, c.body).toBe(200);
      const acceptedC = await call(2, 'membership', { ...accept, client_request_id: randomUUID(), invitation_id: c.json().invitation_id });
      expect(acceptedC.statusCode, acceptedC.body).toBe(200);
      const snapshot = await workflows.runGet(id);
      expect('members' in snapshot ? snapshot.members : []).toHaveLength(3);
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
      expect(run!.communicationGroupId).toBeTruthy();
      expect(await db.select().from(agentBusGroups).where(eq(agentBusGroups.slug, `workflow-run-${id}`))).toHaveLength(1);
      const registry = new McpToolsRegistry({ workflows } as never);
      expect(registry.list().filter(t => t.name.startsWith('workflow_'))).toHaveLength(4);
      expect(await workflows.list({ search: 'Transport workflow' })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ workflow_id: workflowId })]) });
      const resources = new McpResourcesService({ workflows } as never);
      const content = await resources.read(`workflow://${create.slug}@1`, {} as never);
      expect(JSON.parse(content.contents[0]!.text!).document).toEqual(document);
      const current = await call(1, 'run-current', {}); expect(current.statusCode, current.body).toBe(200); expect(current.body).toContain(id);
      await db.update(hosts).set({ wrapperVersion: '0.9.110' }).where(eq(hosts.id, peers[0]!.hostId));
      expect((await call(0, 'run-note', { client_request_id: randomUUID(), run_id: id, kind: 'note', text: 'outdated' })).json().code).toBe('workflow_wrapper_outdated');
      await db.update(hosts).set({ wrapperVersion: '0.9.111' }).where(eq(hosts.id, peers[0]!.hostId));
      await db.update(agentBusAddresses).set({ bindingGeneration: peers[0]!.actor.binding_generation! + 1 }).where(eq(agentBusAddresses.id, peers[0]!.addressId));
      expect((await call(0, 'run-note', { client_request_id: randomUUID(), run_id: id, kind: 'note', text: 'stale binding' })).statusCode).toBeGreaterThanOrEqual(400);
      await db.update(agentBusAddresses).set({ bindingGeneration: peers[0]!.actor.binding_generation! }).where(eq(agentBusAddresses.id, peers[0]!.addressId));
    } finally { await app.close(); }
  });
  it('retains historical access after leave and closure, while fencing chat/publication/uploads', async () => {
    const owner = (await chat.access(roomActor(1), groupId, true)).owner;
    const attachmentId = randomUUID();
    await chat.attachments.create(groupId, owner, { id: attachmentId, name: 'evidence.txt', mime_type: 'text/plain', size_bytes: 4 });
    await chat.attachments.put(groupId, owner, attachmentId, 0, Buffer.from('test').toString('base64'));
    await chat.attachments.seal(groupId, owner, attachmentId);
    await chat.send(roomActor(1), { client_request_id: randomUUID(), room_id: groupId, attachments: [attachmentId] });
    await txn(async tx => {
      await tx.update(workflowRunMembers).set({ status: 'left' }).where(and(eq(workflowRunMembers.runId, runId), eq(workflowRunMembers.agentAddressId, peers[1]!.addressId)));
      await collaboration.syncGroup(tx, { run_id: runId, group_id: groupId, members: [peers[0]!.actor, peers[2]!.actor], closed: false });
    });
    expect((await chat.read(roomActor(1), { room_id: groupId })).room.workflow_run_id).toBe(runId);
    await expect(chat.send(roomActor(1), { client_request_id: randomUUID(), room_id: groupId, content: 'late' })).rejects.toMatchObject({ code: 'workflow_member_required' });
    await expect(chat.attachments.create(groupId, owner, { id: randomUUID(), name: 'late', mime_type: 'text/plain', size_bytes: 4 })).rejects.toMatchObject({ code: 'workflow_member_required' });
    await txn(async tx => { await tx.update(workflowRuns).set({ status: 'completed' }).where(eq(workflowRuns.id, runId)); await collaboration.syncGroup(tx, { run_id: runId, group_id: groupId, members: active(), closed: true }); });
    expect((await chat.read(roomActor(1), { room_id: groupId })).room.status).toBe('closed');
    expect((await chat.list(roomActor(1), 0, 'history')).rooms.some(r => r.id === groupId)).toBe(true);
    expect((await chat.list(roomActor(1), 0, 'active')).rooms.some(r => r.id === groupId)).toBe(false);
    expect(await chat.attachments.download(groupId, attachmentId)).toMatchObject({ status: 'linked' });
    await expect(chat.access(roomActor(0), groupId, true)).rejects.toMatchObject({ code: 'workflow_group_closed' });
    expect(await db.select().from(agentBusSubscriptions).where(eq(agentBusSubscriptions.topic, `group:workflow-run-${runId}`))).toHaveLength(0);
  });
});
