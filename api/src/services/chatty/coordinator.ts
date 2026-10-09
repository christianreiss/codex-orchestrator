import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import type { Database } from '../../db/client.js';
import { chattyActions, chattyRuns, chattySessions } from '../../db/schema.js';
import { ApiError, ConflictError, ForbiddenError, NotFoundError } from '../../http/errors.js';
import { roleHasCapability } from '../../security/capabilities.js';
import { AdminEventsService } from '../admin-events.js';
import { ChattyStore, later, now, type Run, type RunState } from './store.js';
import { ChattyInference } from './inference.js';
import {
  administrationTools,
  requireTool,
  checkSnapshot,
  type ChattyTool,
  type ToolContext,
} from './tools.js';
import { loadKnowledge, searchKnowledge, sourceView, type KnowledgeBundle } from './knowledge.js';
import {
  SYSTEM_PROMPT,
  modelSafe,
  type ChattyActor,
  type ChattyContext,
  type ChattySelection,
} from './contracts.js';

const DISCOVERY = [
  {
    name: 'tool_search',
    description: 'Discover available administration tools by words; empty query lists all.',
    parameters: { query: 'string' },
  },
  {
    name: 'tool_describe',
    description: 'Read the exact JSON argument schema of one tool.',
    parameters: { name: 'string' },
  },
  {
    name: 'knowledge_search',
    description: 'Find current product documentation.',
    parameters: { query: 'string' },
  },
  {
    name: 'knowledge_read',
    description: 'Read a documentation source by its returned ID.',
    parameters: { id: 'string' },
  },
  {
    name: 'history_search',
    description: 'Search earlier parts of this personal conversation.',
    parameters: {
      query: 'string',
      before: 'optional positive integer, continue paging while has_older is true',
    },
  },
];

function bounded(value: unknown, limit = 16000) {
  const text = JSON.stringify(modelSafe(value ?? null));
  return text.length <= limit
    ? modelSafe(value)
    : {
        truncated: true,
        excerpt: text.slice(0, limit),
        instruction: 'Request a narrower read. This is not a complete document.',
      };
}
export class ChattyCoordinator {
  readonly store: ChattyStore;
  readonly inference: ChattyInference;
  readonly tools: ChattyTool[];
  readonly knowledge: KnowledgeBundle;
  private active = new Map<string, AbortController>();
  private tickRunning = false;
  constructor(
    readonly ctx: RouteContext,
    options: { inference?: ChattyInference; tools?: ChattyTool[]; knowledge?: KnowledgeBundle } = {},
  ) {
    this.store = new ChattyStore(ctx.db, ctx.keyring);
    this.inference = options.inference ?? new ChattyInference(ctx);
    this.tools = options.tools ?? administrationTools();
    this.knowledge = options.knowledge ?? loadKnowledge();
  }
  stop(id?: string) {
    for (const [key, signal] of this.active) if (!id || key === id) signal.abort();
  }
  async status(userId: number) {
    const session = await this.store.session(userId);
    const settings = await this.store.settings();
    const engines = await this.inference.availability(settings);
    const ready = engines.some((e) => e.ready);
    if (ready && !session.seenAvailable)
      await this.ctx.db
        .update(chattySessions)
        .set({ seenAvailable: 1 })
        .where(eq(chattySessions.userId, userId));
    return {
      visible: !!session.seenAvailable || ready,
      ready,
      enabled: settings.enabled,
      engines,
      knowledge_version: this.knowledge.version,
    };
  }
  async snapshot(userId: number, before?: number) {
    const session = await this.store.session(userId);
    const events = await this.store.events(userId, session.generation, 0, before);
    return {
      generation: session.generation,
      selection: session.selection,
      events,
      active: await this.store.active(userId),
      has_older: events.length === 100,
    };
  }
  async choose(userId: number, selection: ChattySelection) {
    if (selection.engine) {
      const engine = (await this.inference.availability(await this.store.settings())).find(
        (e) => e.engine === selection.engine,
      );
      if (selection.model && !engine?.models.some((m) => m.id === selection.model))
        throw new ConflictError('Model is not available');
    } else if (selection.model) throw new ConflictError('An explicit model requires an engine');
    await this.store.session(userId);
    await this.ctx.db
      .update(chattySessions)
      .set({ selection, updatedAt: now() })
      .where(eq(chattySessions.userId, userId));
  }
  async tick() {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      const run = await this.store.claim();
      if (run) {
        const controller = new AbortController();
        this.active.set(run.id, controller);
        void this.execute(run, controller)
          .finally(() => this.active.delete(run.id))
          .catch(() => {});
      }
      // Expire prepared decisions instead of letting them block a conversation forever.
      const waiting = await this.ctx.db
        .select()
        .from(chattyRuns)
        .where(inArray(chattyRuns.status, ['waiting_input', 'waiting_confirmation']));
      for (const r of waiting)
        if (Date.parse(r.updatedAt) < Date.now() - 1800000) await this.store.cancel(r.userId, r.id);
    } finally {
      this.tickRunning = false;
    }
  }
  private toolContext(run: Run, db = this.ctx.db): ToolContext {
    return { ...this.ctx, db, actor: { userId: run.userId, sessionId: run.adminSessionId } };
  }
  private async authorizedTool(run: Run, tool: ChattyTool, db = this.ctx.db) {
    const user = await this.store.authorize({ userId: run.userId, sessionId: run.adminSessionId }, db);
    if (!roleHasCapability(user.accessLevel, tool.capability))
      throw new ForbiddenError('Required tool capability was revoked');
  }
  private async initialize(run: Run, state: RunState) {
    if (state.messages.length) return;
    const input = this.store.open<{ text: string; context?: ChattyContext }>(run.inputEnc);
    const past = (await this.store.events(run.userId, run.generation)).filter((e) => e.runId !== run.id);
    const older = past
      .slice(0, -12)
      .map((e) => ({ role: e.kind, excerpt: JSON.stringify(e.body).slice(0, 240) }));
    state.messages = [
      { role: 'history_summary', content: older },
      ...past.slice(-12).map((e) => ({ role: e.kind, content: bounded(e.body, 2000) })),
      { role: 'user', content: input.text },
    ];
    const sources = searchKnowledge(this.knowledge, input.text);
    state.sources = sources.map((s) => s.id);
    state.messages.push({ role: 'documentation', content: sources.map(sourceView) });
    if (input.context?.kind && input.context.id) {
      const names = {
        host: 'host_read',
        project: 'project_read',
        skill: 'skill_read',
        account: 'accounts_list',
      };
      const tool = requireTool(this.tools, names[input.context.kind]);
      const args =
        input.context.kind === 'account'
          ? {}
          : ['project', 'skill'].includes(input.context.kind)
            ? { slug: input.context.id }
            : { id: Number(input.context.id) };
      await this.authorizedTool(run, tool);
      state.messages.push({
        role: 'page_context',
        content: {
          context: input.context,
          snapshot: bounded(await tool.run(this.toolContext(run), tool.parse(args))),
        },
      });
    }
  }
  private prompt(state: RunState) {
    const descriptions = (state.tools ?? []).slice(-8).map((name) => {
      const t = requireTool(this.tools, name);
      return { name: t.name, description: t.description, parameters: t.parameters };
    });
    const messages = [...state.messages];
    const prefix = `${SYSTEM_PROMPT}\nDiscovery tools: ${JSON.stringify(DISCOVERY)}\nLoaded administration tools: ${JSON.stringify(descriptions)}\nConversation data:\n`;
    // Keep the current human request and latest results. Older context remains searchable.
    while (JSON.stringify(messages).length + prefix.length > 48000 && messages.length > 2) {
      const index = messages.findIndex((m, i) => i < messages.length - 2 && m.role !== 'user');
      messages.splice(index >= 0 ? index : 0, 1);
    }
    if (JSON.stringify(messages).length + prefix.length > 60000)
      throw new Error('Context exceeds the model input limit; shorten the request');
    return prefix + JSON.stringify(messages);
  }
  private async discovery(
    run: Run,
    state: RunState,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const query = typeof args.query === 'string' ? args.query.slice(0, 200) : '';
    if (name === 'tool_search') {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return this.tools
        .filter(
          (t) =>
            !terms.length || terms.some((word) => `${t.name} ${t.description}`.toLowerCase().includes(word)),
        )
        .map((t) => ({ name: t.name, description: t.description, confirmation: t.confirm }));
    }
    if (name === 'tool_describe') {
      const t = requireTool(this.tools, String(args.name));
      state.tools = [...new Set([...(state.tools ?? []), t.name])];
      return { name: t.name, description: t.description, parameters: t.parameters };
    }
    if (name === 'knowledge_search') {
      const sources = searchKnowledge(this.knowledge, query);
      state.sources = [...new Set([...state.sources, ...sources.map((s) => s.id)])];
      return sources.map(sourceView);
    }
    if (name === 'knowledge_read') {
      const source = this.knowledge.sources.find((s) => s.id === args.id);
      if (!source) throw new NotFoundError('Source not found');
      state.sources = [...new Set([...state.sources, source.id])];
      return sourceView(source);
    }
    const events = await this.store.events(
      run.userId,
      run.generation,
      0,
      typeof args.before === 'number' ? args.before : undefined,
    );
    return {
      events: events
        .filter((e) => JSON.stringify(e.body).toLowerCase().includes(query.toLowerCase()))
        .slice(-20),
      before: events[0]?.id ?? null,
      has_older: events.length === 100,
    };
  }
  private trackRead(state: RunState, name: string, args: Record<string, unknown>, result: unknown) {
    if (name === 'skills_search') state.searchedSkills = true;
    if (!['skill_read', 'shared_memory_read'].includes(name) || !result || typeof result !== 'object') return;
    const value = result as Record<string, unknown>;
    const hash =
      name === 'skill_read' ? value.sha256 : (value.memory as Record<string, unknown> | undefined)?.sha256;
    if (typeof hash !== 'string' || typeof value.offset !== 'number') return;
    const key = `${name}:${String(args.slug)}`;
    const previous = state.reads?.[key];
    const contiguous = value.offset === 0 || (previous?.sha256 === hash && previous.offset === value.offset);
    state.reads ??= {};
    state.reads[key] = {
      sha256: hash,
      offset: Number(value.next_offset ?? value.offset),
      complete: contiguous && value.truncated === false,
    };
    // A noncontiguous read cannot later masquerade as a complete document.
    if (!contiguous) delete state.reads[key];
  }
  private checkRead(state: RunState, name: string, args: Record<string, unknown>) {
    if (
      name === 'skill_store' &&
      (!state.searchedSkills || !state.reads?.['skill_read:skill-manager']?.complete)
    )
      throw new ConflictError(
        'Before authoring, search existing skills and read every window of skill-manager.',
      );
    if ((name === 'skill_store' || name === 'shared_memory_store') && args.expected_sha256) {
      const key = `${name === 'skill_store' ? 'skill_read' : 'shared_memory_read'}:${String(args.slug)}`;
      const read = state.reads?.[key];
      if (!read?.complete || read.sha256 !== args.expected_sha256)
        throw new ConflictError(
          'Read the complete current document, starting at offset 0, before replacing it.',
        );
    }
  }
  private async execute(run: Run, controller: AbortController) {
    const signal = controller.signal;
    const heartbeat = setInterval(() => {
      void Promise.all([this.store.heartbeat(run), this.store.settings()])
        .then(([, settings]) => {
          if (!settings.enabled) controller.abort();
        })
        .catch(() => controller.abort());
    }, 5000);
    heartbeat.unref();
    const deadline = setTimeout(() => controller.abort(), Math.max(1, 600000 - run.activeMs));
    const state = this.store.open<RunState>(run.stateEnc);
    try {
      await this.store.current(run);
      await this.initialize(run, state);
      while (!signal.aborted) {
        const fresh = await this.store.current(run);
        const settings = await this.store.settings();
        if (!settings.enabled) throw new Error('Chatty has been disabled');
        if (fresh.steps >= settings.steps || fresh.activeMs >= 600000)
          throw new Error(
            'Request limit reached. Completed receipts remain valid; continue with a new request.',
          );
        const approved = (
          await this.ctx.db
            .select()
            .from(chattyActions)
            .where(and(eq(chattyActions.runId, run.id), eq(chattyActions.status, 'approved')))
            .limit(1)
        )[0];
        if (approved) {
          try {
            await this.perform(run, approved.id, state);
          } catch (error) {
            await this.failAction(run, approved.id);
            throw error;
          }
          continue;
        }
        const start = Date.now();
        const result = await this.inference.run(
          this.prompt(state),
          state.selection ?? { engine: null, model: null },
          settings,
          signal,
          state.preferredEngine,
        );
        state.preferredEngine = result.engine;
        await this.store.current(run);
        state.messages.push({ role: 'assistant', content: result.response });
        const model = { engine: result.engine, model: result.model, fallback: result.fallback };
        const response = result.response;
        if (response.kind === 'answer') {
          const sources = response.sources
            .filter((id) => state.sources.includes(id))
            .map((id) => this.knowledge.sources.find((s) => s.id === id))
            .filter((s) => s !== undefined)
            .map(sourceView);
          await this.store.update(run, state, 'succeeded', Date.now() - start, {
            kind: 'answer',
            data: { text: response.text, sources, ...model },
          });
          return;
        }
        if (response.kind === 'question') {
          await this.store.update(run, state, 'waiting_input', Date.now() - start, {
            kind: 'question',
            data: { ...response, ...model },
          });
          return;
        }
        try {
          state.toolCalls = (state.toolCalls ?? 0) + 1;
          if (state.toolCalls > 24) throw new ConflictError('Tool limit reached');
          if (DISCOVERY.some((t) => t.name === response.name)) {
            const output = await this.discovery(run, state, response.name, response.arguments);
            state.messages.push({ role: 'tool', content: { name: response.name, result: bounded(output) } });
            await this.store.update(run, state, 'running', Date.now() - start, {
              kind: 'status',
              data: { text: response.name, ...model },
            });
          } else {
            const tool = requireTool(this.tools, response.name);
            await this.authorizedTool(run, tool);
            const args = tool.parse(response.arguments);
            if (!tool.write) {
              const output = bounded(await tool.run(this.toolContext(run), args));
              this.trackRead(state, tool.name, args, output);
              state.messages.push({ role: 'tool', content: { name: tool.name, result: output } });
              await this.store.update(run, state, 'running', Date.now() - start, {
                kind: 'status',
                data: { text: tool.description, ...model },
              });
            } else {
              this.checkRead(state, tool.name, args);
              await this.prepare(run, tool, args, state, Date.now() - start);
              if (tool.confirm) return;
            }
          }
        } catch (error) {
          await this.store.current(run);
          const message =
            error instanceof ApiError || (error instanceof Error && error.name === 'ZodError')
              ? error.message
              : 'Tool failed; no successful receipt was recorded.';
          state.messages.push({ role: 'tool', content: { error: message } });
          await this.store.update(run, state, 'running', Date.now() - start, {
            kind: 'status',
            data: { text: message, error: true },
          });
        }
      }
    } catch (error) {
      try {
        await this.store.update(run, state, signal.aborted ? 'cancelled' : 'failed', 0, {
          kind: 'status',
          data: {
            status: signal.aborted ? 'cancelled' : 'failed',
            text: signal.aborted
              ? 'Stopped.'
              : error instanceof ApiError
                ? error.message
                : 'Chatty request failed. Check availability and retry after inspecting completed receipts.',
          },
        });
      } catch {
        /* a clear, revocation or newer claim owns the state */
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  }
  private async prepare(
    run: Run,
    tool: ChattyTool,
    args: Record<string, unknown>,
    state: RunState,
    elapsed: number,
  ) {
    await this.ctx.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      await this.store.lockSession(run.userId, db);
      const fresh = await this.store.current(run, db);
      const before = await tool.snapshot!(this.toolContext(run, db), args);
      const id = randomUUID();
      await db.insert(chattyActions).values({
        id,
        runId: run.id,
        userId: run.userId,
        generation: run.generation,
        tool: tool.name,
        status: tool.confirm ? 'pending' : 'approved',
        payloadEnc: this.store.seal({ args, before }),
        expiresAt: later(1800000),
        createdAt: now(),
        updatedAt: now(),
      });
      await db
        .update(chattyRuns)
        .set({
          status: tool.confirm ? 'waiting_confirmation' : 'running',
          stateEnc: this.store.seal(state),
          steps: fresh.steps + 1,
          activeMs: fresh.activeMs + elapsed,
          updatedAt: now(),
          ...(tool.confirm ? { claimId: null, leaseUntil: null } : {}),
        })
        .where(eq(chattyRuns.id, run.id));
      await this.store.event(db, run, run.id, 'action', {
        id,
        tool: tool.name,
        description: tool.description,
        arguments: modelSafe(args),
        before: bounded(before, 4000),
        status: tool.confirm ? 'pending' : 'approved',
        href: tool.href?.(args),
        expires_at: later(1800000),
      });
    });
  }
  async decide(actor: ChattyActor, id: string, approve: boolean, generation: number) {
    return this.ctx.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const session = await this.store.lockSession(actor.userId, db);
      await this.store.authorize(actor, db);
      const action = (
        await db
          .select()
          .from(chattyActions)
          .where(and(eq(chattyActions.id, id), eq(chattyActions.userId, actor.userId)))
      )[0];
      if (
        !action ||
        action.generation !== generation ||
        session.generation !== generation ||
        action.status !== 'pending' ||
        action.expiresAt < now()
      )
        throw new ConflictError('Decision expired or is no longer pending');
      const run = (await db.select().from(chattyRuns).where(eq(chattyRuns.id, action.runId)))[0];
      if (!run || run.status !== 'waiting_confirmation')
        throw new ConflictError('Request is no longer awaiting confirmation');
      await db
        .update(chattyActions)
        .set({ status: approve ? 'approved' : 'rejected', updatedAt: now() })
        .where(eq(chattyActions.id, id));
      await db
        .update(chattyRuns)
        .set({ adminSessionId: actor.sessionId, status: approve ? 'queued' : 'cancelled', updatedAt: now() })
        .where(eq(chattyRuns.id, run.id));
      await this.store.event(db, session, run.id, 'result', {
        id,
        tool: action.tool,
        status: approve ? 'approved' : 'rejected',
      });
    });
  }
  private async failAction(run: Run, id: string) {
    await this.ctx.db
      .transaction(async (tx) => {
        const db = tx as unknown as Database;
        await this.store.lockSession(run.userId, db);
        await this.store.current(run, db);
        const action = (
          await db.select().from(chattyActions).where(eq(chattyActions.id, id)).for('update')
        )[0];
        if (!action || action.status !== 'approved') return;
        await db
          .update(chattyActions)
          .set({ status: 'failed', updatedAt: now() })
          .where(eq(chattyActions.id, id));
        await this.store.event(db, run, run.id, 'result', {
          id,
          tool: action.tool,
          status: 'failed',
          text: 'No change was committed. Read the current target before retrying.',
        });
      })
      .catch(() => {});
  }
  private async perform(run: Run, actionId: string, state: RunState) {
    await this.ctx.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      await this.store.lockSession(run.userId, db);
      await this.store.current(run, db);
      const action = (
        await db.select().from(chattyActions).where(eq(chattyActions.id, actionId)).for('update')
      )[0];
      if (!action || action.status !== 'approved') return;
      const tool = requireTool(this.tools, action.tool);
      await this.authorizedTool(run, tool, db);
      const { args, before } = this.store.open<{ args: Record<string, unknown>; before: unknown }>(
        action.payloadEnc,
      );
      checkSnapshot(before, await tool.snapshot!(this.toolContext(run, db), args));
      const result = bounded(await tool.run(this.toolContext(run, db), args));
      const receipt = {
        id: action.id,
        tool: tool.name,
        status: 'succeeded',
        result,
        href: tool.href?.(args),
      };
      await db
        .update(chattyActions)
        .set({ status: 'succeeded', resultEnc: this.store.seal(result), updatedAt: now() })
        .where(eq(chattyActions.id, action.id));
      state.messages.push({ role: 'tool', content: receipt });
      await db
        .update(chattyRuns)
        .set({ stateEnc: this.store.seal(state), updatedAt: now() })
        .where(eq(chattyRuns.id, run.id));
      await this.store.event(db, run, run.id, 'result', receipt);
      await new AdminEventsService(db).record(
        {
          type: 'chatty.action',
          payload: {
            user_id: run.userId,
            run_id: run.id,
            operation_id: action.id,
            tool: tool.name,
            status: 'succeeded',
          },
        },
        { broadcast: false },
      );
    });
  }
}
