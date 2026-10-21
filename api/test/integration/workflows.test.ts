import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { getTestDb } from '../helpers/test-db.js';
import { AgentMessagingService } from '../../src/services/agent-messaging.js';
import { createWorkflowCollaboration } from '../../src/services/agent-messaging/workflows.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { WorkflowsService } from '../../src/services/workflows.js';
import { SettingsService } from '../../src/services/settings.js';
import {
  agentBusAddresses,
  agentSessions,
  hosts,
  workflowMutations,
  workflowRunEvaluations,
  workflowRunEvents,
  workflowRunInvitations,
  workflowRunMembers,
  workflowRunTasks,
  workflowRuns,
  workflowTaskAttempts,
  workflowVersions,
  workflows,
} from '../../src/db/schema.js';
import type {
  WorkflowActor,
  WorkflowDocument,
  WorkflowOperation,
  WorkflowCollaboration,
} from '../../src/services/workflows/contract.js';
const handle = await getTestDb();
const document = (): WorkflowDocument => ({
  schema_version: 1,
  title: 'Produce two artifacts',
  summary: 'Parallel durable artifacts',
  goal: {
    statement: 'Produce verified artifacts',
    success_criteria: [
      { id: 'a', text: 'A verified' },
      { id: 'b', text: 'B verified' },
    ],
  },
  inputs: [{ key: 'enabled', label: 'Enabled', type: 'boolean', required: true, default: true }],
  tasks: [
    {
      id: 'a',
      title: 'A',
      instructions: 'Create A',
      acceptance_criteria: ['Has hash'],
      depends_on: [],
      knowledge_ids: [],
    },
    {
      id: 'b',
      title: 'B',
      instructions: 'Create B',
      acceptance_criteria: ['Has hash'],
      depends_on: [],
      knowledge_ids: [],
    },
    {
      id: 'verify',
      title: 'Verify',
      instructions: 'Read A and B',
      acceptance_criteria: ['Both valid'],
      depends_on: ['a', 'b'],
      knowledge_ids: [],
    },
  ],
  knowledge: [],
});
type Result = Record<string, any>;
describe.skipIf(!handle)('durable workflows on real MySQL', { timeout: 30000 }, () => {
  const db = handle?.db as Database;
  const keyring = testKeyring();
  let service: WorkflowsService;
  let hostId: number;
  let a: WorkflowActor, b: WorkflowActor;
  const admin: WorkflowActor = { kind: 'admin', id: `workflow-test-${randomUUID()}` };
  const workflowIds: string[] = [],
    runIds: string[] = [],
    actorIds: string[] = [];
  let originalEnabled: string | null;
  const settings = new SettingsService(db);
  const call = (op: WorkflowOperation, body: Record<string, unknown>, actor = a): Promise<Result> =>
    service.mutate(op, { client_request_id: randomUUID(), ...body }, actor);
  async function actor(engine: string) {
    const now = new Date().toISOString(),
      address = randomUUID(),
      session = randomUUID();
    actorIds.push(address);
    await db.insert(agentSessions).values({
      id: session,
      hostId,
      engine,
      username: 'workflow-test',
      cwd: '/tmp/workflows',
      agentBusAddressId: address,
      bindingGeneration: 1,
      invocationKind: 'interactive',
      status: 'running',
      adapterCapabilities: { workflow_protocol_version: 2 },
      hostAuthFingerprint: 'a'.repeat(64),
      bridgeTokenHash: 'b'.repeat(64),
      bridgeExpiresAt: '2099-01-01T00:00:00.000Z',
      startedAt: now,
      heartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agentBusAddresses).values({
      id: address,
      address: `agent:${address}`,
      hostId,
      engine,
      username: 'workflow-test',
      cwd: '/tmp/workflows',
      cwdHash: 'c'.repeat(64),
      currentSessionId: session,
      bindingGeneration: 1,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return {
      kind: 'agent' as const,
      protocol_version: 2,
      id: address,
      address_id: address,
      session_id: session,
      binding_generation: 1,
      host_id: hostId,
      engine,
    };
  }
  async function setup(doc = document(), start = true) {
    const w = await call(
      'create',
      { slug: `test-${randomUUID()}`, document: doc, reason: 'Test fixture' },
      admin,
    );
    workflowIds.push(w.workflow_id);
    let run = await call('run_create', {
      workflow_id: w.workflow_id,
      version: 'latest',
      title: 'Test run',
      inputs: {},
    });
    runIds.push(run.run_id);
    if (start) run = await begin(run);
    return { w, run };
  }
  async function begin(run: Result) {
    let r = await call('run_control', { run_id: run.run_id, expected_run_version: run.version,
      coordinator_generation: run.coordinator.generation, action: 'present_summary' });
    r = await call('run_control', { run_id: run.run_id, expected_run_version: r.version,
      coordinator_generation: r.coordinator.generation, action: 'confirm_summary',
      summary_revision: r.preparation.summary.revision, user_confirmation: 'Yes, execute this summary' });
    return call('run_control', { run_id: run.run_id, expected_run_version: r.version,
      coordinator_generation: r.coordinator.generation, action: 'start' });
  }
  async function join(runId: string, who = b) {
    const now = new Date().toISOString();
    await db.insert(workflowRunMembers).values({
      id: randomUUID(),
      runId,
      agentAddressId: who.address_id!,
      sessionId: who.session_id!,
      bindingGeneration: who.binding_generation!,
      status: 'active',
      actor: { ...who },
      createdAt: now,
      updatedAt: now,
    });
  }
  async function claim(runId: string, taskId: string, who = a, version = 1) {
    return call(
      'task_claim',
      { run_id: runId, task_id: taskId, expected_task_version: version, action: 'acquire' },
      who,
    );
  }
  const evidence = (id: string) => ({
    id,
    description: 'Verified file hash',
    type: 'sha256',
    time: new Date().toISOString(),
    hash: 'a'.repeat(64),
    execution_host: 'test-host',
  });
  async function result(runId: string, taskId: string, c: Result, who = a, status = 'succeeded') {
    return call(
      'task_update',
      {
        run_id: runId,
        task_id: taskId,
        expected_task_version: c.task.version,
        action: 'result',
        claim_token: c.claim_token,
        claim_generation: c.claim_generation,
        status,
        summary: 'Artifact checked',
        outputs: { artifact: taskId },
        evidence: [evidence(taskId)],
        execution_host: 'test-host',
      },
      who,
    );
  }
  async function successRun(existingWorkflowId?: string) {
    const x = existingWorkflowId
      ? {
          w: { workflow_id: existingWorkflowId },
          run: await call('run_create', {
            workflow_id: existingWorkflowId,
            title: 'Another run',
            inputs: {},
          }),
        }
      : await setup();
    if (existingWorkflowId) { runIds.push(x.run.run_id); x.run = await begin(x.run); }
    for (const id of ['a', 'b', 'verify']) await result(x.run.run_id, id, await claim(x.run.run_id, id));
    const finish = await call('run_finish', {
      run_id: x.run.run_id,
      expected_run_version: x.run.version,
      coordinator_generation: 1,
      outcome: 'succeeded',
      summary: 'All verified',
      criteria: [
        { id: 'a', status: 'met', reason: 'Verified', evidence_ids: ['a'] },
        { id: 'b', status: 'met', reason: 'Verified', evidence_ids: ['b'] },
      ],
    });
    return { ...x, finish };
  }
  beforeAll(async () => {
    originalEnabled = await settings.getRaw('workflows_enabled');
    await settings.set('workflows_enabled', '1');
    const now = new Date().toISOString(),
      fqdn = `workflow-test-${randomUUID()}.example`;
    await db.insert(hosts).values({
      fqdn,
      apiKey: randomUUID(),
      status: 'active',
      secure: 1,
      engines: 'codex,claude,grok',
      createdAt: now,
      updatedAt: now,
    });
    hostId = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!.id;
    a = await actor('codex');
    b = await actor('claude');
    service = new WorkflowsService({ db, settings, keyring, publicBaseUrl: 'https://test.example' });
  });
  afterAll(async () => {
    if (runIds.length) {
      await db.delete(workflowRunEvaluations).where(inArray(workflowRunEvaluations.runId, runIds));
      await db.delete(workflowRunEvents).where(inArray(workflowRunEvents.runId, runIds));
      await db.delete(workflowRunInvitations).where(inArray(workflowRunInvitations.runId, runIds));
      await db.delete(workflowRunMembers).where(inArray(workflowRunMembers.runId, runIds));
      await db.delete(workflowRunTasks).where(inArray(workflowRunTasks.runId, runIds));
      await db.delete(workflowTaskAttempts).where(inArray(workflowTaskAttempts.runId, runIds));
      await db.delete(workflowRuns).where(inArray(workflowRuns.id, runIds));
    }
    if (workflowIds.length) {
      await db.delete(workflowVersions).where(inArray(workflowVersions.workflowId, workflowIds));
      await db.delete(workflows).where(inArray(workflows.id, workflowIds));
    }
    for (const actor of [a, b])
      if (actor) {
        await db
          .delete(workflowMutations)
          .where(
            eq(
              workflowMutations.actorKey,
              `agent:${actor.address_id}:${actor.session_id}:${actor.binding_generation}`,
            ),
          );
      }
    await db.delete(workflowMutations).where(eq(workflowMutations.actorKey, `admin:${admin.id}`));
    if (actorIds.length) await db.delete(agentBusAddresses).where(inArray(agentBusAddresses.id, actorIds));
    if (hostId) {
      await db.delete(agentSessions).where(eq(agentSessions.hostId, hostId));
      await db.delete(hosts).where(eq(hosts.id, hostId));
    }
    await settings.set('workflows_enabled', originalEnabled ?? '0');
    await handle!.pool.end();
  });
  it('reports messaging unavailability while keeping admin preparation and cancellation usable', async () => {
    const prior = await settings.getRaw('agent_messaging_enabled');
    await settings.set('agent_messaging_enabled', '0');
    const adminService = new WorkflowsService({
      db,
      settings,
      keyring,
      collaboration: createWorkflowCollaboration(new AgentMessagingService(db, loadTestEnv(), keyring)),
    });
    try {
      expect(await adminService.state()).toMatchObject({
        enabled: true,
        messaging_enabled: false,
        unavailable_reason: expect.stringContaining('Agent Messaging is disabled'),
      });
      const w = (await adminService.mutate(
        'create',
        {
          client_request_id: randomUUID(),
          slug: `test-${randomUUID()}`,
          document: document(),
          reason: 'Prepare while messaging disabled',
        },
        admin,
      )) as Result;
      workflowIds.push(w.workflow_id);
      const r = (await adminService.mutate(
        'run_create',
        {
          client_request_id: randomUUID(),
          workflow_id: w.workflow_id,
          title: 'Prepared with messaging off',
          inputs: {},
        },
        admin,
      )) as Result;
      runIds.push(r.run_id);
      const canceled = await adminService.mutate(
        'prepare_cancel',
        {
          client_request_id: randomUUID(),
          run_id: r.run_id,
          expected_run_version: r.version,
          reason: 'Cancel preparation',
        },
        admin,
      );
      expect(canceled).toMatchObject({ status: 'evaluating', outcome: 'canceled' });
      await settings.set('agent_messaging_enabled', '1');
      expect((await adminService.state()).unavailable_reason).toBeNull();
    } finally {
      await settings.set('agent_messaging_enabled', prior ?? '0');
    }
  });
  it('pins immutable versions, typed defaults and two independent runs', async () => {
    const { w, run } = await setup();
    const second = await call(
      'run_create',
      { workflow_id: w.workflow_id, title: 'Second', inputs: {} },
      admin,
    );
    runIds.push(second.run_id);
    expect(second.status).toBe('pending');
    expect(second.coordinator).toBeNull();
    expect(run.inputs).toEqual({ enabled: true });
    const revised = document();
    revised.tasks[0]!.instructions = 'Improved';
    await call(
      'revise',
      { workflow_id: w.workflow_id, expected_workflow_version: 1, document: revised, reason: 'Clearer' },
      admin,
    );
    expect(((await service.report(run.run_id)) as Result).document.tasks[0].instructions).toBe('Create A');
    expect((await service.get(w.workflow_id)).version).toBe(2);
    await expect(
      call('run_create', { workflow_id: w.workflow_id, title: 'Bad', inputs: { enabled: 'yes' } }, admin),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('gates new claims on the latest applicable receipt from the claiming binding only', async () => {
    const doc = document();
    doc.knowledge = [{ id: 'source', title: 'Linux runbook', reference: { uri: 'shared://workflow-test-runbook' }, required_check: { applicability: 'Linux targets only' } }];
    doc.tasks[0]!.knowledge_ids = ['source'];
    doc.tasks[1]!.knowledge_ids = ['source'];
    const { run } = await setup(doc);
    await join(run.run_id);
    const note = (who = a, patch: Record<string, unknown> = {}, taskId?: string) => call('run_note', {
      run_id: run.run_id, kind: 'knowledge', text: 'Source preflight attestation', ...(taskId ? { task_id: taskId } : {}),
      source: { knowledge_id: 'source', uri: 'shared://workflow-test-runbook', title: 'Linux runbook',
        read_at: new Date(Date.now() - 1).toISOString(), digest: 'sha256:test', summary: 'Read source',
        applicability: 'applicable', applicability_reason: 'Target is Linux', ...patch },
    }, who);
    await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_knowledge_required' });
    expect(((await service.taskDetail(run.run_id, 'a')) as Result).knowledge).toMatchObject({
      role: 'coordinator', subject: { address_id: a.address_id }, checks: [{ blocker: 'missing_receipt' }],
    });
    await note(b);
    await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_knowledge_required' });
    await note(a, {}, 'b');
    await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_knowledge_required' });
    await note(a);
    await note(a, { applicability: 'mismatch', applicability_reason: 'New discovery: target is Windows' });
    await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_knowledge_required', extra: { knowledge_checks: [{ blocker: 'applicability_mismatch' }] } });
    await note(a, { unavailable: true, digest: undefined });
    await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_knowledge_required' });
    await expect(note(a, { knowledge_id: 'undeclared' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(note(a, { uri: 'https://different.example' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(note(a, { read_at: '2099-01-01T00:00:00.000Z' })).rejects.toMatchObject({ code: 'validation_failed' });
    const unchanged = (await service.taskDetail(run.run_id, 'a')) as Result;
    expect(unchanged.task).toMatchObject({ status: 'pending', attempt_no: 0, version: 1, claim: null });
    expect(unchanged.attempts).toEqual([]);
    await note(a, { applicability: 'mismatch', applicability_reason: 'This task targets Windows' }, 'a');
    await note(a, { revision: 'runbook-v3', digest: undefined });
    // A general success must not clear the more precise task-specific mismatch.
    await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_knowledge_required' });
    await note(a, { revision: 'runbook-v3', digest: undefined }, 'a');
    const c = await claim(run.run_id, 'a');
    expect(c.task.status).toBe('running');
    expect(((await service.taskDetail(run.run_id, 'a')) as Result).knowledge).toMatchObject({
      role: 'claim_owner', subject: { address_id: a.address_id }, checks: [{ blocker: null, receipt: { source: { revision: 'runbook-v3' } } }],
    });
    // Another actor's run-wide receipt is valid for that actor's own linked task.
    expect((await claim(run.run_id, 'b', b)).task.status).toBe('running');
  });
  it('requires fresh binding receipts after operator recovery and preserves unaffected task execution', async () => {
    const doc = document();
    doc.knowledge = [{ id: 'source', title: 'Inline source', inline: 'Pinned Linux instructions', required_check: { applicability: 'Linux' } }];
    doc.tasks[0]!.knowledge_ids = ['source'];
    const { run } = await setup(doc);
    const { digest } = await import('../../src/services/workflows/contract.js');
    const snapshot = (await service.report(run.run_id)) as Result;
    const receipt = { run_id: run.run_id, kind: 'knowledge', text: 'Inline read', source: {
      knowledge_id: 'source', title: 'Inline source', uri: `workflow://${snapshot.workflow_sha256}/knowledge/source`,
      read_at: new Date().toISOString(), digest: digest('Pinned Linux instructions'), summary: 'Instructions read',
      applicability: 'applicable', applicability_reason: 'Linux task',
    } };
    const reader = await actor('codex');
    await join(run.run_id, reader);
    await call('run_note', receipt, reader);
    const generation = reader.binding_generation! + 1;
    await db.update(agentBusAddresses).set({ bindingGeneration: generation }).where(eq(agentBusAddresses.id, reader.address_id!));
    await db.update(agentSessions).set({ bindingGeneration: generation }).where(eq(agentSessions.id, reader.session_id!));
    await db.update(workflowRunMembers).set({ bindingGeneration: generation }).where(and(eq(workflowRunMembers.runId, run.run_id), eq(workflowRunMembers.agentAddressId, reader.address_id!)));
    const rebound = { ...reader, binding_generation: generation };
    await expect(claim(run.run_id, 'a', rebound)).rejects.toMatchObject({ code: 'workflow_knowledge_required' });
    await call('run_note', receipt, rebound);
    expect((await claim(run.run_id, 'a', rebound)).task.status).toBe('running');
    expect((await claim(run.run_id, 'b', rebound)).task.status).toBe('running');
  });
  it('serializes same-task contenders and preserves independent task progress', async () => {
    const { run } = await setup();
    await join(run.run_id);
    const attempts = await Promise.allSettled([claim(run.run_id, 'a', a), claim(run.run_id, 'a', b)]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const win = attempts.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Result>;
    const actor = attempts[0]!.status === 'fulfilled' ? a : b;
    const other = await claim(run.run_id, 'b', actor === a ? b : a);
    await Promise.all([
      result(run.run_id, 'a', win.value, actor),
      result(run.run_id, 'b', other, actor === a ? b : a),
    ]);
    const detail = (await service.runGet(run.run_id)) as Result;
    expect(detail.tasks.filter((t: Result) => t.status === 'succeeded')).toHaveLength(2);
    expect(detail.version).toBe(run.version);
    const rows = await db
      .select()
      .from(workflowTaskAttempts)
      .where(eq(workflowTaskAttempts.runId, run.run_id));
    expect(rows).toHaveLength(2);
  });
  it('claims different tasks concurrently over separate pool connections', async () => {
    const { run } = await setup();
    await join(run.run_id);
    const [ca, cb] = await Promise.all([claim(run.run_id, 'a', a), claim(run.run_id, 'b', b)]);
    expect(ca.task.status).toBe('running');
    expect(cb.task.status).toBe('running');
    await Promise.all([result(run.run_id, 'a', ca, a), result(run.run_id, 'b', cb, b)]);
    const read = (await service.runGet(run.run_id)) as Result;
    expect(read.tasks.filter((t: Result) => t.status === 'succeeded')).toHaveLength(2);
  });
  it('persists across service restart and replays create/finalize ACKs exactly', async () => {
    const { w, run, finish } = await successRun();
    const request = {
      client_request_id: randomUUID(),
      workflow_id: w.workflow_id,
      title: 'Replay create',
      inputs: {},
    };
    const created = (await service.mutate('run_create', request, a)) as Result;
    runIds.push(created.run_id);
    service = new WorkflowsService({ db, settings, keyring, publicBaseUrl: 'https://test.example' });
    expect(await service.mutate('run_create', request, a)).toEqual(created);
    const evaluation = {
      client_request_id: randomUUID(),
      run_id: run.run_id,
      expected_run_version: finish.version,
      coordinator_generation: 1,
      action: 'finalize',
      expected_evaluation_version: 1,
      evaluation: { findings: [], lessons: [], decision: 'no_change', reason: 'No changes needed' },
    };
    const finalized = await service.mutate('run_evaluate', evaluation, a);
    service = new WorkflowsService({ db, settings, keyring, publicBaseUrl: 'https://test.example' });
    expect(await service.mutate('run_evaluate', evaluation, a)).toEqual(finalized);
  });
  it('validates outcome consistency and finalizes failed, partial and canceled runs', async () => {
    for (const outcome of ['failed', 'partial', 'canceled']) {
      const { run } = await setup();
      if (outcome === 'partial') await result(run.run_id, 'a', await claim(run.run_id, 'a'));
      const criteria = [
        {
          id: 'a',
          status: outcome === 'partial' ? 'met' : 'unverified',
          reason: 'Observed result',
          evidence_ids: outcome === 'partial' ? ['a'] : [],
        },
        { id: 'b', status: 'unverified', reason: 'Not attempted', evidence_ids: [] },
      ];
      await expect(
        call('run_finish', {
          run_id: run.run_id,
          expected_run_version: run.version,
          coordinator_generation: 1,
          outcome: 'succeeded',
          summary: 'Unsupported success',
          criteria,
        }),
      ).rejects.toMatchObject({ code: 'workflow_outcome_inconsistent' });
      const finish = await call('run_finish', {
        run_id: run.run_id,
        expected_run_version: run.version,
        coordinator_generation: 1,
        outcome,
        summary: 'Explicit outcome',
        criteria,
      });
      const end = await call('run_evaluate', {
        run_id: run.run_id,
        expected_run_version: finish.version,
        coordinator_generation: 1,
        action: 'finalize',
        expected_evaluation_version: 1,
        evaluation: {
          findings: [],
          lessons: [],
          decision: 'no_change',
          reason: 'Run-specific condition, no template change',
        },
      });
      expect(end.status).toBe('completed');
      expect(end.outcome).toBe(outcome);
      expect(((await service.report(run.run_id)) as Result).report.outcome).toBe(outcome);
    }
  });
  it('rejects changed goals, bad note references and stale version restores', async () => {
    const { w, run } = await setup();
    const changed = document();
    changed.goal.statement = 'Different target';
    await expect(
      call(
        'revise',
        { workflow_id: w.workflow_id, expected_workflow_version: 1, document: changed, reason: 'Different' },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'workflow_goal_changed' });
    await expect(
      call('run_note', { run_id: run.run_id, kind: 'note', text: 'Bad ref', evidence_ids: ['missing'] }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const altered = document();
    altered.summary = 'Revision two';
    await call(
      'revise',
      { workflow_id: w.workflow_id, expected_workflow_version: 1, document: altered, reason: 'Version 2' },
      admin,
    );
    await expect(
      call(
        'revert',
        { workflow_id: w.workflow_id, expected_workflow_version: 1, version: 1, reason: 'Restore' },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'workflow_version_conflict' });
    const restored = await call(
      'revert',
      { workflow_id: w.workflow_id, expected_workflow_version: 2, version: 1, reason: 'Restore' },
      admin,
    );
    expect(restored.version).toBe(3);
    expect((await service.get(w.workflow_id, 2)).document.summary).toBe('Revision two');
  });
  it('keeps agent execution replies compact while full reads retain the prepared instructions', async () => {
    const doc = document();
    doc.tasks = doc.tasks.map((task) => ({ ...task, instructions: 'Detailed pinned instruction. '.repeat(2000) }));
    const { run } = await setup(doc);
    const claimed = await claim(run.run_id, 'a');
    const note = await call('run_note', { run_id: run.run_id, kind: 'note', text: 'Working on the pinned task' });
    const updated = await result(run.run_id, 'a', claimed);
    for (const response of [claimed, note, updated]) {
      expect(response.compact).toBe(true);
      expect(response.preparation).toMatchObject({ phase: 'ready', summary_revision: run.preparation.summary.revision,
        confirmed_summary_revision: run.preparation.summary.revision });
      expect(response.preparation.summary).toBeUndefined();
      expect(JSON.stringify(response).length).toBeLessThan(4000);
      expect(response.report_url).toContain(run.run_id);
    }
    expect(claimed.claim_token).toEqual(expect.any(String));
    expect(claimed.task).toMatchObject({ task_id: 'a', status: 'running', version: 2 });
    expect(updated.task).toMatchObject({ task_id: 'a', status: 'succeeded', version: 3 });
    const full = await service.runGet(run.run_id) as Result;
    expect(full.preparation.summary.tasks[0].instructions).toBe(doc.tasks[0]!.instructions);
  });
  it('replays encrypted claim and result receipts before stale CAS validation', async () => {
    const { run } = await setup();
    const body = {
      client_request_id: randomUUID(),
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: 1,
      action: 'acquire',
    };
    const c = (await service.mutate('task_claim', body, a)) as Result;
    expect(await service.mutate('task_claim', body, a)).toEqual(c);
    const [receipt] = await db
      .select()
      .from(workflowMutations)
      .where(eq(workflowMutations.clientRequestId, body.client_request_id));
    expect(JSON.stringify(receipt!.response)).not.toContain(c.claim_token);
    expect(receipt!.secretResponse).toMatch(/^sbox:/);
    expect(JSON.stringify(await service.runGet(run.run_id))).not.toContain(c.claim_token);
    const update = {
      client_request_id: randomUUID(),
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: c.task.version,
      action: 'result',
      claim_token: c.claim_token,
      claim_generation: c.claim_generation,
      status: 'succeeded',
      summary: 'Verified',
      outputs: { a: 1 },
      evidence: [evidence('a')],
      execution_host: 'test',
    };
    const first = await service.mutate('task_update', update, a);
    expect(await service.mutate('task_update', update, a)).toEqual(first);
    await expect(service.mutate('task_update', { ...update, summary: 'Different' }, a)).rejects.toMatchObject(
      { code: 'workflow_idempotency_conflict' },
    );
  });
  it('projects expiry and reconciles using exactly the visible version', async () => {
    const { run } = await setup();
    const c = await claim(run.run_id, 'a');
    await db
      .update(workflowRunTasks)
      .set({ claimLeaseUntil: '2000-01-01T00:00:00.000Z' })
      .where(and(eq(workflowRunTasks.runId, run.run_id), eq(workflowRunTasks.taskId, 'a')));
    const expired = await service.taskDetail(run.run_id, 'a');
    expect(expired.task.status).toBe('uncertain');
    expect(expired.task.version).toBe(c.task.version + 1);
    await expect(result(run.run_id, 'a', c)).rejects.toMatchObject({
      code: 'workflow_task_version_conflict',
    });
    const recovery = await call('task_claim', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: expired.task.version,
      action: 'reconcile',
      stage: 'begin',
      reason: 'Inspect old process',
    });
    expect(recovery.task.attempt_no).toBe(1);
    await expect(
      call('task_claim', {
        run_id: run.run_id,
        task_id: 'a',
        expected_task_version: recovery.task.version,
        action: 'reconcile',
        stage: 'resolve',
        resolution: 'safe_to_retry',
        reason: 'Unknown',
        claim_token: recovery.claim_token,
        claim_generation: recovery.claim_generation,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const resolved = await call('task_claim', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: recovery.task.version,
      action: 'reconcile',
      stage: 'resolve',
      resolution: 'safe_to_retry',
      reason: 'Old process gone and target clean',
      old_execution_stopped: true,
      evidence: [evidence('stopped')],
      execution_host: 'test',
      claim_token: recovery.claim_token,
      claim_generation: recovery.claim_generation,
    });
    const retry = await call('task_update', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: resolved.task.version,
      action: 'retry',
      reason: 'Safe to retry',
    });
    const next = await claim(run.run_id, 'a', a, retry.task.version);
    expect(next.task.attempt_no).toBe(2);
  });
  it('does not let dependency claims, uninvited agents or wrong tokens mutate tasks', async () => {
    const { run } = await setup();
    await expect(claim(run.run_id, 'verify')).rejects.toMatchObject({ code: 'workflow_dependency_unmet' });
    await expect(claim(run.run_id, 'a', b)).rejects.toMatchObject({ code: 'workflow_member_required' });
    const c = await claim(run.run_id, 'a');
    await expect(result(run.run_id, 'a', { ...c, claim_token: 'x'.repeat(43) })).rejects.toMatchObject({
      code: 'workflow_claim_lost',
    });
  });
  it('pauses new work while accepting already owned results and supports blocked retries', async () => {
    const { run } = await setup(),
      c = await claim(run.run_id, 'a');
    const paused = await call('run_control', {
      run_id: run.run_id,
      expected_run_version: run.version,
      coordinator_generation: 1,
      action: 'pause',
      reason: 'Check environment',
    });
    await expect(claim(run.run_id, 'b')).rejects.toMatchObject({ code: 'workflow_run_not_running' });
    const blocked = await result(run.run_id, 'a', c, a, 'blocked');
    await call('run_control', {
      run_id: run.run_id,
      expected_run_version: paused.version,
      coordinator_generation: 1,
      action: 'resume',
      reason: 'Environment restored',
    });
    const retry = await call('task_update', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: blocked.task.version,
      action: 'retry',
      reason: 'Prerequisite restored',
    });
    expect(retry.task.status).toBe('pending');
  });
  it('retains evaluation drafts on version conflict and finalizes only one revision', async () => {
    const { w, run, finish } = await successRun();
    const changed = document();
    changed.tasks[0]!.instructions = 'Clarified';
    const other = document();
    other.summary = 'Other improvement';
    await call(
      'revise',
      {
        workflow_id: w.workflow_id,
        expected_workflow_version: 1,
        document: other,
        reason: 'Concurrent revision',
      },
      admin,
    );
    const evaluation = {
      findings: [{ text: 'Unclear step', task_ids: ['a'], evidence_ids: ['a'] }],
      lessons: ['Use precise wording'],
      decision: 'revise',
      reason: 'Clarify first task',
      document: changed,
      expected_workflow_version: 1,
    };
    const req = {
      client_request_id: randomUUID(),
      run_id: run.run_id,
      expected_run_version: finish.version,
      coordinator_generation: 1,
      action: 'finalize',
      expected_evaluation_version: 1,
      evaluation,
    };
    await expect(service.mutate('run_evaluate', req, a)).rejects.toMatchObject({
      code: 'workflow_version_conflict',
      extra: { evaluation_version: 2 },
    });
    await expect(service.mutate('run_evaluate', req, a)).rejects.toMatchObject({
      code: 'workflow_version_conflict',
    });
    const snapshot = (await service.runGet(run.run_id)) as Result;
    expect(snapshot.evaluation.status).toBe('draft');
    expect(snapshot.evaluation.draft.reason).toBe(evaluation.reason);
    const final = await call('run_evaluate', {
      ...req,
      client_request_id: randomUUID(),
      expected_evaluation_version: 2,
      evaluation: { ...evaluation, expected_workflow_version: 2 },
    });
    expect(final.status).toBe('completed');
    expect(final.evaluation.applied_version).toBe(3);
    expect(((await service.report(run.run_id)) as Result).report.report_schema_version).toBe(1);
    await expect(
      call('run_note', { run_id: run.run_id, kind: 'note', text: 'Too late' }),
    ).rejects.toMatchObject({ code: 'workflow_run_completed' });
  });
  it('fences previous coordinator after transfer and allows no-change finalization', async () => {
    const { run, finish } = await successRun();
    await join(run.run_id);
    const transferred = await call('run_control', {
      run_id: run.run_id,
      expected_run_version: finish.version,
      coordinator_generation: 1,
      action: 'coordinator_transfer',
      target_address_id: b.address_id,
      reason: 'Handoff',
    });
    const req = {
      run_id: run.run_id,
      expected_run_version: transferred.version,
      coordinator_generation: 1,
      action: 'finalize',
      expected_evaluation_version: 1,
      evaluation: {
        findings: [],
        lessons: [],
        decision: 'no_change',
        reason: 'All instructions remained clear',
      },
    };
    await expect(call('run_evaluate', req)).rejects.toMatchObject({ code: 'workflow_coordinator_lost' });
    await db
      .update(workflowRunMembers)
      .set({ status: 'left' })
      .where(
        and(eq(workflowRunMembers.runId, run.run_id), eq(workflowRunMembers.agentAddressId, a.address_id!)),
      );
    const done = await call('run_evaluate', { ...req, coordinator_generation: 2 }, b);
    expect(done.status).toBe('completed');
  });
  it('requires unknown outcome for uncertain attempts and never calls them canceled', async () => {
    const { run } = await setup(),
      c = await claim(run.run_id, 'a');
    const released = await call('task_claim', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: c.task.version,
      claim_token: c.claim_token,
      claim_generation: c.claim_generation,
      action: 'release',
      reason: 'Disconnected target; unknown effects',
    });
    expect(released.task.status).toBe('uncertain');
    const finish = {
      run_id: run.run_id,
      expected_run_version: run.version,
      coordinator_generation: 1,
      summary: 'Lost target',
      criteria: [
        { id: 'a', status: 'unverified', reason: 'No proof', evidence_ids: [] },
        { id: 'b', status: 'unverified', reason: 'Not run', evidence_ids: [] },
      ],
      outcome: 'canceled',
    };
    await expect(call('run_finish', finish)).rejects.toMatchObject({ code: 'workflow_task_uncertain' });
    const out = await call('run_finish', {
      ...finish,
      outcome: 'unknown',
      uncertain_task_ids: ['a'],
      open_items: ['External process may still exist'],
    });
    expect(out.status).toBe('evaluating');
  });
  it('module disabled blocks new work but permits existing completion and evaluation', async () => {
    const { run, finish } = await successRun();
    await service.setEnabled(false, admin, randomUUID());
    try {
      await expect(setup()).rejects.toMatchObject({ code: 'workflows_disabled' });
      const out = await call('run_evaluate', {
        run_id: run.run_id,
        expected_run_version: finish.version,
        coordinator_generation: 1,
        action: 'finalize',
        expected_evaluation_version: 1,
        evaluation: { findings: [], lessons: [], decision: 'no_change', reason: 'No changes needed' },
      });
      expect(out.status).toBe('completed');
    } finally {
      await service.setEnabled(true, admin, randomUUID());
    }
  });
  it('rechecks binding before idempotent claim replay', async () => {
    const { run } = await setup();
    const req = {
      client_request_id: randomUUID(),
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: 1,
      action: 'acquire',
    };
    await service.mutate('task_claim', req, a);
    await db
      .update(agentBusAddresses)
      .set({ bindingGeneration: 2 })
      .where(eq(agentBusAddresses.id, a.address_id!));
    try {
      await expect(service.mutate('task_claim', req, a)).rejects.toMatchObject({
        code: 'workflow_binding_changed',
      });
    } finally {
      await db
        .update(agentBusAddresses)
        .set({ bindingGeneration: 1 })
        .where(eq(agentBusAddresses.id, a.address_id!));
    }
  });
  it('discovers earlier bindings without inheriting membership or claim authority', async () => {
    const { run } = await setup();
    await result(run.run_id, 'a', await claim(run.run_id, 'a'));
    const oldClaim = await claim(run.run_id, 'b');
    const [oldSession] = await db.select().from(agentSessions).where(eq(agentSessions.id, a.session_id!));
    const resumed = { ...a, session_id: randomUUID(), binding_generation: 2 };
    await db.insert(agentSessions).values({ ...oldSession!, id: resumed.session_id, bindingGeneration: 2 });
    await db
      .update(agentBusAddresses)
      .set({ currentSessionId: resumed.session_id, bindingGeneration: 2 })
      .where(eq(agentBusAddresses.id, a.address_id!));
    const collaborative = new WorkflowsService({
      db,
      settings,
      keyring,
      collaboration: {
        lock: async () => {},
        resolveTarget: async () => resumed,
        invite: async () => ({ message_id: randomUUID() }),
        syncGroup: async () => null,
      },
    });
    try {
      const before = await service.runGet(run.run_id);
      if (!('tasks' in before)) throw new Error('Expected run projection');
      const current = await service.runCurrent(resumed);
      expect(current.runs.some((r) => r.run_id === run.run_id)).toBe(false);
      expect(current.claims.some((t) => t.run_id === run.run_id)).toBe(false);
      expect(current.stale_memberships).toContainEqual(
        expect.objectContaining({
          run_id: run.run_id,
          binding_current: false,
          session_id: a.session_id,
          binding_generation: 1,
          recovery_required: 'operator_coordinator_recover',
        }),
      );
      expect(current.stale_claims).toContainEqual(
        expect.objectContaining({
          run_id: run.run_id,
          task_id: 'b',
          binding_current: false,
          recovery_required: 'resolve_old_claim_then_operator_recovery',
        }),
      );
      expect(JSON.stringify(current)).not.toContain(oldClaim.claim_token);
      expect(JSON.stringify(current)).not.toMatch(/claimTokenHash|claim_token|secretResponse/);
      expect(await service.runGet(run.run_id)).toMatchObject({
        version: before.version,
        tasks: before.tasks,
      });
      const stranger = await service.runCurrent(b);
      expect(stranger.stale_memberships.some((r) => r.run_id === run.run_id)).toBe(false);
      expect(stranger.stale_claims.some((t) => t.run_id === run.run_id)).toBe(false);
      await expect(service.runCurrent(a)).rejects.toMatchObject({ code: 'workflow_binding_changed' });
      await expect(result(run.run_id, 'b', oldClaim, resumed)).rejects.toMatchObject({
        code: 'workflow_member_required',
      });
      const recovery = {
        client_request_id: randomUUID(),
        run_id: run.run_id,
        expected_run_version: run.version,
        action: 'coordinator_recover',
        target_address_id: a.address_id,
        reason: 'Explicit resume recovery',
      };
      await expect(collaborative.mutate('run_control', recovery, admin)).rejects.toMatchObject({
        code: 'workflow_member_has_claims',
      });
      await db
        .update(workflowRunTasks)
        .set({ claimLeaseUntil: '2000-01-01T00:00:00.000Z' })
        .where(and(eq(workflowRunTasks.runId, run.run_id), eq(workflowRunTasks.taskId, 'b')));
      const expired = await service.runCurrent(resumed);
      expect(expired.stale_claims.find((t) => t.run_id === run.run_id)?.status).toBe('uncertain');
      await collaborative.mutate('run_control', recovery, admin);
      const recovered = await service.runCurrent(resumed);
      expect(recovered.stale_memberships.some((r) => r.run_id === run.run_id)).toBe(false);
      expect(recovered.stale_claims.some((t) => t.run_id === run.run_id)).toBe(false);
      expect(recovered.runs).toContainEqual(
        expect.objectContaining({
          run_id: run.run_id,
          coordinator: expect.objectContaining({ generation: 2 }),
        }),
      );
      const detail = await service.runGet(run.run_id);
      if (!('tasks' in detail)) throw new Error('Expected run projection');
      expect(detail.tasks.find((t) => t.task_id === 'a')?.status).toBe('succeeded');
      expect(detail.tasks.find((t) => t.task_id === 'b')?.status).toBe('uncertain');
    } finally {
      await db
        .update(agentBusAddresses)
        .set({ currentSessionId: a.session_id, bindingGeneration: 1 })
        .where(eq(agentBusAddresses.id, a.address_id!));
    }
  });
  it('prepared cancellation remains evaluation-pending and archive retains history', async () => {
    const { w } = await setup();
    const pending = await call(
      'run_create',
      { workflow_id: w.workflow_id, title: 'Prepared', inputs: {} },
      admin,
    );
    runIds.push(pending.run_id);
    const cancel = await call(
      'prepare_cancel',
      { run_id: pending.run_id, expected_run_version: 1, reason: 'No longer required' },
      admin,
    );
    expect(cancel.status).toBe('evaluating');
    expect(cancel.outcome).toBe('canceled');
    await call(
      'archive',
      {
        workflow_id: w.workflow_id,
        expected_workflow_version: 1,
        expected_control_version: 1,
        action: 'archive',
        reason: 'Retire',
      },
      admin,
    );
    await expect(
      call('run_create', { workflow_id: w.workflow_id, title: 'Cannot run', inputs: {} }, admin),
    ).rejects.toMatchObject({ code: 'workflow_archived' });
    expect((await service.get(w.workflow_id)).status).toBe('archived');
    expect(((await service.report(pending.run_id)) as Result).evaluation.status).toBe('pending');
  });
  it('rejects actor spoofing fields and never exposes claim secrets through any read projection', async () => {
    const { w, run } = await setup();
    await expect(
      call('run_note', {
        run_id: run.run_id,
        kind: 'note',
        text: 'Forged',
        actor: { kind: 'admin', id: '1' },
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      call('run_control', {
        run_id: run.run_id,
        action: 'coordinator_recover',
        expected_run_version: run.version,
        target_address_id: b.address_id,
        reason: 'Pretend operator',
      }),
    ).rejects.toMatchObject({ code: 'workflow_admin_required' });
    const c = await claim(run.run_id, 'a');
    const [row] = await db
      .select()
      .from(workflowRunTasks)
      .where(and(eq(workflowRunTasks.runId, run.run_id), eq(workflowRunTasks.taskId, 'a')));
    for (const projection of await Promise.all([
      service.list(),
      service.get(w.workflow_id),
      service.versions(w.workflow_id),
      service.runList(),
      service.runGet(run.run_id),
      service.report(run.run_id),
      service.taskDetail(run.run_id, 'a'),
      service.events(run.run_id),
      service.runCurrent(a),
    ])) {
      const encoded = JSON.stringify(projection);
      expect(encoded).not.toContain(c.claim_token);
      expect(encoded).not.toContain(row!.claimTokenHash!);
      expect(encoded).not.toContain('secret_response');
    }
  });
  it('retains uncertain evidence during recovery and refuses redefined evidence IDs', async () => {
    const { run } = await setup();
    const initial = await result(run.run_id, 'a', await claim(run.run_id, 'a'), a, 'uncertain');
    const recovery = await call('task_claim', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: initial.task.version,
      action: 'reconcile',
      stage: 'begin',
      reason: 'Inspect prior execution',
    });
    const uncertain = await call('task_claim', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: recovery.task.version,
      action: 'reconcile',
      stage: 'resolve',
      resolution: 'still_uncertain',
      reason: 'Partial investigation',
      evidence: [evidence('investigation')],
      claim_token: recovery.claim_token,
      claim_generation: recovery.claim_generation,
    });
    const detail = await service.taskDetail(run.run_id, 'a');
    expect((detail.task.evidence as { id: string }[]).map((e) => e.id)).toEqual(['a', 'investigation']);
    expect(detail.attempts[0]!.ended_at).toBeNull();
    const next = await call('task_claim', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: uncertain.task.version,
      action: 'reconcile',
      stage: 'begin',
      reason: 'Complete investigation',
    });
    const resolved = await call('task_claim', {
      run_id: run.run_id,
      task_id: 'a',
      expected_task_version: next.task.version,
      action: 'reconcile',
      stage: 'resolve',
      resolution: 'verified_success',
      reason: 'No running old process; output verified',
      old_execution_stopped: true,
      evidence: [evidence('verified')],
      outputs: { artifact: 'recovered' },
      execution_host: 'actual-target',
      claim_token: next.claim_token,
      claim_generation: next.claim_generation,
    });
    expect(resolved.task.status).toBe('succeeded');
    const final = await service.taskDetail(run.run_id, 'a');
    expect((final.attempts[0]!.evidence as { id: string }[]).map((e) => e.id)).toEqual([
      'a',
      'investigation',
      'verified',
    ]);
    const other = await claim(run.run_id, 'b');
    await expect(
      call('task_update', {
        run_id: run.run_id,
        task_id: 'b',
        expected_task_version: other.task.version,
        action: 'result',
        status: 'succeeded',
        summary: 'Collision',
        outputs: {},
        evidence: [{ ...evidence('a'), description: 'Different observation under old ID' }],
        execution_host: 'test',
        claim_token: other.claim_token,
        claim_generation: other.claim_generation,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await service.taskDetail(run.run_id, 'b')).task.status).toBe('running');
  });
  it('rejects a changed-goal evaluation draft before saving or returning head conflict', async () => {
    const { w, run, finish } = await successRun();
    const changed = document();
    changed.goal.success_criteria[0]!.text = 'Weakened criterion';
    for (const action of ['save_draft', 'finalize'])
      await expect(
        call('run_evaluate', {
          run_id: run.run_id,
          expected_run_version: finish.version,
          coordinator_generation: 1,
          expected_evaluation_version: 1,
          action,
          evaluation: {
            findings: [],
            lessons: [],
            decision: 'revise',
            reason: 'Changing goal is prohibited',
            document: changed,
            expected_workflow_version: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'workflow_goal_changed' });
    expect(((await service.runGet(run.run_id)) as Result).evaluation).toMatchObject({
      version: 1,
      status: 'pending',
      draft: null,
    });
    expect((await service.get(w.workflow_id)).version).toBe(1);
  });
  it('serializes two improving runs without losing either evaluation or duplicating a version', async () => {
    const first = await successRun(),
      second = await successRun(first.w.workflow_id);
    const changed = document();
    changed.tasks[0]!.instructions = 'One shared clarification';
    const evaluate = (run: Result, version: number) => ({
      run_id: run.run_id,
      expected_run_version: run.version,
      coordinator_generation: 1,
      expected_evaluation_version: version,
      action: 'finalize',
      evaluation: {
        findings: [],
        lessons: [],
        decision: 'revise',
        reason: 'Clarify once',
        document: changed,
        expected_workflow_version: 1,
      },
    });
    const results = await Promise.allSettled([
      call('run_evaluate', evaluate(first.finish, 1)),
      call('run_evaluate', evaluate(second.finish, 1)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.get(first.w.workflow_id)).version).toBe(2);
    const losing = results[0]!.status === 'rejected' ? first : second;
    const pending = (await service.runGet(losing.run.run_id)) as Result;
    expect(pending.status).toBe('evaluating');
    expect(pending.evaluation).toMatchObject({ status: 'draft', version: 2 });
    const req = evaluate(losing.finish, 2);
    req.evaluation.expected_workflow_version = 2;
    const complete = await call('run_evaluate', req);
    expect(complete.evaluation.draft.decision).toBe('no_change');
    expect((await service.get(first.w.workflow_id)).version).toBe(2);
  });
  it('keeps invitation/member state separate and finalizes prepared cancellation through explicit recovery', async () => {
    const hook: WorkflowCollaboration = {
      lock: async () => {},
      resolveTarget: async (_tx, id) => [a, b].find((actor) => actor.address_id === id)!,
      invite: async () => ({ message_id: randomUUID() }),
      syncGroup: async (_tx, input) => ({
        group_id: input.group_id ?? randomUUID(),
        room_id: input.group_id ?? randomUUID(),
        group_topic: `group:workflow-run-${input.run_id}`,
        communication_url: '/admin/agents',
      }),
    };
    const collaborative = new WorkflowsService({ db, settings, keyring, collaboration: hook });
    const { w, run } = await setup();
    const invited = (await collaborative.mutate(
      'invite',
      {
        client_request_id: randomUUID(),
        run_id: run.run_id,
        target_address_id: b.address_id,
        reason: 'Help',
        task_ids: [],
      },
      a,
    )) as Result;
    expect(invited).toMatchObject({
      status: 'running',
      invitation_status: 'pending',
      created_at: run.created_at,
    });
    const joined = (await collaborative.mutate(
      'membership',
      {
        client_request_id: randomUUID(),
        run_id: run.run_id,
        action: 'accept',
        invitation_id: invited.invitation_id,
        reason: 'Ready',
      },
      b,
    )) as Result;
    expect(joined).toMatchObject({ status: 'running', membership_status: 'accepted' });
    const prepared = await call(
      'run_create',
      { workflow_id: w.workflow_id, title: 'Cancel before starting', inputs: {} },
      admin,
    );
    runIds.push(prepared.run_id);
    const cancel = await call(
      'prepare_cancel',
      { run_id: prepared.run_id, expected_run_version: 1, reason: 'No execution required' },
      admin,
    );
    expect(cancel.started_at).toBeNull();
    await expect(
      call(
        'task_update',
        {
          run_id: prepared.run_id,
          task_id: 'a',
          action: 'skip',
          skip_reason: 'not_applicable',
          reason: 'Pretend admin result',
          expected_task_version: 2,
        },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'workflow_agent_required' });
    const recovered = (await collaborative.mutate(
      'run_control',
      {
        client_request_id: randomUUID(),
        run_id: prepared.run_id,
        expected_run_version: cancel.version,
        action: 'coordinator_recover',
        target_address_id: a.address_id,
        reason: 'Evaluate canceled preparation',
      },
      admin,
    )) as Result;
    const completed = (await collaborative.mutate(
      'run_evaluate',
      {
        client_request_id: randomUUID(),
        run_id: prepared.run_id,
        expected_run_version: recovered.version,
        coordinator_generation: recovered.coordinator.generation,
        action: 'finalize',
        expected_evaluation_version: 1,
        evaluation: {
          findings: [],
          lessons: [],
          decision: 'no_change',
          reason: 'Canceled before execution; no workflow defect',
        },
      },
      a,
    )) as Result;
    expect(completed).toMatchObject({ status: 'completed', outcome: 'canceled', started_at: null });
    const snapshot = ((await service.report(prepared.run_id)) as Result).report;
    expect(snapshot.tasks.every((t: Result) => t.status === 'skipped' && t.skip_reason === 'run_ended')).toBe(
      true,
    );
  });
  it('clarifies partial typed inputs and follow-ups before versioned explicit approval', async () => {
    const doc = document();
    doc.inputs = [
      { key: 'cpus', label: 'How many CPUs?', type: 'number', required: true },
      { key: 'backup', label: 'Enable backup?', type: 'boolean', required: true },
      { key: 'site', label: 'Location?', type: 'enum', required: true, options: ['east', 'west'] },
    ];
    const { run } = await setup(doc, false);
    expect(run).toMatchObject({ status: 'pending', started_at: null, inputs: {}, preparation: { phase: 'clarifying' } });
    const control = (r: Result, action: string, extra = {}) => call('run_control', {
      run_id: r.run_id, expected_run_version: r.version, coordinator_generation: r.coordinator.generation, action, ...extra,
    });
    await expect(control(run, 'start')).rejects.toMatchObject({ code: 'workflow_confirmation_required' });
    await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_confirmation_required' });
    await expect(control(run, 'present_summary')).rejects.toMatchObject({ code: 'validation_failed' });
    let r = await control(run, 'configure', { inputs: { cpus: 0, backup: false }, questions: [{ id: 'os', question: 'Which OS?' }] });
    await expect(control(r, 'present_summary')).rejects.toMatchObject({ code: 'validation_failed' });
    r = await control(r, 'configure', { inputs: { cpus: 0, backup: false, site: 'east' } });
    await expect(control(r, 'present_summary')).rejects.toMatchObject({ code: 'validation_failed' });
    r = await control(r, 'configure', { questions: [{ id: 'os', question: 'Which OS?', answer: 'Debian' }] });
    const before = r;
    const request = { client_request_id: randomUUID(), run_id: r.run_id, expected_run_version: r.version,
      coordinator_generation: 1, action: 'present_summary', notes: 'Use existing network' };
    r = await service.mutate('run_control', request, a);
    expect(await service.mutate('run_control', request, a)).toEqual(r);
    expect(r.preparation.summary).toMatchObject({ inputs: { cpus: 0, backup: false, site: 'east' }, questions: [{ answer: 'Debian' }], notes: 'Use existing network' });
    await expect(control(before, 'configure', { inputs: {} })).rejects.toMatchObject({ code: 'workflow_run_version_conflict' });
    await expect(control(r, 'confirm_summary', { summary_revision: r.preparation.summary.revision })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(control(r, 'confirm_summary', { summary_revision: 999, user_confirmation: 'Yes' })).rejects.toMatchObject({ code: 'workflow_summary_revision_conflict' });
    const summaryRevision = r.preparation.summary.revision;
    r = await control(r, 'confirm_summary', { summary_revision: summaryRevision, user_confirmation: 'Yes, use these settings' });
    expect(r).toMatchObject({ status: 'pending', preparation: { phase: 'ready', confirmation: { channel: 'conversation', user_confirmation: 'Yes, use these settings' } } });
    await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_run_not_running' });
    r = await control(r, 'configure', { inputs: { cpus: 2, backup: false, site: 'west' } });
    expect(r.preparation).toMatchObject({ phase: 'clarifying', summary: null, confirmation: null });
    await expect(control(r, 'start')).rejects.toMatchObject({ code: 'workflow_confirmation_required' });
    await expect(control(r, 'confirm_summary', { summary_revision: summaryRevision, user_confirmation: 'Yes' })).rejects.toMatchObject({ code: 'workflow_summary_revision_conflict' });
    r = await begin(r);
    expect(r.status).toBe('running');
    expect((await claim(r.run_id, 'a')).task.status).toBe('running');
    const history = await service.events(r.run_id);
    expect(history.items.some(e => e.type === 'run.confirm_summary' && JSON.stringify(e.detail).includes('Yes, use these settings'))).toBe(true);
  });
  it('requires review even without questions, and supports web approval without launching an agent', async () => {
    const doc = document(); doc.inputs = [];
    const w = await call('create', { slug: `test-${randomUUID()}`, document: doc, reason: 'No inputs' }, admin);
    workflowIds.push(w.workflow_id);
    let r = await call('run_create', { workflow_id: w.workflow_id, title: 'Web request' }, admin);
    runIds.push(r.run_id);
    const control = (action: string, extra = {}) => call('run_control', { run_id: r.run_id, expected_run_version: r.version, action, ...extra }, admin);
    r = await control('present_summary');
    r = await control('confirm_summary', { summary_revision: r.preparation.summary.revision });
    expect(r).toMatchObject({ status: 'pending', coordinator: null, preparation: { phase: 'ready', confirmation: { channel: 'web' } } });
    r = await call('run_control', { run_id: r.run_id, expected_run_version: r.version, action: 'start' });
    expect(r.status).toBe('running');
  });
  it('preserves unconfirmed preparation during coordinator recovery and rejects duplicate questions', async () => {
    const { run } = await setup(document(), false);
    await expect(call('run_control', { run_id: run.run_id, expected_run_version: run.version, action: 'configure',
      questions: [{ id: 'x', question: 'One?' }, { id: 'x', question: 'Two?' }] })).rejects.toMatchObject({ code: 'validation_failed' });
    const recovery = new WorkflowsService({ db, settings, keyring, collaboration: {
      lock: async () => {}, resolveTarget: async () => a, syncGroup: async () => null, invite: async () => ({ message_id: randomUUID() }),
    } });
    const r = await recovery.mutate('run_control', { client_request_id: randomUUID(), run_id: run.run_id,
      expected_run_version: run.version, action: 'coordinator_recover', target_address_id: a.address_id, reason: 'Recover preparation' }, admin);
    expect(r).toMatchObject({ status: 'pending', started_at: null, preparation: { phase: 'clarifying' } });
    await expect(call('run_control', { run_id: run.run_id, expected_run_version: r.version, action: 'start', coordinator_generation: 2 })).rejects.toMatchObject({ code: 'workflow_confirmation_required' });
  });
  it('allows historical runs to drain with protocol 1 while fencing new preparation participation', async () => {
    const { run, w } = await setup();
    await db.update(agentSessions).set({ adapterCapabilities: { workflow_protocol_version: 1 } }).where(eq(agentSessions.id, a.session_id!));
    try {
      await expect(call('run_create', { workflow_id: w.workflow_id, title: 'Old client' })).rejects.toMatchObject({ code: 'workflow_wrapper_outdated' });
      await expect(claim(run.run_id, 'a')).rejects.toMatchObject({ code: 'workflow_wrapper_outdated' });
      await db.update(workflowRuns).set({ preparation: null }).where(eq(workflowRuns.id, run.run_id));
      expect((await claim(run.run_id, 'a')).task.status).toBe('running');
    } finally {
      await db.update(agentSessions).set({ adapterCapabilities: { workflow_protocol_version: 2 } }).where(eq(agentSessions.id, a.session_id!));
    }
  });
  it('keeps the confirmed request in the final report', async () => {
    const { run, finish } = await successRun();
    const end = await call('run_evaluate', { run_id: run.run_id, expected_run_version: finish.version, coordinator_generation: 1,
      expected_evaluation_version: 1, action: 'finalize', evaluation: { findings: [], lessons: [], decision: 'no_change', reason: 'Verified' } });
    expect(end.status).toBe('completed');
    const report = await service.report(run.run_id) as Result;
    expect(report.report.preparation).toMatchObject({ phase: 'ready', confirmation: { channel: 'conversation' }, summary: { inputs: { enabled: true } } });
  });

});
