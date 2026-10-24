import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { chattyActions } from '../../db/schema.js';
import {
  mutateOwnerState,
  withOwnerActionIdentity,
  OwnerActionCompositionError,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { adminAudit } from '../../control-plane/state/admin.js';
import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import type { OwnedTableName } from '../../control-plane/state/catalog.js';
import { ConflictError, ForbiddenError } from '../../http/errors.js';
import { roleHasCapability } from '../../security/capabilities.js';
import { modelSafe, signature, type ChattyActor } from './contracts.js';
import { checkSnapshot, requireTool, type ChattyTool, type ToolContext } from './tools.js';
import type { ChattyStore, Run, RunState } from './store.js';

/** Explicit owned metadata proof for each supported administration target. */
export function ownerToolProjection(
  name: string,
  args: Record<string, unknown>,
  s: OwnerStateSnapshot,
): unknown {
  const selected: (readonly unknown[])[] = [];
  const add = (table: OwnedTableName, predicate: (row: Record<string, unknown>) => boolean = () => true) =>
    selected.push(
      s
        .table(table)
        .all()
        .filter((row) => predicate(row as unknown as Record<string, unknown>)),
    );
  if (name.startsWith('host_')) add('hosts', (r) => r.id === args.id);
  else if (name.startsWith('account_')) {
    add('providerAccounts', (r) => r.id === args.id);
    const a = s.table('providerAccounts').get(Number(args.id));
    add('authPayloads', (r) => r.id === a?.payloadId);
  } else if (name.startsWith('skill_')) {
    const skill = s
      .table('skills')
      .all()
      .find((r) => r.slug === args.slug);
    add('skills', (r) => r.slug === args.slug);
    add('skillFiles', (r) => r.skillId === skill?.id);
  } else if (name.startsWith('user_')) add('adminUsers', (r) => r.id === args.id);
  else if (name.startsWith('schedule_')) {
    add('agentSchedules', (r) => r.id === args.id);
    add('agentScheduleRuns', (r) => r.scheduleId === args.id);
  } else if (name === 'watchdog_disable') add('agentWatchdogs', (r) => r.id === args.id);
  else if (name.startsWith('gateway_key_'))
    add('openaiApiKeys', (r) => r.id === args.id && r.engine === args.surface);
  else if (name === 'engine_set') {
    add('versions', (r) => r.name === `${String(args.engine)}_engine_disabled`);
    add('hosts');
  } else if (name === 'config_store') add('clientConfigDocuments', (r) => r.engine === args.engine);
  else if (name === 'agents_store') add('agentsDocuments', (r) => r.engine === args.engine);
  else if (name.startsWith('shared_memory_')) add('sharedMemories', (r) => r.slug === args.slug);
  else if (name.startsWith('claude_artifact_'))
    add('claudeArtifacts', (r) => r.slug === args.slug && r.kind === args.kind);
  else if (name.startsWith('project_')) {
    const project = s
      .table('coordProjects')
      .all()
      .find((r) => r.slug === args.slug);
    add('coordProjects', (r) => r.slug === args.slug);
    if (name.startsWith('project_note_'))
      add('coordProjectNotes', (r) => r.projectId === project?.id && (args.id == null || r.id === args.id));
    if (name.startsWith('project_card_')) {
      add('coordProjectBoards', (r) => r.projectId === project?.id);
      add('coordProjectBoardColumns');
      add('coordProjectCards', (r) => r.projectId === project?.id);
    }
  } else
    throw new ConflictError(
      'This Chatty action requires explicit owner command composition before execution',
    );
  return selected;
}
function safe(value: unknown) {
  const result = modelSafe(value ?? null);
  const text = JSON.stringify(result);
  return text.length <= 16000 ? result : { truncated: true, excerpt: text.slice(0, 16000) };
}
interface Core {
  store: ChattyStore;
  tools: ChattyTool[];
  context(run: Run): ToolContext;
}
export class OwnedChattyActions {
  constructor(private readonly core: Core) {}
  private get store() {
    return this.core.store.owned!;
  }
  private check(run: Run, tool: ChattyTool, s: OwnerStateSnapshot) {
    this.store.current(run, s);
    const user = this.store.authorize({ userId: run.userId, sessionId: run.adminSessionId }, s);
    if (!roleHasCapability(user.accessLevel, tool.capability))
      throw new ForbiddenError('Required tool capability was revoked');
  }
  async prepare(run: Run, tool: ChattyTool, args: Record<string, unknown>, state: RunState, elapsed: number) {
    const owner = this.store.owner;
    this.check(run, tool, owner.state.snapshot());
    const proof = signature(ownerToolProjection(tool.name, args, owner.state.snapshot()));
    const before = await tool.snapshot!(this.core.context(run), args);
    await mutateOwnerState(owner, {
      kind: 'chatty.action.prepare',
      payload: { run: run.id, tool: tool.name },
      prepare: (c) => {
        this.check(run, tool, c.snapshot);
        if (signature(ownerToolProjection(tool.name, args, c.snapshot)) !== proof)
          throw new ConflictError('Target changed while preparing action');
        const fresh = this.store.current(run, c.snapshot),
          stamp = new Date().toISOString(),
          id = randomUUID(),
          expiresAt = new Date(Date.now() + 1800000).toISOString();
        const action = {
          id,
          runId: run.id,
          userId: run.userId,
          generation: run.generation,
          tool: tool.name,
          status: tool.confirm ? 'pending' : 'approved',
          payloadEnc: this.core.store.seal({ args, before, proof }),
          resultEnc: null,
          expiresAt,
          createdAt: stamp,
          updatedAt: stamp,
        };
        c.draft.upsert('chattyActions', action);
        c.write((tx) => tx.insert(chattyActions).values(action));
        stageUpdate(c, 'chattyRuns', run.id, {
          status: tool.confirm ? 'waiting_confirmation' : 'running',
          stateEnc: this.core.store.seal(state),
          steps: fresh.steps + 1,
          activeMs: fresh.activeMs + elapsed,
          updatedAt: stamp,
          ...(tool.confirm ? { claimId: null, leaseUntil: null } : {}),
        });
        this.store.event(c, run, run.id, 'action', {
          id,
          tool: tool.name,
          description: tool.description,
          arguments: modelSafe(args),
          before: safe(before),
          status: action.status,
          href: tool.href?.(args),
          expires_at: expiresAt,
        });
        return null;
      },
    });
  }
  async decide(actor: ChattyActor, id: string, approve: boolean, generation: number) {
    await mutateOwnerState(this.store.owner, {
      kind: 'chatty.action.decide',
      payload: { id, approve, generation },
      prepare: (c) => {
        this.store.authorize(actor, c.snapshot);
        const session = this.store.sessionRow(actor.userId, c.snapshot),
          action = c.snapshot.table('chattyActions').get(id);
        if (
          !action ||
          action.userId !== actor.userId ||
          action.generation !== generation ||
          session.generation !== generation ||
          action.status !== 'pending' ||
          Date.parse(action.expiresAt) <= Date.now()
        )
          throw new ConflictError('Decision expired or is no longer pending');
        if (c.snapshot.table('chattyRuns').get(action.runId)?.status !== 'waiting_confirmation')
          throw new ConflictError('Request is no longer awaiting confirmation');
        const stamp = new Date().toISOString();
        stageUpdate(c, 'chattyActions', id, { status: approve ? 'approved' : 'rejected', updatedAt: stamp });
        stageUpdate(c, 'chattyRuns', action.runId, {
          adminSessionId: actor.sessionId,
          status: approve ? 'queued' : 'cancelled',
          updatedAt: stamp,
        });
        this.store.event(c, session, action.runId, 'result', {
          id,
          tool: action.tool,
          status: approve ? 'approved' : 'rejected',
        });
        return null;
      },
    });
  }
  async fail(run: Run, id: string) {
    await mutateOwnerState(this.store.owner, {
      kind: 'chatty.action.fail',
      payload: { id },
      prepare: (c) => {
        const action = c.snapshot.table('chattyActions').get(id);
        if (!action || action.runId !== run.id || action.status !== 'approved') return null;
        this.store.current(run, c.snapshot);
        stageUpdate(c, 'chattyActions', id, { status: 'failed', updatedAt: new Date().toISOString() });
        this.store.event(c, run, run.id, 'result', {
          id,
          tool: action.tool,
          status: 'failed',
          text: 'No change was committed. Read the current target before retrying.',
        });
        return null;
      },
    }).catch(() => {});
  }
  async perform(run: Run, id: string, state: RunState) {
    const owner = this.store.owner;
    const action = owner.state.snapshot().table('chattyActions').get(id);
    if (!action || action.status !== 'approved') return;
    const tool = requireTool(this.core.tools, action.tool);
    this.check(run, tool, owner.state.snapshot());
    const [cold] = await this.core.store.db
      .select({ payload: chattyActions.payloadEnc })
      .from(chattyActions)
      .where(eq(chattyActions.id, id));
    if (!cold) throw new Error('Missing Chatty action payload');
    const { args, before, proof } = this.core.store.open<{
      args: Record<string, unknown>;
      before: unknown;
      proof: string;
    }>(cold.payload);
    const guard = (s: OwnerStateSnapshot) => {
      this.check(run, tool, s);
      if (signature(ownerToolProjection(tool.name, args, s)) !== proof)
        throw new ConflictError('Target changed since preparation');
    };
    guard(owner.state.snapshot());
    checkSnapshot(before, await tool.snapshot!(this.core.context(run), args));
    await mutateOwnerState(owner, {
      kind: 'chatty.action.begin',
      payload: { id },
      prepare: (c) => {
        guard(c.snapshot);
        const current = c.snapshot.table('chattyActions').get(id);
        if (current?.status !== 'approved' || Date.parse(current.expiresAt) <= Date.now())
          throw new ConflictError('Action is no longer approved');
        stageUpdate(c, 'chattyActions', id, { status: 'executing', updatedAt: new Date().toISOString() });
        return null;
      },
    });
    let receipt: unknown;
    const finalize = (c: OwnerMutationContext, result: unknown) => {
      receipt = { id, tool: tool.name, status: 'succeeded', result: safe(result), href: tool.href?.(args) };
      stageUpdate(c, 'chattyActions', id, {
        status: 'succeeded',
        resultEnc: this.core.store.seal(receipt),
        updatedAt: new Date().toISOString(),
      });
      stageUpdate(c, 'chattyRuns', run.id, {
        stateEnc: this.core.store.seal({
          ...state,
          messages: [...state.messages, { role: 'tool', content: receipt }],
        }),
        updatedAt: new Date().toISOString(),
      });
      this.store.event(c, run, run.id, 'result', receipt);
      adminAudit(c, 'chatty.action', {
        user_id: run.userId,
        run_id: run.id,
        operation_id: id,
        tool: tool.name,
        status: 'succeeded',
      });
    };
    try {
      const result = await withOwnerActionIdentity(
        {
          id,
          principal: { principal: `admin:${run.userId}`, revalidate: (s) => this.check(run, tool, s) },
          revalidateTarget: (s) => {
            guard(s);
            if (s.table('chattyActions').get(id)?.status !== 'executing')
              throw new ConflictError('Action is no longer executing');
          },
          afterPrepare: (c, read) => {
            c.write(async () => {
              finalize(c, read());
            });
          },
        },
        () => tool.run(this.core.context(run), args),
      );
      if (receipt === undefined) {
        // Audited no-op service paths may legitimately return without issuing a command.
        await mutateOwnerState(owner, {
          kind: 'chatty.action.noop',
          payload: { id },
          prepare: (c) => {
            guard(c.snapshot);
            if (c.snapshot.table('chattyActions').get(id)?.status === 'executing') finalize(c, result);
            return null;
          },
        });
      }
      if (receipt !== undefined) state.messages.push({ role: 'tool', content: receipt });
    } catch (error) {
      if (
        !(error instanceof OwnerActionCompositionError) &&
        owner.state.snapshot().table('chattyActions').get(id)?.status === 'succeeded'
      ) {
        if (receipt !== undefined) state.messages.push({ role: 'tool', content: receipt });
        return;
      }
      await mutateOwnerState(owner, {
        kind: 'chatty.action.uncertain',
        payload: { id },
        prepare: (c) => {
          if (
            c.snapshot.table('chattyActions').get(id)?.status === 'executing' ||
            error instanceof OwnerActionCompositionError
          ) {
            stageUpdate(c, 'chattyActions', id, { status: 'unknown', updatedAt: new Date().toISOString() });
            this.store.event(c, run, run.id, 'result', {
              id,
              tool: tool.name,
              status: 'unknown',
              text: 'The operation outcome is uncertain. Inspect the target before retrying.',
            });
          }
          return null;
        },
      });
      throw error;
    }
  }
}
