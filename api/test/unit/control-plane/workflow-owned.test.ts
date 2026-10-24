import { WorkflowsService } from '../../../src/services/workflows.js';
import { SettingsService } from '../../../src/services/settings.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { GrokUsageService } from '../../../src/services/grok-usage.js';
import { ChatGptUsageService } from '../../../src/services/chatgpt-usage.js';
import {
  requestOwnedEngineDestroy,
  recordOwnedDestroyReport,
  purgeOwnedEngine,
  ownedDestroyProgress,
} from '../../../src/control-plane/streams/engine-destroy.js';
import { LegacyDrainRegistry, captureLegacyDrainManifest } from '../../../src/control-plane/legacy-drain.js';
import {
  registerOwnedReceiver,
  updateOwnedReceiver,
  ownedReceiverReady,
  statusOwnedReceiver,
} from '../../../src/control-plane/streams/receiver.js';
import {
  registerOwnedRelay,
  ownedRelayTargets,
  heartbeatOwnedRelay,
} from '../../../src/control-plane/streams/relay.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { recordOwnedNativeReceipt } from '../../../src/control-plane/streams/native-control.js';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../src/control-plane/presence.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring, loadTestEnv } from '../../helpers/test-keyring.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { NativeStopService } from '../../../src/services/native-stop.js';
import { daemonSweepObligations } from '../../../src/control-plane/streams/daemon-deadlines.js';

const queues: DeadlineQueue[] = [];
afterEach(() => {
  queues.splice(0).forEach((q) => q.close());
  vi.useRealTimers();
});
function harness(extra: Record<string, Record<string, unknown>[]> = {}) {
  const now = new Date().toISOString();
  const seed = {
    hosts: [
      {
        id: 1,
        fqdn: 'fixture',
        apiKey: 'test',
        apiKeyHash: null,
        status: 'active',
        configVersion: 0,
        secure: 1,
        engines: 'codex,claude,grok',
        internalRole: null,
        expiresAt: null,
        insecureEnabledUntil: null,
      },
    ],
    hostDaemons: [
      {
        hostId: 1,
        settings: daemonSettingsSchema.parse({ enabled: true, username: 'user' }),
        runtime: null,
        enabledAt: now,
        updatedAt: now,
      },
    ],
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
    ...extra,
  };
  const fake = createDbFake(
    new Map(
      Object.entries(seed).map(([name, values]) => [
        (schema as unknown as Record<string, unknown>)[name],
        structuredClone(values),
      ]),
    ),
  );
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  queues.push(deadlines);
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
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
  const runtime: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  bindOwnerRuntime(fake, runtime);
  const presence = new ConnectionPresence((e) => {
    throw e;
  });
  bindOwnerPresence(runtime, presence);
  const ctx = { db: fake, keyring: testKeyring(), env: loadTestEnv() } as unknown as RouteContext;
  const service = new HostDaemonService(ctx);
  return { state, runtime, presence, fake, ctx, service };
}

describe('connection-owned workflow state', () => {
  it.each(['codex', 'claude', 'grok'] as const)(
    'holds %s work across disconnect without renewal SQL or timeout takeover',
    async (engine) => {
      const id = randomUUID(),
        address = randomUUID(),
        instance = randomUUID();
      const h = harness({
        agentSessions: [
          {
            id,
            hostId: 1,
            username: 'user',
            engine,
            agentBusAddressId: address,
            bindingGeneration: 1,
            endedAt: null,
            adapterCapabilities: { workflow_protocol_version: 2 },
          },
        ],
        agentBusAddresses: [
          { id: address, currentSessionId: id, bindingGeneration: 1, enabled: 1, archivedAt: null },
        ],
        versions: [{ name: 'workflows_enabled', version: '1' }],
      });
      const attachment = () =>
        h.presence.attach({
          connectionId: 'fixture',
          hostId: 1,
          username: 'user',
          scope: { topic: 'session', session_id: id, binding_generation: 1, native_instance_id: instance },
        });
      let attached = attachment();
      const service = new WorkflowsService({
        db: h.ctx.db,
        settings: new SettingsService(h.ctx.db),
        keyring: h.ctx.keyring,
      });
      const actor = {
        kind: 'agent' as const,
        id: address,
        address_id: address,
        session_id: id,
        binding_generation: 1,
        host_id: 1,
        engine,
        protocol_version: 2,
      };
      const document = {
        schema_version: 1,
        title: 'Owner task',
        summary: '',
        goal: { statement: 'Finish', success_criteria: [{ id: 'done', text: 'Verified' }] },
        inputs: [],
        knowledge: [],
        tasks: [
          {
            id: 'one',
            title: 'One',
            instructions: 'Act',
            acceptance_criteria: ['Proof'],
            depends_on: [],
            knowledge_ids: [],
          },
        ],
      };
      const definition = await service.mutate(
        'create',
        { client_request_id: randomUUID(), slug: 'fixture-' + randomUUID(), document, reason: 'fixture' },
        { kind: 'admin', id: 'fixture' },
      );
      const created = await service.mutate(
        'run_create',
        { client_request_id: randomUUID(), workflow_id: definition.workflow_id, title: 'Run' },
        actor,
      );
      const runId = String(created.run_id);
      await mutateOwnerState(h.runtime, {
        kind: 'fixture.ready',
        payload: {},
        prepare(c) {
          stageUpdate(c, 'workflowRuns', runId, { status: 'running', preparation: null });
          return null;
        },
      });
      const acquired = await service.mutate(
        'task_claim',
        {
          client_request_id: randomUUID(),
          run_id: runId,
          task_id: 'one',
          expected_task_version: 1,
          action: 'acquire',
        },
        actor,
      );
      const token = String(acquired.claim_token),
        generation = Number(acquired.claim_generation),
        task = h.state.snapshot().table('workflowRunTasks').by('runId', runId)[0]!;
      expect(task.claimOwnershipMode).toBe('connection');
      expect(task.claimLeaseUntil).toBeNull();
      const renew = () =>
        service.mutate(
          'task_claim',
          {
            client_request_id: randomUUID(),
            run_id: runId,
            task_id: 'one',
            expected_task_version: task.version,
            action: 'renew',
            claim_token: token,
            claim_generation: generation,
          },
          actor,
        );
      const revision = h.state.revision().sequence,
        reads = vi.spyOn(h.fake, 'select');
      await renew();
      await renew();
      await service.get(String(definition.workflow_id));
      await service.versions(String(definition.workflow_id));
      await service.list();
      await service.runList();
      await service.runGet(runId);
      await service.runCurrent(actor);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      expect(h.state.revision().sequence).toBe(revision);
      attached.detach();
      await expect(renew()).rejects.toThrow('claim was lost');
      expect(h.state.snapshot().table('workflowRunTasks').get(task.id)?.claimOwnerAddressId).toBe(address);
      attached = attachment();
      await renew();
      expect(h.state.revision().sequence).toBe(revision);
      await service.mutate(
        'task_update',
        {
          client_request_id: randomUUID(),
          run_id: runId,
          task_id: 'one',
          expected_task_version: task.version,
          action: 'result',
          claim_token: token,
          claim_generation: generation,
          status: 'failed',
          summary: 'fixture result',
          execution_host: 'fixture',
        },
        actor,
      );
      expect(h.state.snapshot().table('workflowRunTasks').get(task.id)?.status).toBe('failed');
      expect(h.state.snapshot().table('workflowTaskAttempts').by('runId', runId)[0]?.status).toBe('failed');
    },
  );
});
