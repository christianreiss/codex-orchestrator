import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { AgentReceiverService } from '../../../src/services/agent-receiver.js';
import {
  retireRoutineNotice,
  retireRoutineNotices,
} from '../../../src/services/agent-messaging/routine-notices.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
const handle = await getTestDb();
const keyring = testKeyring();
const scope = (kinds = ['presence', 'claim'], truncated = false) =>
  `SCOPE/1\nInfo\n${JSON.stringify({ scope_id: 'scope', events: kinds.map((kind) => ({ kind })), events_truncated: truncated })}`;
describe.skipIf(!handle)(
  'routine backlog retirement through real bus claim gates',
  { timeout: 30000 },
  () => {
    let host: typeof s.hosts.$inferSelect, bus: AgentMessagingService, receiver: AgentReceiverService;
    beforeAll(async () => {
      const db = handle!.db,
        now = new Date().toISOString(),
        fqdn = `noise-${randomUUID()}.test`;
      await db.insert(s.hosts).values({
        fqdn,
        apiKey: randomBytes(32).toString('hex'),
        status: 'active',
        secure: 1,
        engines: 'codex,claude,grok',
        createdAt: now,
        updatedAt: now,
      });
      host = (await db.select().from(s.hosts).where(eq(s.hosts.fqdn, fqdn)))[0]!;
      await db
        .insert(s.versions)
        .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: now })
        .onDuplicateKeyUpdate({ set: { version: '1' } });
      const env = {
        ...loadTestEnv(),
        CXX_QUEUE_DELIVERY_V1_ENABLED: true,
        CXX_QUEUE_DELIVERY_V1_HOST_IDS: '',
      };
      bus = new AgentMessagingService(db, env, keyring);
      receiver = new AgentReceiverService(db, env, keyring);
    });
    afterAll(async () => {
      const db = handle!.db;
      const addresses = await db
        .select()
        .from(s.agentBusAddresses)
        .where(eq(s.agentBusAddresses.hostId, host.id));
      const ids = addresses.map((a) => a.id);
      if (ids.length) {
        await db
          .delete(s.agentBusMessages)
          .where(
            or(
              inArray(s.agentBusMessages.targetAddressId, ids),
              inArray(s.agentBusMessages.senderAddressId, ids),
            ),
          );
        await db
          .delete(s.agentBusConversations)
          .where(
            or(
              inArray(s.agentBusConversations.addressAId, ids),
              inArray(s.agentBusConversations.addressBId, ids),
            ),
          );
      }
      await db.delete(s.agentSessions).where(eq(s.agentSessions.hostId, host.id));
      await db.delete(s.agentBusAddresses).where(eq(s.agentBusAddresses.hostId, host.id));
      const clones = await db.select().from(s.gitClones).where(eq(s.gitClones.hostId, host.id));
      if (clones.length) {
        const ids = clones.map((c) => c.id);
        await db.delete(s.gitMergeRequests).where(inArray(s.gitMergeRequests.cloneId, ids));
        await db.delete(s.gitWorktrees).where(inArray(s.gitWorktrees.cloneId, ids));
        await db.delete(s.gitClones).where(inArray(s.gitClones.id, ids));
      }
      await db.delete(s.hosts).where(eq(s.hosts.id, host.id));
      await handle!.pool.end();
    });
    async function peer(engine: 'codex' | 'claude' | 'grok' = 'codex', batch = false, smart = true) {
      const id = randomUUID(),
        token = randomBytes(32).toString('base64url'),
        native = randomUUID(),
        generation = randomUUID();
      const out = await bus.registerSession(host, {
        sessionId: id,
        bridgeToken: token,
        engine,
        username: id,
        cwd: '/tmp/noise',
        invocationKind: 'interactive',
        upstreamSessionId: native,
        adapterCapabilities: { execution_contract_version: 2 },
      });
      const address = out.address as { id: string; address: string };
      const protocol = (
        { codex: 'codex-queue-v1', claude: 'claude-channel-v1', grok: 'grok-acp-v1' } as const
      )[engine];
      await receiver.register(id, token, {
        generation,
        protocol,
        native_session_id: native,
        capabilities: { queue_delivery_v1: smart, ...(batch ? { peer_batch_v1: true } : {}) },
      });
      return { id, token, generation, address: address.address, addressId: address.id };
    }
    type Peer = Awaited<ReturnType<typeof peer>>;
    async function notice(p: Peer, content = scope()) {
      const id = await bus.coordinationTransaction(p.id, p.token, (tx, session) =>
        bus.coordinationNotice(tx, session!, content),
      );
      return (await handle!.db.select().from(s.agentBusMessages).where(eq(s.agentBusMessages.id, id!)))[0]!;
    }
    async function row(id: string) {
      return (await handle!.db.select().from(s.agentBusMessages).where(eq(s.agentBusMessages.id, id)))[0]!;
    }
    const claim = (p: Peer) => bus.claimForSession(p.id, p.token, randomUUID(), p.generation);
    async function complete(p: Peer, d: NonNullable<Awaited<ReturnType<typeof claim>>>) {
      await bus.acknowledgeSessionDelivery(p.id, p.token, d.message_id, {
        claimId: d.claim_id,
        outcome: 'completed',
      });
    }
    for (const engine of ['codex', 'claude', 'grok'] as const)
      it(`${engine}: old routine notices vanish before delivery, direct CLAIM and room chat survive`, async () => {
        const p = await peer(engine, false, false),
          old = await notice(p),
          direct = await notice(p, 'CLAIM/1\nA resource conflicts'),
          chat = await notice(p, scope(['presence', 'chat']));
        const d = await claim(p);
        expect(d).toMatchObject({ message_id: direct.id, content: 'CLAIM/1\nA resource conflicts' });
        expect(await row(old.id)).toMatchObject({
          status: 'canceled',
          attempts: 0,
          lastErrorCode: 'routine_notice_retired',
        });
        await complete(p, d!);
        expect(await claim(p)).toMatchObject({ message_id: chat.id });
      });
    it('retires 257 queued routine rows in bounded pages without digesting them or dropping explicit peer text', async () => {
      const p = await peer('codex', true),
        source = await peer('claude'),
        template = await notice(p);
      const now = new Date().toISOString();
      const copies = Array.from({ length: 256 }, () => ({
        ...template,
        id: randomUUID(),
        conversationId: randomUUID(),
        clientMessageId: randomUUID(),
        dispatchOrder: undefined,
      }));
      await handle!.db.insert(s.agentBusConversations).values(
        copies.map((m) => ({
          id: m.conversationId,
          addressAId: m.senderAddressId,
          addressBId: m.targetAddressId,
          createdByAddressId: m.senderAddressId,
          nextSequence: 2,
          status: 'open',
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      );
      await handle!.db.insert(s.agentBusMessages).values(copies);
      const sent: any = await bus.sendMessage(source.id, source.token, {
        to: p.address,
        content: scope(),
        clientMessageId: randomUUID(),
      });
      let delivery = await claim(p),
        polls = 1;
      while (!delivery && polls++ < 8) delivery = await claim(p);
      expect(delivery).toMatchObject({ message_id: sent.message.id, kind: 'message' });
      expect(polls).toBeGreaterThan(1);
      const rows = await handle!.db
        .select()
        .from(s.agentBusMessages)
        .where(
          and(
            eq(s.agentBusMessages.targetAddressId, p.addressId),
            eq(s.agentBusMessages.senderAddressId, template.senderAddressId),
          ),
        );
      expect(rows).toHaveLength(257);
      expect(rows.every((r) => r.status === 'canceled' && r.attempts === 0)).toBe(true);
    });
    it('retires automatic role updates/proposals but preserves explicit review and user publications', async () => {
      const p = await peer('codex', false, false);
      await bus.noticeAddresses(
        [p.addressId],
        'ROLE-UPDATE/1 role=test version=2 previous=1 sha=012345abcdef\nInformational; no reply required.',
      );
      await bus.noticeAddresses(
        [p.addressId],
        'ROLE-PROPOSAL/1 role=test proposal_id=00000000-0000-4000-8000-000000000000 status=applied version=2\nInformational; no reply required.',
      );
      const review: any = await bus.noticeAddresses([p.addressId], 'ROLE-REVIEW/1 Please review');
      await bus.noticeAddresses([p.addressId], 'PUBLICATION/1\nROLE-UPDATE/1 user data');
      const d = await claim(p);
      expect(d?.content).toBe('ROLE-REVIEW/1 Please review');
      const rows = await handle!.db
        .select()
        .from(s.agentBusMessages)
        .where(eq(s.agentBusMessages.targetAddressId, p.addressId));
      expect(rows.filter((r) => r.status === 'canceled')).toHaveLength(2);
      expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
    });
    it('preserves accepted, presented, attempted, leased and uncertain rows', async () => {
      const p = await peer(),
        now = new Date().toISOString();
      const states: Partial<s.AgentBusMessage>[] = [
        { status: 'accepted', acceptedAt: now },
        { presentedAt: now },
        { attempts: 1 },
        { status: 'leased', leaseOwner: 'session:other' },
        { ambiguousAt: now },
        { claimId: randomUUID() },
        { leaseUntil: now },
        { deliverySessionId: p.id },
        { relayGeneration: 1 },
      ];
      const rows: s.AgentBusMessage[] = [];
      for (const state of states) {
        const m = await notice(p);
        await handle!.db.update(s.agentBusMessages).set(state).where(eq(s.agentBusMessages.id, m.id));
        rows.push(await row(m.id));
      }
      await bus.coordinationTransaction(p.id, p.token, async (tx) => {
        for (const m of rows) expect(await retireRoutineNotice(tx, m, keyring, now)).toBe(false);
      });
      for (const m of rows) expect(await row(m.id)).toEqual(m);
    });
    it('retire a digest only when root and every original were never accepted or uncertain', async () => {
      const p = await peer(),
        now = new Date().toISOString();
      for (const variant of [
        'pure',
        'chat',
        'truncated',
        'accepted-original',
        'accepted-root',
        'ambiguous-original',
        'unknown-original',
        'missing-original',
        'malformed-root',
      ]) {
        const root = await notice(p, 'DIGEST/1 preview'),
          child = await notice(
            p,
            variant === 'chat' ? scope(['chat']) : scope(['claim'], variant === 'truncated'),
          );
        await handle!.db
          .update(s.agentBusMessages)
          .set({
            kind: 'digest',
            contentEnc: encrypt(
              variant === 'malformed-root'
                ? 'unparseable'
                : JSON.stringify({
                    digest_id: root.id,
                    remaining: 0,
                    entries: [
                      { message_id: child.id },
                      ...(variant === 'missing-original' ? [{ message_id: randomUUID() }] : []),
                    ],
                  }),
              keyring,
            ),
            ...(variant === 'accepted-root' ? { acceptedAt: now } : {}),
          })
          .where(eq(s.agentBusMessages.id, root.id));
        await handle!.db
          .update(s.agentBusMessages)
          .set({
            status: 'batched',
            digestId: root.id,
            ...(variant === 'accepted-original' ? { acceptedAt: now } : {}),
            ...(variant === 'ambiguous-original' ? { ambiguousAt: now } : {}),
            ...(variant === 'unknown-original' ? { contentEnc: 'unreadable' } : {}),
          })
          .where(eq(s.agentBusMessages.id, child.id));
        const r = await row(root.id),
          c = await row(child.id);
        await bus.coordinationTransaction(p.id, p.token, async (tx) =>
          expect(await retireRoutineNotice(tx, r, keyring, now)).toBe(variant === 'pure'),
        );
        expect((await row(root.id)).status).toBe(variant === 'pure' ? 'canceled' : 'queued');
        expect((await row(child.id)).status).toBe(variant === 'pure' ? 'canceled' : 'batched');
      }
    });
    it('preserves exact current Director waiters, ambiguous bindings and critical events', async () => {
      const p = await peer(),
        db = handle!.db,
        now = new Date().toISOString(),
        cloneId = randomUUID(),
        worktreeId = randomUUID(),
        requestId = randomUUID();
      await db.insert(s.gitClones).values({
        id: cloneId,
        hostId: host.id,
        cloneKey: randomBytes(32).toString('hex'),
        cloneDir: '/tmp/noise/.git',
        repoRoot: '/tmp/noise',
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const [session] = await db.select().from(s.agentSessions).where(eq(s.agentSessions.id, p.id));
      await db.insert(s.gitWorktrees).values({
        id: worktreeId,
        cloneId,
        hostId: host.id,
        worktreePath: '/tmp/noise',
        worktreeHash: randomBytes(32).toString('hex'),
        username: p.id,
        engine: 'codex',
        agentBusAddressId: p.addressId,
        agentSessionId: p.id,
        agentBindingGeneration: session!.bindingGeneration,
        status: 'active',
        registeredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(s.gitMergeRequests).values({
        id: requestId,
        cloneId,
        worktreeId,
        clientRequestId: randomUUID(),
        targetBranch: 'main',
        verdict: 'wait',
        decidedBy: 'policy',
        requestedAt: now,
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      async function attempt(
        kind = 'work_scope_changed',
        branch = 'main',
        overrides: Partial<s.AgentBusMessage> = {},
      ) {
        const m = await notice(
          p,
          `GIT-DIRECTOR/1\nInfo\n${JSON.stringify({ kind, clone_id: cloneId, event_id: randomUUID(), observed_at: now, target_branch: branch })}`,
        );
        return bus.coordinationTransaction(p.id, p.token, (tx) =>
          retireRoutineNotice(tx, { ...m, ...overrides }, keyring, now),
        );
      }
      expect(await attempt()).toBe(false);
      expect(await attempt('merge_reported')).toBe(false);
      expect(await attempt('work_scope_changed', 'other')).toBe(false);
      expect(await attempt('merge_reported', 'other')).toBe(true);
      await db.update(s.gitWorktrees).set({ agentSessionId: null }).where(eq(s.gitWorktrees.id, worktreeId));
      expect(await attempt()).toBe(false);
      await db.update(s.gitWorktrees).set({ agentSessionId: p.id }).where(eq(s.gitWorktrees.id, worktreeId));
      await db
        .update(s.gitMergeRequests)
        .set({ completedAt: now })
        .where(eq(s.gitMergeRequests.id, requestId));
      expect(await attempt()).toBe(true);
      expect(await attempt('lease_expired')).toBe(false);
      expect(
        await attempt('work_scope_changed', 'main', {
          targetBindingGeneration: session!.bindingGeneration + 1,
        }),
      ).toBe(false);
    });
    it('ended sessions cannot receive a queued background notice, while explicit resumable mail remains stored', async () => {
      const p = await peer(),
        source = await peer('grok'),
        old = await notice(p);
      await bus.finishSession(p.id, p.token, 'completed');
      expect((await row(old.id)).status).toBe('canceled');
      await expect(claim(p)).rejects.toMatchObject({ code: expect.any(String) });
      const sent: any = await bus.sendMessage(source.id, source.token, {
        to: p.address,
        content: 'Explicit followup',
        clientMessageId: randomUUID(),
      });
      expect(sent).toMatchObject({ recipient_presence: 'resumable', message: { status: 'queued' } });
      expect((await row(sent.message.id)).status).toBe('queued');
    });
  },
);
