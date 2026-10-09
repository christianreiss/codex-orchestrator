import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adminSessions,
  adminUsers,
  chattyActions,
  chattyEvents,
  chattyRuns,
  chattySessions,
  versions,
} from '../../db/schema.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt, decrypt } from '../../security/secret-box.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../http/errors.js';
import { AdminEventsService } from '../admin-events.js';
import { roleHasCapability } from '../../security/capabilities.js';
import {
  ACTIVE_STATUSES,
  DEFAULT_SETTINGS,
  settingsSchema,
  signature,
  type ChattyActor,
  type ChattySelection,
  type EventKind,
  type RunStatus,
} from './contracts.js';

export type Run = typeof chattyRuns.$inferSelect;
export type Session = typeof chattySessions.$inferSelect;
export type Action = typeof chattyActions.$inferSelect;
export interface RunState {
  messages: Array<{ role: string; content: unknown }>;
  sources: string[];
  selection?: ChattySelection;
  tools?: string[];
  preferredEngine?: import('../../util/engine.js').Engine;
  toolCalls?: number;
  searchedSkills?: boolean;
  reads?: Record<string, { sha256: string; offset: number; complete: boolean }>;
}
export const now = () => new Date().toISOString();
export const later = (ms: number) => new Date(Date.now() + ms).toISOString();

export class ChattyStore {
  constructor(
    readonly db: Database,
    readonly keyring: Keyring,
  ) {}
  seal(value: unknown) {
    return encrypt(JSON.stringify(value), this.keyring);
  }
  open<T>(value: string): T {
    return JSON.parse(decrypt(value, this.keyring)) as T;
  }
  async settings() {
    const killed = (await this.db.select().from(versions).where(eq(versions.name, 'api_disabled')))[0];
    const row = (await this.db.select().from(versions).where(eq(versions.name, 'chatty_settings')))[0];
    if (killed?.version === '1') return { ...DEFAULT_SETTINGS, enabled: false };
    return row?.version ? settingsSchema.parse(JSON.parse(row.version)) : DEFAULT_SETTINGS;
  }
  async session(userId: number, db = this.db): Promise<Session> {
    await db
      .insert(chattySessions)
      .values({ userId, generation: 1, selection: { engine: null, model: null }, updatedAt: now() })
      .onDuplicateKeyUpdate({ set: { userId } });
    return (await db.select().from(chattySessions).where(eq(chattySessions.userId, userId)))[0]!;
  }
  async lockSession(userId: number, db: Database) {
    const row = (
      await db.select().from(chattySessions).where(eq(chattySessions.userId, userId)).for('update')
    )[0];
    if (!row) throw new NotFoundError('Chatty session not found');
    return row;
  }
  async authorize(actor: ChattyActor, db = this.db) {
    const row = (
      await db
        .select({ user: adminUsers })
        .from(adminSessions)
        .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
        .where(
          and(
            eq(adminSessions.id, actor.sessionId),
            eq(adminSessions.userId, actor.userId),
            gt(adminSessions.expiresAt, now()),
          ),
        )
    )[0];
    if (!row?.user.active || !roleHasCapability(row.user.accessLevel, 'chatty.use'))
      throw new ForbiddenError('Chatty access was revoked');
    return row.user;
  }
  async event(
    db: Database,
    session: Pick<Session, 'userId' | 'generation'>,
    runId: string | null,
    kind: EventKind,
    body: unknown,
  ) {
    await db.insert(chattyEvents).values({
      userId: session.userId,
      generation: session.generation,
      runId,
      kind,
      bodyEnc: this.seal(body),
      createdAt: now(),
    });
  }
  async events(userId: number, generation: number, after = 0, before?: number) {
    const rows = await this.db
      .select()
      .from(chattyEvents)
      .where(
        and(
          eq(chattyEvents.userId, userId),
          eq(chattyEvents.generation, generation),
          gt(chattyEvents.id, after),
          before === undefined ? undefined : lt(chattyEvents.id, before),
        ),
      )
      .orderBy(before === undefined && after > 0 ? asc(chattyEvents.id) : desc(chattyEvents.id))
      .limit(100);
    return rows
      .sort((a, b) => a.id - b.id)
      .map(({ bodyEnc, ...row }) => ({ ...row, body: this.open<Record<string, unknown>>(bodyEnc) }));
  }
  async active(userId: number) {
    const r = (
      await this.db
        .select()
        .from(chattyRuns)
        .where(and(eq(chattyRuns.userId, userId), inArray(chattyRuns.status, ACTIVE_STATUSES)))
        .limit(1)
    )[0];
    return r ? { id: r.id, status: r.status, generation: r.generation, steps: r.steps } : null;
  }
  async hasReceipt(userId: number, clientMessageId: string) {
    return (
      (
        await this.db
          .select({ id: chattyRuns.id })
          .from(chattyRuns)
          .where(and(eq(chattyRuns.userId, userId), eq(chattyRuns.clientMessageId, clientMessageId)))
          .limit(1)
      ).length > 0
    );
  }
  async submit(
    actor: ChattyActor,
    input: { client_message_id: string; generation: number; text: string; context?: unknown },
  ) {
    await this.session(actor.userId);
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const session = await this.lockSession(actor.userId, db);
      await this.authorize(actor, db);
      const hash = signature(input);
      const previous = (
        await db
          .select()
          .from(chattyRuns)
          .where(
            and(eq(chattyRuns.userId, actor.userId), eq(chattyRuns.clientMessageId, input.client_message_id)),
          )
      )[0];
      if (previous) {
        if (previous.requestHash !== hash || previous.generation !== session.generation)
          throw new ConflictError('Request ID belongs to a different request or cleared conversation');
        return { id: previous.id, status: previous.status };
      }
      if (session.generation !== input.generation)
        throw new ConflictError('Conversation was cleared; reload before sending');
      const active = await db
        .select({ id: chattyRuns.id })
        .from(chattyRuns)
        .where(and(eq(chattyRuns.userId, actor.userId), inArray(chattyRuns.status, ACTIVE_STATUSES)));
      if (active.length)
        throw new ConflictError('A Chatty request is already active; stop or answer it first');
      // The settings row is also the installation-wide scheduler mutex.
      await this.schedulerLock(db);
      const queued = await db
        .select({ id: chattyRuns.id })
        .from(chattyRuns)
        .where(eq(chattyRuns.status, 'queued'));
      if (queued.length >= (await this.settings()).queue_limit)
        throw new ConflictError('Chatty queue is full');
      const id = randomUUID();
      await db.insert(chattyRuns).values({
        id,
        userId: actor.userId,
        adminSessionId: actor.sessionId,
        generation: session.generation,
        clientMessageId: input.client_message_id,
        requestHash: hash,
        status: 'queued',
        inputEnc: this.seal(input),
        stateEnc: this.seal({ messages: [], sources: [], selection: session.selection } satisfies RunState),
        createdAt: now(),
        updatedAt: now(),
      });
      await this.event(db, session, id, 'user', { text: input.text, context: input.context ?? null });
      return { id, status: 'queued' };
    });
  }
  async schedulerLock(db: Database) {
    await db
      .insert(versions)
      .values({ name: 'chatty_scheduler', version: '1', updatedAt: now() })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    await db.select().from(versions).where(eq(versions.name, 'chatty_scheduler')).for('update');
  }
  async claim(): Promise<Run | null> {
    const settings = await this.settings();
    if (!settings.enabled) return null;
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      await this.schedulerLock(db);
      // A locking read sees a concurrent completion/clear before deciding expiry.
      // Otherwise a stale snapshot could overwrite its terminal receipt.
      const running = await db
        .select()
        .from(chattyRuns)
        .where(eq(chattyRuns.status, 'running'))
        .for('update');
      // Expired claims never replay effects. Reconciliation is explicit.
      for (const r of running.filter((r) => !r.leaseUntil || r.leaseUntil < now())) {
        await db
          .update(chattyRuns)
          .set({ status: 'unknown', claimId: null, updatedAt: now() })
          .where(eq(chattyRuns.id, r.id));
        await this.event(db, r, r.id, 'status', {
          status: 'unknown',
          text: 'Execution was interrupted. Completed receipts remain valid; inspect the target before retrying.',
        });
      }
      if (running.filter((r) => r.leaseUntil && r.leaseUntil >= now()).length >= settings.concurrency)
        return null;
      const r = (
        await db
          .select()
          .from(chattyRuns)
          .where(eq(chattyRuns.status, 'queued'))
          .orderBy(asc(chattyRuns.createdAt))
          .limit(1)
          .for('update')
      )[0];
      if (!r) return null;
      if (Date.parse(r.updatedAt) < Date.now() - 300000) {
        await db
          .update(chattyRuns)
          .set({ status: 'failed', updatedAt: now() })
          .where(eq(chattyRuns.id, r.id));
        await this.event(db, r, r.id, 'status', {
          status: 'failed',
          text: 'Queue timeout; send again when capacity is available.',
        });
        return null;
      }
      const claimId = randomUUID();
      await db
        .update(chattyRuns)
        .set({ status: 'running', claimId, leaseUntil: later(45000), updatedAt: now() })
        .where(eq(chattyRuns.id, r.id));
      return { ...r, status: 'running', claimId, leaseUntil: later(45000) };
    });
  }
  async current(run: Run, db = this.db) {
    await this.authorize({ userId: run.userId, sessionId: run.adminSessionId }, db);
    const s = (await db.select().from(chattySessions).where(eq(chattySessions.userId, run.userId)))[0];
    const query = db.select().from(chattyRuns).where(eq(chattyRuns.id, run.id));
    const r = (await (db === this.db ? query : query.for('update')))[0];
    if (
      !s ||
      s.generation !== run.generation ||
      r?.status !== 'running' ||
      r.claimId !== run.claimId ||
      !r.leaseUntil ||
      r.leaseUntil < now()
    )
      throw new ConflictError('Chatty request stopped or claim expired');
    return r;
  }
  async heartbeat(run: Run) {
    await this.current(run);
    await this.db
      .update(chattyRuns)
      .set({ leaseUntil: later(45000) })
      .where(
        and(
          eq(chattyRuns.id, run.id),
          eq(chattyRuns.claimId, run.claimId!),
          eq(chattyRuns.status, 'running'),
        ),
      );
  }
  async update(
    run: Run,
    state: RunState,
    status: RunStatus,
    elapsed: number,
    body?: { kind: EventKind; data: unknown },
  ) {
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      await this.lockSession(run.userId, db);
      const fresh = await this.current(run, db);
      await db
        .update(chattyRuns)
        .set({
          stateEnc: this.seal(state),
          status,
          steps: fresh.steps + 1,
          activeMs: fresh.activeMs + elapsed,
          updatedAt: now(),
          ...(status !== 'running' ? { claimId: null, leaseUntil: null } : {}),
        })
        .where(eq(chattyRuns.id, run.id));
      if (['succeeded', 'failed', 'cancelled'].includes(status))
        await new AdminEventsService(db).record(
          {
            type: 'chatty.run',
            payload: {
              user_id: run.userId,
              run_id: run.id,
              status,
              steps: fresh.steps + 1,
              active_ms: fresh.activeMs + elapsed,
              engine: state.preferredEngine ?? null,
            },
          },
          { broadcast: false },
        );
      if (body) await this.event(db, run, run.id, body.kind, body.data);
    });
  }
  async cancel(userId: number, id: string) {
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const session = await this.lockSession(userId, db);
      const r = (
        await db
          .select()
          .from(chattyRuns)
          .where(and(eq(chattyRuns.id, id), eq(chattyRuns.userId, userId)))
      )[0];
      if (!r) throw new NotFoundError('Request not found');
      if (!ACTIVE_STATUSES.includes(r.status)) return;
      await db
        .update(chattyRuns)
        .set({ status: 'cancelled', claimId: null, updatedAt: now() })
        .where(eq(chattyRuns.id, id));
      await db
        .update(chattyActions)
        .set({ status: 'cancelled', updatedAt: now() })
        .where(and(eq(chattyActions.runId, id), inArray(chattyActions.status, ['pending', 'approved'])));
      await this.event(db, session, id, 'status', {
        status: 'cancelled',
        text: 'Stopped. Previously completed changes remain in effect.',
      });
    });
  }
  async clear(userId: number) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const session = await this.lockSession(userId, db);
      await db
        .update(chattySessions)
        .set({ generation: session.generation + 1, summaryEnc: null, updatedAt: now() })
        .where(eq(chattySessions.userId, userId));
      // Retain request IDs and hashes as content-free retry tombstones.
      await db
        .update(chattyRuns)
        .set({
          status: 'cancelled',
          inputEnc: this.seal(null),
          stateEnc: this.seal(null),
          claimId: null,
          leaseUntil: null,
          updatedAt: now(),
        })
        .where(eq(chattyRuns.userId, userId));
      // Match the scheduler's run -> event lock order during expiry sweeps.
      await db.delete(chattyEvents).where(eq(chattyEvents.userId, userId));
      await db.delete(chattyActions).where(eq(chattyActions.userId, userId));
      return { generation: session.generation + 1 };
    });
  }
  async answer(actor: ChattyActor, id: string, text: string, generation: number) {
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const session = await this.lockSession(actor.userId, db);
      await this.authorize(actor, db);
      if (generation !== session.generation) throw new ConflictError('Conversation was cleared');
      const r = (
        await db
          .select()
          .from(chattyRuns)
          .where(and(eq(chattyRuns.id, id), eq(chattyRuns.userId, actor.userId)))
      )[0];
      if (!r || r.status !== 'waiting_input' || r.generation !== session.generation)
        throw new ConflictError('Question is no longer pending');
      const state = this.open<RunState>(r.stateEnc);
      state.messages.push({ role: 'user', content: text });
      await db
        .update(chattyRuns)
        .set({
          adminSessionId: actor.sessionId,
          stateEnc: this.seal(state),
          status: 'queued',
          updatedAt: now(),
        })
        .where(eq(chattyRuns.id, id));
      await this.event(db, session, id, 'user', { text });
    });
  }
}
