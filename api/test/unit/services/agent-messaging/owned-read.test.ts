import { OwnedConferences } from '../../../../src/services/agent-messaging/owned-conference.js';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../../src/db/schema.js';
import type { Database } from '../../../../src/db/client.js';
import type { Env } from '../../../../src/env.js';
import { Keyring } from '../../../../src/security/keyring.js';
import { encrypt } from '../../../../src/security/secret-box.js';
import { sha256 } from '../../../../src/security/hash.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../../src/control-plane/state/catalog.js';
import {
  bindOwnerRuntime,
  withOwnerRequestScope,
  type OwnerRuntime,
} from '../../../../src/control-plane/state/runtime.js';
import { installOwnerResponseBoundary } from '../../../../src/http/plugins/owner-response.js';
import { AgentMessagingService } from '../../../../src/services/agent-messaging.js';
import { newQueuedMessage } from '../../../../src/services/agent-messaging/views.js';
import { createDbFake } from '../../../helpers/db-fake.js';

const keyring = Keyring.fromEnv({ ENCRYPTION_ACTIVE_KEY: Buffer.alloc(32, 17).toString('base64') } as Env);
const engines = ['codex', 'claude', 'grok'] as const;
function fixture(
  engine: (typeof engines)[number] = 'codex',
  count = 1,
  content = 'fixture-private-message',
  owned = true,
) {
  const sessionId = randomUUID(),
    senderId = randomUUID(),
    targetId = randomUUID(),
    conversationId = randomUUID();
  const now = new Date().toISOString(),
    token = 'fixture-bridge',
    hostKey = 'fixture-host';
  const sender = {
    id: senderId,
    address: `agent:${senderId}`,
    hostId: 1,
    username: 'sender',
    engine: 'claude',
    enabled: 1,
    archivedAt: null,
    currentSessionId: null,
    bindingGeneration: 1,
    launchName: 'Sender',
  };
  const target = {
    id: targetId,
    address: `agent:${targetId}`,
    hostId: 1,
    username: 'receiver',
    engine,
    enabled: 1,
    archivedAt: null,
    currentSessionId: sessionId,
    bindingGeneration: 1,
    launchName: 'Receiver',
  };
  const contentEnc = encrypt(content, keyring);
  const rows = Array.from({ length: count }, (_, index) => ({
    ...newQueuedMessage({
      id: randomUUID(),
      conversationId,
      sequence: index + 1,
      sender: sender as never,
      senderSessionId: null,
      target: target as never,
      kind: 'message',
      content,
      contentEnc,
      clientMessageId: randomUUID(),
      expiresAt: '2099-01-01T00:00:00.000Z',
      now,
    }),
    status: 'completed',
    dispatchOrder: index + 1,
  }));
  const seed = {
    hosts: [
      {
        id: 1,
        apiKey: hostKey,
        apiKeyHash: null,
        status: 'active',
        secure: 1,
        engines: engines.join(','),
        expiresAt: null,
      },
    ],
    versions: [{ name: 'agent_messaging_enabled', version: '1' }],
    agentSessions: [
      {
        id: sessionId,
        hostId: 1,
        engine,
        username: 'receiver',
        cwd: '/fixture',
        agentBusAddressId: targetId,
        bindingGeneration: 1,
        bridgeTokenHash: sha256(token),
        hostAuthFingerprint: sha256(hostKey),
        bridgeExpiresAt: '2099-01-01T00:00:00.000Z',
        expiresAt: null,
        endedAt: null,
      },
    ],
    agentBusAddresses: [sender, target],
    agentBusConversations: [
      {
        id: conversationId,
        addressAId: senderId,
        addressBId: targetId,
        status: 'open',
        nextSequence: count + 1,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
        lastToASequence: 0,
        lastToBSequence: count,
      },
    ],
    agentBusMessages: rows,
  } as unknown as StateSeed;
  const db = createDbFake(
    new Map(
      Object.entries(seed).map(([table, values]) => [
        (schema as unknown as Record<string, unknown>)[table],
        structuredClone(values) as unknown as Record<string, unknown>[],
      ]),
    ),
  ) as unknown as Database;
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const runtime = {
    state,
    assertOwner() {},
    execute() {
      throw new Error('Read must not mutate');
    },
  } as unknown as OwnerRuntime;
  if (owned) bindOwnerRuntime(db, runtime);
  const service = new AgentMessagingService(db, {} as Env, keyring);
  if (!owned)
    Object.assign(service, {
      authenticateBridge: async () => ({ session: seed.agentSessions![0], host: seed.hosts![0] }),
      requireEnabledLocked: async () => {},
      assertSessionAddressLocked: async () => {},
    });
  const read = (operation: 'message' | 'wait') =>
    operation === 'message'
      ? service.getMessage(sessionId, token, rows[0]!.id!)
      : service.waitForMessages(sessionId, token, conversationId);
  const revoke = (kind: 'finish' | 'token' | 'binding' | 'host') => {
    const draft = state.begin();
    if (kind === 'host') draft.upsert('hosts', { ...draft.table('hosts').get(1)!, status: 'inactive' });
    else
      draft.upsert('agentSessions', {
        ...draft.table('agentSessions').get(sessionId)!,
        ...(kind === 'finish'
          ? { endedAt: now }
          : kind === 'token'
            ? { bridgeTokenHash: sha256('rotated') }
            : { bindingGeneration: 2 }),
      });
    state.publish(draft.seal({ ...state.revision(), sequence: state.revision().sequence + 1n }));
  };
  return {
    sessionId,
    conversationId,
    rows,
    state,
    runtime,
    service,
    token,
    read,
    revoke,
    db,
    historyAfter(after: number) {
      // The common DB fake implements equality, but not SQL's gt predicate.
      (db as unknown as ReturnType<typeof createDbFake>).tables.set(
        schema.agentBusMessages,
        structuredClone(rows.filter((row) => row.sequence! > after)),
      );
    },
  };
}

describe.each(engines)('%s owned direct-message response authority', (engine) => {
  it.each(['message', 'wait'] as const)('keeps authorized %s reads working', async (operation) => {
    const h = fixture(engine),
      app = Fastify();
    app.addHook('onRequest', (_req, _reply, done) => withOwnerRequestScope(done));
    installOwnerResponseBoundary(app, h.runtime);
    app.post('/probe', () => h.read(operation));
    try {
      const reply = await app.inject({ method: 'POST', url: '/probe', payload: {} });
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toContain('fixture-private-message');
    } finally {
      await app.close();
    }
  });
  for (const kind of ['finish', 'token', 'binding', 'host'] as const)
    it.each(['message', 'wait'] as const)(
      `denies %s disclosure after ${kind} changes before response`,
      async (operation) => {
        const h = fixture(engine),
          app = Fastify();
        app.addHook('onRequest', (_req, _reply, done) => withOwnerRequestScope(done));
        installOwnerResponseBoundary(app, h.runtime);
        app.post('/probe', async () => {
          const result = await h.read(operation);
          // Simulate another authorized command committing after the cold read,
          // before Fastify serializes/sends its result. Use the real boundary.
          h.revoke(kind);
          return result;
        });
        try {
          const reply = await app.inject({ method: 'POST', url: '/probe', payload: {} });
          expect(reply.statusCode).toBeGreaterThanOrEqual(400);
          expect(reply.body).not.toContain('fixture-private-message');
        } finally {
          await app.close();
        }
      },
    );
});

describe('owned wait byte pagination', () => {
  it.each(['plain', 'json-escaped'])(
    'pages legal maximum-sized %s messages without skipping a cursor',
    async (representation) => {
      const content = (representation === 'plain' ? 'x' : '\u0001').repeat(32 * 1024);
      const h = fixture('codex', 100, content);
      const seen: string[] = [];
      let after = 0,
        pages = 0;
      for (;;) {
        h.historyAfter(after);
        const page = (await h.service.waitForMessages(h.sessionId, h.token, h.conversationId, after)) as {
          messages: Array<{ id: string; sequence: number; content: string }>;
          has_more: boolean;
          next_sequence: number;
        };
        const serialized = JSON.stringify(page);
        expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(512 * 1024);
        // The shared MCP adapter returns both a text JSON copy and structured
        // content. Keep that complete response within its own 2 MiB IPC limit.
        const mcp = { content: [{ type: 'text', text: serialized }], structuredContent: page };
        expect(Buffer.byteLength(JSON.stringify(mcp))).toBeLessThan(2 * 1024 * 1024);
        expect(page.messages.length).toBeGreaterThan(0);
        expect(page.messages.every((row) => row.content === content)).toBe(true);
        expect(page.next_sequence).toBeGreaterThan(after);
        expect(page.next_sequence).toBe(page.messages.at(-1)!.sequence);
        seen.push(...page.messages.map((row) => row.id));
        after = page.next_sequence;
        pages++;
        if (!page.has_more) break;
        expect(pages).toBeLessThan(100);
      }
      expect(pages).toBeGreaterThan(1);
      expect(seen).toEqual(h.rows.map((row) => row.id));
      const empty = await h.service.waitForMessages(h.sessionId, h.token, h.conversationId, after);
      expect(empty).toMatchObject({ messages: [], has_more: false, next_sequence: after });
    },
  );
});

// Authentication is fixture-provided here; these exercise the real legacy read
// and shared digest projection/pagination rather than an alternate paging model.
describe.each(engines.flatMap((engine) => [true, false].map((owned) => ({ engine, owned }))))(
  '$engine owned=$owned byte pagination',
  ({ engine, owned }) => {
    for (const operation of ['wait', 'digest'] as const)
      it.each(['plain', 'json-escaped'])(
        '%s ' + operation + ' keeps every body within transport bounds',
        async (representation) => {
          const content = (representation === 'plain' ? 'x' : '\u0001').repeat(32 * 1024);
          const h = fixture(engine, 100, content, owned);
          if (operation === 'digest')
            Object.assign(h.service, {
              getMessage: async () => ({ message: { kind: 'digest' } }),
            });
          let after = 0;
          const seen: string[] = [];
          for (let pages = 0; ; pages++) {
            expect(pages).toBeLessThan(100);
            h.historyAfter(after);
            const page = await (operation === 'wait'
              ? h.service.waitForMessages(h.sessionId, h.token, h.conversationId, after)
              : h.service.getDigest(h.sessionId, h.token, h.conversationId, after, 20));
            const messages = page.messages as Array<{ id: string; content: string; sequence: number }>;
            const serialized = JSON.stringify(page);
            expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(512 * 1024);
            expect(
              Buffer.byteLength(
                JSON.stringify({ content: [{ type: 'text', text: serialized }], structuredContent: page }),
              ),
            ).toBeLessThan(2 * 1024 * 1024);
            expect(messages.length).toBeGreaterThan(0);
            expect(messages.every((row) => row.content === content)).toBe(true);
            seen.push(...messages.map((row) => row.id));
            const next = operation === 'wait' ? (page.has_more ? page.next_sequence : null) : page.next_after;
            if (next === null) break;
            expect(next).toBeGreaterThan(after);
            after = next as number;
          }
          expect(seen).toEqual(h.rows.map((row) => row.id));
        },
      );
  },
);

describe.each(engines)('%s conference read authority', (engine) => {
  for (const operation of ['roster', 'list', 'open'] as const)
    it.each([
      'none',
      'finish',
      'left',
      'replace',
      'rejoin',
      'role',
      'owner',
      'binding',
      'token',
      'host',
    ] as const)(operation + ' final boundary %s', async (revoke) => {
      const h = fixture(engine),
        conferenceId = randomUUID(),
        memberId = randomUUID();
      const addressId = h.state.snapshot().table('agentSessions').get(h.sessionId)!.agentBusAddressId!;
      const now = new Date().toISOString();
      const draft = h.state.begin();
      draft.upsert('agentBusConferences', {
        id: conferenceId,
        ownerAddressId: addressId,
        ownerAdminId: null,
        topic: 'PRIVATE TOPIC',
        purpose: 'PRIVATE PURPOSE',
        pin: '1234',
        pinExpiresAt: '2099-01-01T00:00:00.000Z',
        status: 'open',
        maxMembers: 10,
        deadlineAt: '2099-01-01T00:00:00.000Z',
        adjournReason: null,
        adjournedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      const member = {
        id: memberId,
        conferenceId,
        addressId,
        launchName: 'Receiver',
        requestedTarget: null,
        conversationId: null,
        role: 'owner',
        purpose: 'PRIVATE PURPOSE',
        mode: 'attached',
        state: 'seated',
        dispatchMessageId: null,
        dispatchDeadlineAt: null,
        dispatchedAt: null,
        lastReportAt: null,
        messageCount: 0,
        joinedAt: now,
        leftAt: null,
        createdAt: now,
        updatedAt: now,
      };
      draft.upsert('agentBusConferenceMembers', member);
      h.state.publish(draft.seal({ ...h.state.revision(), sequence: h.state.revision().sequence + 1n }));
      const service = new OwnedConferences(h.runtime, keyring),
        app = Fastify();
      app.addHook('onRequest', (_req, _reply, done) => withOwnerRequestScope(done));
      installOwnerResponseBoundary(app, h.runtime);
      app.post('/probe', async () => {
        const result = await (operation === 'open'
          ? service.open(h.sessionId, h.token)
          : operation === 'list'
            ? service.list(h.sessionId, h.token)
            : service.roster(h.sessionId, h.token, conferenceId));
        if (
          revoke === 'left' ||
          revoke === 'replace' ||
          revoke === 'rejoin' ||
          revoke === 'role' ||
          revoke === 'owner'
        ) {
          const change = h.state.begin();
          if (revoke === 'left')
            change.upsert('agentBusConferenceMembers', { ...member, state: 'left', leftAt: now });
          else if (revoke === 'rejoin')
            change.upsert('agentBusConferenceMembers', { ...member, joinedAt: '2098-01-01T00:00:00.000Z' });
          else if (revoke === 'role')
            change.upsert('agentBusConferenceMembers', { ...member, role: 'participant' });
          else if (revoke === 'owner')
            change.upsert('agentBusConferences', {
              ...change.table('agentBusConferences').get(conferenceId)!,
              ownerAddressId: randomUUID(),
            });
          else {
            change.remove('agentBusConferenceMembers', memberId);
            change.upsert('agentBusConferenceMembers', { ...member, id: randomUUID() });
          }
          h.state.publish(change.seal({ ...h.state.revision(), sequence: h.state.revision().sequence + 1n }));
        } else if (revoke !== 'none') h.revoke(revoke);
        return result;
      });
      try {
        const reply = await app.inject({ method: 'POST', url: '/probe', payload: {} });
        if (revoke === 'none' || (operation !== 'open' && (revoke === 'role' || revoke === 'owner'))) {
          expect(reply.statusCode).toBe(200);
          expect(reply.body).toContain('PRIVATE');
        } else {
          expect(reply.statusCode).toBeGreaterThanOrEqual(400);
          expect(reply.body).not.toContain('PRIVATE');
          expect(reply.body).not.toContain('1234');
        }
      } finally {
        await app.close();
      }
    });
});

describe.each(engines)('%s address lifecycle read authority', (engine) => {
  it.each(['disabled', 'archived'] as const)(
    'denies %s addresses initially and at the final response boundary',
    async (status) => {
      for (const operation of ['message', 'wait'] as const)
        for (const timing of ['before', 'after'] as const) {
          const h = fixture(engine),
            app = Fastify();
          const revoke = () => {
            const change = h.state.begin();
            const session = change.table('agentSessions').get(h.sessionId)!;
            const address = change.table('agentBusAddresses').get(session.agentBusAddressId!)!;
            change.upsert('agentBusAddresses', {
              ...address,
              ...(status === 'disabled' ? { enabled: 0 } : { archivedAt: new Date().toISOString() }),
            });
            h.state.publish(
              change.seal({ ...h.state.revision(), sequence: h.state.revision().sequence + 1n }),
            );
          };
          if (timing === 'before') revoke();
          app.addHook('onRequest', (_req, _reply, done) => withOwnerRequestScope(done));
          installOwnerResponseBoundary(app, h.runtime);
          app.post('/probe', async () => {
            const result = await h.read(operation);
            if (timing === 'after') revoke();
            return result;
          });
          try {
            const reply = await app.inject({ method: 'POST', url: '/probe', payload: {} });
            expect.soft(reply.statusCode, operation + ':' + timing).toBeGreaterThanOrEqual(400);
            expect.soft(reply.body, operation + ':' + timing).not.toContain('fixture-private-message');
          } finally {
            await app.close();
          }
        }
    },
  );
});
