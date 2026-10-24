import { randomUUID } from 'node:crypto';
import { and, eq, notInArray } from 'drizzle-orm';
import { chattySessions, chattyRuns, chattyEvents, chattyActions } from '../../db/schema.js';
import {
  mutateOwnerState,
  requireOwnerRuntime,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import { stageUpdate, stageDelete } from '../../control-plane/state/rows.js';
import { adminAudit } from '../../control-plane/state/admin.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../http/errors.js';
import { roleHasCapability } from '../../security/capabilities.js';
import {
  ACTIVE_STATUSES,
  DEFAULT_SETTINGS,
  settingsSchema,
  signature,
  type ChattyActor,
  type EventKind,
  type RunStatus,
} from './contracts.js';
import type { ChattyStore, Run, RunState, Session } from './store.js';

const claims = new WeakMap<object, Set<string>>();
export class OwnedChattyStore {
  readonly owner;
  readonly claims: Set<string>;
  constructor(private readonly core: ChattyStore) {
    this.owner = requireOwnerRuntime(core.db);
    let current = claims.get(this.owner);
    if (!current) {
      current = new Set();
      claims.set(this.owner, current);
    }
    this.claims = current;
  }
  settings(snapshot = this.owner.state.snapshot()) {
    if (snapshot.setting('api_disabled') === '1') return { ...DEFAULT_SETTINGS, enabled: false };
    const raw = snapshot.setting('chatty_settings');
    return raw ? settingsSchema.parse(JSON.parse(raw)) : DEFAULT_SETTINGS;
  }
  authorize(actor: ChattyActor, snapshot = this.owner.state.snapshot()) {
    const session = snapshot.table('adminSessions').get(actor.sessionId),
      user = snapshot.table('adminUsers').get(actor.userId);
    if (
      !session ||
      session.userId !== actor.userId ||
      Date.parse(session.expiresAt) <= Date.now() ||
      !user?.active ||
      !roleHasCapability(user.accessLevel, 'chatty.use')
    )
      throw new ForbiddenError('Chatty access was revoked');
    return user;
  }
  sessionRow(userId: number, snapshot = this.owner.state.snapshot()): Session {
    const row = snapshot.table('chattySessions').get(userId);
    if (!row) throw new NotFoundError('Chatty session not found');
    return { ...row, summaryEnc: null };
  }
  async session(userId: number) {
    const row = this.owner.state.snapshot().table('chattySessions').get(userId);
    if (row) return { ...row, summaryEnc: null };
    await mutateOwnerState(this.owner, {
      kind: 'chatty.session',
      payload: { userId },
      prepare: (c) => {
        if (!c.snapshot.table('adminUsers').get(userId)?.active)
          throw new ForbiddenError('Chatty access was revoked');
        if (!c.draft.table('chattySessions').has(userId)) {
          const row = {
            userId,
            generation: 1,
            selection: { engine: null, model: null },
            seenAvailable: 0,
            summaryEnc: null,
            updatedAt: new Date().toISOString(),
          };
          c.draft.upsert('chattySessions', row);
          c.write((tx) => tx.insert(chattySessions).values(row));
        }
        return null;
      },
    });
    return this.sessionRow(userId);
  }
  event(
    c: OwnerMutationContext,
    session: Pick<Session, 'userId' | 'generation'>,
    runId: string | null,
    kind: EventKind,
    body: unknown,
  ) {
    c.write(async (tx) => {
      const [inserted] = await tx
        .insert(chattyEvents)
        .values({
          userId: session.userId,
          generation: session.generation,
          runId,
          kind,
          bodyEnc: this.core.seal(body),
          createdAt: new Date().toISOString(),
        });
      const row = c.draft.table('chattySessions').get(session.userId);
      if (row && row.generation === session.generation)
        c.draft.upsert('chattySessions', { ...row, eventCursor: Number(inserted.insertId) });
    });
  }
  current(run: Run, snapshot = this.owner.state.snapshot()): Run {
    this.owner.assertOwner();
    this.authorize({ userId: run.userId, sessionId: run.adminSessionId }, snapshot);
    const session = snapshot.table('chattySessions').get(run.userId),
      fresh = snapshot.table('chattyRuns').get(run.id);
    if (
      session?.generation !== run.generation ||
      fresh?.status !== 'running' ||
      fresh.claimId !== run.claimId ||
      !fresh.claimId ||
      !this.claims.has(fresh.claimId)
    )
      throw new ConflictError('Chatty request stopped or owner changed');
    return { ...run, ...fresh };
  }
  active(userId: number) {
    const r = this.owner.state
      .snapshot()
      .table('chattyRuns')
      .all()
      .find((r) => r.userId === userId && ACTIVE_STATUSES.includes(r.status));
    return r ? { id: r.id, status: r.status, generation: r.generation, steps: r.steps } : null;
  }
  async submit(
    actor: ChattyActor,
    input: { client_message_id: string; generation: number; text: string; context?: unknown },
  ) {
    await this.session(actor.userId);
    let result: { id: string; status: string } | undefined;
    await mutateOwnerState(this.owner, {
      kind: 'chatty.submit',
      payload: { userId: actor.userId, request: input.client_message_id, hash: signature(input) },
      prepare: async (c) => {
        this.authorize(actor, c.snapshot);
        const session = this.sessionRow(actor.userId, c.snapshot),
          hash = signature(input);
        const previous =
          c.snapshot
            .table('chattyRuns')
            .all()
            .find((r) => r.userId === actor.userId && r.clientMessageId === input.client_message_id) ??
          (
            await this.core.db
              .select()
              .from(chattyRuns)
              .where(
                and(
                  eq(chattyRuns.userId, actor.userId),
                  eq(chattyRuns.clientMessageId, input.client_message_id),
                ),
              )
              .limit(1)
          )[0];
        if (previous) {
          if (previous.requestHash !== hash || previous.generation !== session.generation)
            throw new ConflictError('Request ID belongs to a different request or cleared conversation');
          result = { id: previous.id, status: previous.status };
          return null;
        }
        if (session.generation !== input.generation)
          throw new ConflictError('Conversation was cleared; reload before sending');
        const runs = c.snapshot.table('chattyRuns').all();
        if (runs.some((r) => r.userId === actor.userId && ACTIVE_STATUSES.includes(r.status)))
          throw new ConflictError('A Chatty request is already active; stop or answer it first');
        if (runs.filter((r) => r.status === 'queued').length >= this.settings(c.snapshot).queue_limit)
          throw new ConflictError('Chatty queue is full');
        const now = new Date().toISOString(),
          id = randomUUID();
        const row = {
          id,
          userId: actor.userId,
          adminSessionId: actor.sessionId,
          generation: session.generation,
          clientMessageId: input.client_message_id,
          requestHash: hash,
          status: 'queued',
          inputEnc: this.core.seal(input),
          stateEnc: this.core.seal({ messages: [], sources: [], selection: session.selection }),
          claimId: null,
          leaseUntil: null,
          steps: 0,
          activeMs: 0,
          createdAt: now,
          updatedAt: now,
        };
        c.draft.upsert('chattyRuns', row);
        c.write((tx) => tx.insert(chattyRuns).values(row));
        this.event(c, session, id, 'user', { text: input.text, context: input.context ?? null });
        result = { id, status: 'queued' };
        return null;
      },
    });
    return result!;
  }
  async claim(): Promise<Run | null> {
    if (!this.settings().enabled) return null;
    const snapshot = this.owner.state.snapshot(),
      runs = snapshot.table('chattyRuns').all();
    if (
      !runs.some(
        (r) =>
          r.status === 'queued' || (r.status === 'running' && (!r.claimId || !this.claims.has(r.claimId))),
      )
    )
      return null;
    let result: Run | null = null;
    await mutateOwnerState(this.owner, {
      kind: 'chatty.claim',
      payload: {},
      prepare: async (c) => {
        const now = new Date().toISOString();
        for (const r of c.snapshot.table('chattyRuns').all())
          if (r.status === 'running' && (!r.claimId || !this.claims.has(r.claimId))) {
            stageUpdate(c, 'chattyRuns', r.id, {
              status: 'unknown',
              claimId: null,
              leaseUntil: null,
              updatedAt: now,
            });
            this.event(c, r, r.id, 'status', {
              status: 'unknown',
              text: 'Execution was interrupted. Completed receipts remain valid; inspect the target before retrying.',
            });
          }
        for (const r of c.draft.table('chattyRuns').all())
          if (r.status === 'queued' && Date.parse(r.updatedAt) <= Date.now() - 300000) {
            stageUpdate(c, 'chattyRuns', r.id, { status: 'failed', updatedAt: now });
            this.event(c, r, r.id, 'status', {
              status: 'failed',
              text: 'Queue timeout; send again when capacity is available.',
            });
          }
        if (
          c.draft
            .table('chattyRuns')
            .all()
            .filter((r) => r.status === 'running').length >= this.settings(c.snapshot).concurrency
        )
          return null;
        const row = [...c.draft.table('chattyRuns').all()]
          .filter((r) => r.status === 'queued')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
        if (!row) return null;
        if (Date.parse(row.updatedAt) <= Date.now() - 300000) {
          stageUpdate(c, 'chattyRuns', row.id, { status: 'failed', updatedAt: now });
          this.event(c, row, row.id, 'status', {
            status: 'failed',
            text: 'Queue timeout; send again when capacity is available.',
          });
          return null;
        }
        const [cold] = await this.core.db.select().from(chattyRuns).where(eq(chattyRuns.id, row.id));
        if (!cold) throw new Error('Missing Chatty run content');
        const claimId = randomUUID();
        stageUpdate(c, 'chattyRuns', row.id, {
          status: 'running',
          claimId,
          leaseUntil: null,
          updatedAt: now,
        });
        result = { ...cold, ...row, status: 'running', claimId, leaseUntil: null };
        c.write(async () => {
          this.claims.add(claimId);
        });
        return null;
      },
    });
    if (result) this.claims.add((result as Run).claimId!);
    return result;
  }
  async update(
    run: Run,
    state: RunState,
    status: RunStatus,
    elapsed: number,
    body?: { kind: EventKind; data: unknown },
  ) {
    await mutateOwnerState(this.owner, {
      kind: 'chatty.update',
      payload: { id: run.id, status },
      prepare: (c) => {
        const fresh = this.current(run, c.snapshot);
        stageUpdate(c, 'chattyRuns', run.id, {
          stateEnc: this.core.seal(state),
          status,
          steps: fresh.steps + 1,
          activeMs: fresh.activeMs + elapsed,
          updatedAt: new Date().toISOString(),
          ...(status !== 'running' ? { claimId: null, leaseUntil: null } : {}),
        });
        if (body) this.event(c, run, run.id, body.kind, body.data);
        if (['succeeded', 'failed', 'cancelled'].includes(status))
          adminAudit(c, 'chatty.run', {
            user_id: run.userId,
            run_id: run.id,
            status,
            steps: fresh.steps + 1,
            active_ms: fresh.activeMs + elapsed,
            engine: state.preferredEngine ?? null,
          });
        return null;
      },
    });
    if (status !== 'running' && run.claimId) this.claims.delete(run.claimId);
  }
  async cancel(userId: number, id: string) {
    await mutateOwnerState(this.owner, {
      kind: 'chatty.cancel',
      payload: { userId, id },
      prepare: (c) => {
        const session = this.sessionRow(userId, c.snapshot),
          r = c.snapshot.table('chattyRuns').get(id);
        if (!r || r.userId !== userId) throw new NotFoundError('Request not found');
        if (!ACTIVE_STATUSES.includes(r.status)) return null;
        stageUpdate(c, 'chattyRuns', id, {
          status: 'cancelled',
          claimId: null,
          leaseUntil: null,
          updatedAt: new Date().toISOString(),
        });
        for (const a of c.snapshot.table('chattyActions').all())
          if (a.runId === id && ['pending', 'approved'].includes(a.status))
            stageUpdate(c, 'chattyActions', a.id, {
              status: 'cancelled',
              updatedAt: new Date().toISOString(),
            });
        this.event(c, session, id, 'status', {
          status: 'cancelled',
          text: 'Stopped. Previously completed changes remain in effect.',
        });
        return null;
      },
    });
  }
  async clear(userId: number) {
    let generation = 0;
    await mutateOwnerState(this.owner, {
      kind: 'chatty.clear',
      payload: { userId },
      prepare: (c) => {
        const session = this.sessionRow(userId, c.snapshot);
        generation = session.generation + 1;
        stageUpdate(c, 'chattySessions', userId, {
          generation,
          summaryEnc: null,
          updatedAt: new Date().toISOString(),
        });
        c.draft.upsert('chattySessions', { ...c.draft.table('chattySessions').get(userId)!, eventCursor: 0 });
        for (const r of c.snapshot.table('chattyRuns').all())
          if (r.userId === userId)
            stageUpdate(c, 'chattyRuns', r.id, {
              status: r.status === 'unknown' ? 'unknown' : 'cancelled',
              inputEnc: this.core.seal(null),
              stateEnc: this.core.seal(null),
              claimId: null,
              leaseUntil: null,
              updatedAt: new Date().toISOString(),
            });
        for (const a of c.snapshot.table('chattyActions').all())
          if (a.userId === userId && !['executing', 'unknown'].includes(a.status))
            stageDelete(c, 'chattyActions', a.id);
        c.write((tx) => tx.delete(chattyEvents).where(eq(chattyEvents.userId, userId)));
        c.write((tx) =>
          tx
            .delete(chattyActions)
            .where(
              and(
                eq(chattyActions.userId, userId),
                notInArray(chattyActions.status, ['executing', 'unknown']),
              ),
            ),
        );
        return null;
      },
    });
    return { generation };
  }
  async answer(actor: ChattyActor, id: string, text: string, generation: number) {
    await mutateOwnerState(this.owner, {
      kind: 'chatty.answer',
      payload: { userId: actor.userId, id, generation },
      prepare: async (c) => {
        this.authorize(actor, c.snapshot);
        const session = this.sessionRow(actor.userId, c.snapshot),
          r = c.snapshot.table('chattyRuns').get(id);
        if (
          session.generation !== generation ||
          !r ||
          r.userId !== actor.userId ||
          r.status !== 'waiting_input' ||
          r.generation !== generation
        )
          throw new ConflictError('Question is no longer pending');
        const [cold] = await this.core.db
          .select({ state: chattyRuns.stateEnc })
          .from(chattyRuns)
          .where(eq(chattyRuns.id, id));
        if (!cold) throw new Error('Missing Chatty question content');
        const state = this.core.open<RunState>(cold.state);
        state.messages.push({ role: 'user', content: text });
        stageUpdate(c, 'chattyRuns', id, {
          adminSessionId: actor.sessionId,
          stateEnc: this.core.seal(state),
          status: 'queued',
          updatedAt: new Date().toISOString(),
        });
        this.event(c, session, id, 'user', { text });
        return null;
      },
    });
  }
}
