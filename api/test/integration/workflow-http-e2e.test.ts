import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUsers, hosts, workflowRuns } from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrator.js';
import { AdminAuthService } from '../../src/services/admin-auth.js';
import { AgentMessagingService } from '../../src/services/agent-messaging.js';
import { registerAgentMessagingRoutes } from '../../src/routes/agent-messaging/index.js';
import { registerAdminWorkflowRoutes } from '../../src/routes/admin/workflows.js';
import { registerAgentRoomChatRoutes } from '../../src/routes/agent-room-chat.js';
import { buildAppWithDb } from '../helpers/build-app.js';
import { getTestDb } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { markPersistentHost } from '../helpers/persistent-host.js';

const handle = await getTestDb();
interface Client {
  session: string;
  token: string;
  address: string;
  host: string;
}
interface Task {
  task_id: string;
  version: number;
  status: string;
  attempt_no: number;
}
interface Run {
  run_id: string;
  workflow_id: string;
  workflow_version: number;
  version: number;
  status: string;
  outcome: string | null;
  report_url: string;
  coordinator: { generation: number };
  tasks: Task[];
  communication: { room_id: string } | null;
  evaluation: { version: number; applied_version: number | null } | null;
}
interface Claim extends Run {
  task: Task;
  claim_token: string;
  claim_generation: number;
}
type Json = Record<string, unknown>;

// Actual HTTP sockets, bridge authentication and MySQL transactions. Setup
// creates test identities only; none of the workflow or chat API is mocked.
describe.skipIf(!handle)('workflow across three host/engine bridges over HTTP', { timeout: 120_000 }, () => {
  const db = handle?.db as NonNullable<typeof handle>['db'];
  let app: FastifyInstance, base: string, root: string, cookie: string;
  let adminId: number;
  const hostIds: number[] = [],
    clients: Client[] = [],
    runIds: string[] = [],
    workflowIds: string[] = [];
  const prefix = `ztest-workflow-http-${randomUUID().slice(0, 8)}`;
  const keyring = testKeyring();
  const env = { ...loadTestEnv(), PUBLIC_BASE_URL: 'http://workflow.test', DATA_ROOT: '' };

  async function start() {
    app = await buildAppWithDb(db, { env });
    const ctx = { db, env, keyring };
    await registerAgentMessagingRoutes(app, ctx);
    await registerAdminWorkflowRoutes(app, ctx);
    registerAgentRoomChatRoutes(app, ctx);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }
  async function request<T>(path: string, body?: Json, client?: Client, expected = 200): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        ...(client ? { 'x-agent-bridge-token': client.token } : { cookie }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = (await response.json()) as Json;
    expect(response.status, JSON.stringify(value)).toBe(expected);
    return (value.data ?? value) as T;
  }
  const call = <T>(client: Client, operation: string, body: Json, expected = 200) =>
    request<T>(
      `/host/agent-sessions/${client.session}/agent-messaging/workflows/${operation}`,
      {
        client_request_id: randomUUID(),
        ...body,
      },
      client,
      expected,
    );
  const chat = <T>(client: Client, operation: string, body: Json, expected = 200) =>
    request<T>(
      `/host/agent-sessions/${client.session}/agent-messaging/chats/${operation}`,
      body,
      client,
      expected,
    );
  const report = (id: string) => request<Run>(`/admin/workflow-runs/${id}/report`);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'workflow-http-'));
    env.DATA_ROOT = root;
    await runMigrations(handle!.pool);
    const now = new Date().toISOString();
    await db.insert(adminUsers).values({
      username: prefix,
      name: 'Workflow acceptance',
      email: `${prefix}@example.test`,
      passwordHash: 'unused-test-session',
      accessLevel: 'owner',
      active: 1,
      createdAt: now,
      updatedAt: now,
    });
    const [admin] = await db.select().from(adminUsers).where(eq(adminUsers.username, prefix));
    adminId = admin!.id;
    const auth = new AdminAuthService(db, env);
    const session = await auth.createSession(admin!, '127.0.0.1', 'workflow-e2e', 'test.workflow.session');
    cookie = `${auth.sessionCookieName()}=${session.token}`;
    const bus = new AgentMessagingService(db, env, keyring);
    await bus.setEnabled(true);
    for (const [index, engine] of (['codex', 'claude', 'grok', 'codex'] as const).entries()) {
      const host = `${prefix}-${index}.example`;
      await db.insert(hosts).values({
        fqdn: host,
        apiKey: randomBytes(32).toString('hex'),
        status: 'active',
        secure: 1,
        engines: engine,
        wrapperVersion: '0.9.111',
        claudeWrapperVersion: '0.9.111',
        grokWrapperVersion: '0.9.111',
        agentMessagingEnabled: 1,
        createdAt: now,
        updatedAt: now,
      });
      const [row] = await db.select().from(hosts).where(eq(hosts.fqdn, host));
      hostIds.push(row!.id);
      await markPersistentHost(db, row!.id);
      const session = randomUUID(),
        token = randomBytes(32).toString('base64url');
      const registration = await bus.registerSession(row!, {
        engine,
        username: 'root',
        cwd: root,
        invocationKind: 'interactive',
        sessionId: session,
        bridgeToken: token,
        adapterProtocol: 'workflow-http-test-v1',
        adapterCapabilities: {
          execution_contract_version: 2,
          shared_room_chat_version: 1,
          workflow_protocol_version: 1,
        },
      });
      clients.push({ session, token, address: (registration.address as { id: string }).id, host });
    }
    await start();
    await request('/admin/workflow-definitions/state', { enabled: true, client_request_id: randomUUID() });
  });

  afterAll(async () => {
    await app?.close();
    // The database is a disposable fixture. Delete only this suite's identities
    // and runs, preserving other suites sharing the same MySQL instance.
    for (const id of runIds) {
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
      if (run?.communicationGroupId) {
        const group = run.communicationGroupId;
        await db.execute(
          sql`DELETE FROM agent_room_deliveries WHERE event_id IN (SELECT id FROM agent_room_events WHERE room_id=${group})`,
        );
        await db.execute(sql`DELETE FROM agent_room_events WHERE room_id=${group}`);
        await db.execute(sql`DELETE FROM agent_room_reads WHERE room_id=${group}`);
        await db.execute(sql`DELETE FROM agent_bus_subscriptions WHERE topic=${`group:workflow-run-${id}`}`);
        await db.execute(sql`DELETE FROM agent_bus_groups WHERE id=${group}`);
      }
      for (const table of [
        'workflow_run_events',
        'workflow_run_evaluations',
        'workflow_task_attempts',
        'workflow_run_tasks',
        'workflow_run_invitations',
        'workflow_run_members',
      ]) {
        await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE run_id=${id}`);
      }
      await db.delete(workflowRuns).where(eq(workflowRuns.id, id));
    }
    for (const id of workflowIds) {
      await db.execute(sql`DELETE FROM workflow_versions WHERE workflow_id=${id}`);
      await db.execute(sql`DELETE FROM workflows WHERE id=${id}`);
    }
    for (const client of clients) {
      await db.execute(
        sql`DELETE FROM workflow_mutations WHERE actor_key LIKE ${`agent:${client.address}:%`}`,
      );
      await db.execute(
        sql`DELETE FROM agent_bus_messages WHERE target_address_id=${client.address} OR sender_address_id=${client.address}`,
      );
      await db.execute(
        sql`DELETE FROM agent_bus_conversations WHERE address_a_id=${client.address} OR address_b_id=${client.address}`,
      );
      await db.execute(sql`DELETE FROM agent_sessions WHERE id=${client.session}`);
      await db.execute(sql`DELETE FROM agent_bus_addresses WHERE id=${client.address}`);
    }
    if (hostIds.length) await db.delete(hosts).where(inArray(hosts.id, hostIds));
    if (adminId) {
      await db.execute(sql`DELETE FROM workflow_mutations WHERE actor_key=${`admin:${adminId}`}`);
      await db.delete(adminUsers).where(eq(adminUsers.id, adminId));
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('keeps one shared report/group, fences contention, survives restart and publishes one evaluated improvement', async () => {
    const [a, b, c, outsider] = clients as [Client, Client, Client, Client];
    const document = {
      schema_version: 1,
      title: 'Produce and verify two artifacts',
      summary: 'Harmless multi-host acceptance',
      goal: {
        statement: 'Two artifacts have verified hashes',
        success_criteria: [{ id: 'verified', text: 'Both hashes are verified' }],
      },
      inputs: [],
      knowledge: [],
      tasks: ['alpha', 'beta', 'verify'].map((id) => ({
        id,
        title: id,
        instructions: id === 'verify' ? 'Verify both artifact hashes' : `Write the ${id} artifact`,
        acceptance_criteria: ['Provide a verifiable SHA-256'],
        depends_on: id === 'verify' ? ['alpha', 'beta'] : [],
        knowledge_ids: [],
      })),
    };
    const definition = await call<{ workflow_id: string }>(a, 'create', {
      slug: prefix,
      document,
      reason: 'Acceptance fixture',
    });
    workflowIds.push(definition.workflow_id);
    let run = await call<Run>(a, 'run-create', {
      workflow_id: definition.workflow_id,
      title: 'HTTP acceptance',
      inputs: {},
    });
    runIds.push(run.run_id);
    const url = run.report_url;
    expect(url).toContain(`/admin/workflows/runs/${run.run_id}`);
    expect((await report(run.run_id)).status).toBe('running');
    const invite = await call<{ invitation_id: string }>(a, 'invite', {
      run_id: run.run_id,
      target_address_id: b.address,
      reason: 'Write beta',
    });
    await call(b, 'membership', {
      run_id: run.run_id,
      invitation_id: invite.invitation_id,
      action: 'accept',
      reason: 'Available',
    });
    const third = await call<{ invitation_id: string }>(b, 'invite', {
      run_id: run.run_id,
      target_address_id: c.address,
      reason: 'Verify outputs',
    });
    await call(c, 'membership', {
      run_id: run.run_id,
      invitation_id: third.invitation_id,
      action: 'accept',
      reason: 'Available',
    });
    run = await report(run.run_id);
    expect(run.communication?.room_id).toBeTruthy();
    const room = run.communication!.room_id;
    await call(
      outsider,
      'task-claim',
      { run_id: run.run_id, task_id: 'alpha', action: 'acquire', expected_task_version: 1 },
      403,
    );
    const attempts = await Promise.all([
      call<Claim>(a, 'task-claim', {
        run_id: run.run_id,
        task_id: 'alpha',
        action: 'acquire',
        expected_task_version: 1,
      }),
      call<Claim>(b, 'task-claim', {
        run_id: run.run_id,
        task_id: 'beta',
        action: 'acquire',
        expected_task_version: 1,
      }),
    ]);
    await call(
      c,
      'task-claim',
      { run_id: run.run_id, task_id: 'alpha', action: 'acquire', expected_task_version: 1 },
      409,
    );
    const evidenceIds: string[] = [];
    for (const [index, client] of [a, b].entries()) {
      const taskId = index === 0 ? 'alpha' : 'beta',
        claim = attempts[index]!;
      const path = join(root, `${taskId}.txt`);
      await writeFile(path, `${client.host}:${taskId}\n`);
      const hash = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      evidenceIds.push(`${taskId}_hash`);
      const body = {
        client_request_id: randomUUID(),
        run_id: run.run_id,
        task_id: taskId,
        action: 'result',
        expected_task_version: claim.task.version,
        claim_token: claim.claim_token,
        claim_generation: claim.claim_generation,
        status: 'succeeded',
        summary: 'Artifact written and hashed',
        outputs: { hash },
        execution_host: client.host,
        evidence: [
          {
            id: `${taskId}_hash`,
            description: 'SHA-256 read from artifact',
            type: 'sha256',
            time: new Date().toISOString(),
            hash,
            execution_host: client.host,
          },
        ],
      };
      const saved = await call(client, 'task-update', body);
      expect(await call(client, 'task-update', body)).toEqual(saved); // Lost ACK replay, not new execution.
    }
    await app.close();
    await start(); // New API/service instances against the same durable database.
    run = await report(run.run_id);
    expect(run.report_url).toBe(url);
    expect(run.communication!.room_id).toBe(room);
    expect(run.tasks.filter((t) => t.status === 'succeeded')).toHaveLength(2);
    const claim = await call<Claim>(c, 'task-claim', {
      run_id: run.run_id,
      task_id: 'verify',
      action: 'acquire',
      expected_task_version: 1,
    });
    await call(c, 'task-update', {
      run_id: run.run_id,
      task_id: 'verify',
      action: 'result',
      expected_task_version: claim.task.version,
      claim_token: claim.claim_token,
      claim_generation: claim.claim_generation,
      status: 'succeeded',
      summary: 'Both artifact hashes verified',
      execution_host: c.host,
      evidence: [
        {
          id: 'verified_hashes',
          description: 'Verified both outputs',
          type: 'verification',
          time: new Date().toISOString(),
          execution_host: c.host,
        },
      ],
    });
    run = await report(run.run_id);
    await call(a, 'run-finish', {
      run_id: run.run_id,
      expected_run_version: run.version,
      coordinator_generation: run.coordinator.generation,
      outcome: 'succeeded',
      summary: 'Two artifacts produced and verified',
      criteria: [
        {
          id: 'verified',
          status: 'met',
          reason: 'Hashes checked',
          evidence_ids: [...evidenceIds, 'verified_hashes'],
        },
      ],
    });
    run = await report(run.run_id);
    expect(run.status).toBe('evaluating');
    const improved = structuredClone(document);
    improved.tasks[0]!.instructions += '; include the execution host with the hash';
    const finishBody = {
      client_request_id: randomUUID(),
      run_id: run.run_id,
      expected_run_version: run.version,
      coordinator_generation: run.coordinator.generation,
      expected_evaluation_version: run.evaluation!.version,
      action: 'finalize',
      evaluation: {
        findings: [],
        lessons: ['Make host attribution explicit'],
        decision: 'revise',
        reason: 'Clarify evidence attribution',
        expected_workflow_version: 1,
        document: improved,
      },
    };
    const completed = await call(a, 'run-evaluate', finishBody);
    expect(await call(a, 'run-evaluate', finishBody)).toEqual(completed);
    run = await report(run.run_id);
    expect(run.status).toBe('completed');
    expect(run.workflow_version).toBe(1);
    expect(run.evaluation!.applied_version).toBe(2);
    expect(run.report_url).toBe(url);
    await chat(a, 'read', { room_id: room });
    await chat(
      a,
      'send',
      { room_id: room, client_request_id: randomUUID(), content: 'Cannot write after completion' },
      409,
    );
    const second = await call<Run>(b, 'run-create', {
      workflow_id: definition.workflow_id,
      title: 'Uses improved version',
      inputs: {},
    });
    runIds.push(second.run_id);
    expect(second.workflow_version).toBe(2);
  });
});
