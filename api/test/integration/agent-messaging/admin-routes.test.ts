import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  adminEvents,
  agentBusAddresses,
  agentBusMessages,
} from '../../../src/db/schema.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAgentMessagingRoutes } from '../../../src/routes/agent-messaging/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const ADDRESS_ID = '22222222-2222-4222-8222-222222222222';
const PLAINTEXT = 'private agent message';
const keyring = testKeyring();
const apps: Array<ReturnType<typeof Fastify>> = [];

function seedDb(): DbFake {
  const db = createDbFake();
  db.tables.set(agentBusMessages, [{ id: MESSAGE_ID, contentEnc: encrypt(PLAINTEXT, keyring) }]);
  db.tables.set(agentBusAddresses, [
    {
      id: ADDRESS_ID,
      address: 'agent:test-address',
      displayAlias: null,
      hostId: 7,
      engine: 'codex',
      username: 'tester',
      cwd: '/tmp/test',
      cwdHash: 'a'.repeat(64),
      enabled: 1,
      currentSessionId: null,
      lastUpstreamSessionId: null,
      bindingGeneration: 1,
      continuity: 'native',
      adapterProtocol: null,
      adapterCapabilities: null,
      readiness: 'offline',
      receiveHeartbeatAt: null,
      lastSeenAt: '2026-07-31T00:00:00.000Z',
      archivedAt: null,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
    },
  ]);
  return db;
}

async function buildApp(db: DbFake = seedDb()) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  app.decorate('requireAdmin', async (req: import('fastify').FastifyRequest) => {
    req.admin = {
      user: { id: 7, accessLevel: 'owner', active: 1 } as never,
      session: { id: 1 } as never,
    };
  });
  app.decorate('resolveAdmin', async () => null);
  await registerAgentMessagingRoutes(app, {
    db: db as never,
    env: loadTestEnv(),
    keyring,
  } as RouteContext);
  return { app, db };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Agent Messaging admin route presentation', () => {
  it('returns revealed plaintext with no-store headers and an audit-only event', async () => {
    const { app, db } = await buildApp();
    const observed: string[] = [];
    const unsubscribe = wsPublisher.subscribe((event) => observed.push(event.type));

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/admin/agent-messaging/messages/${MESSAGE_ID}/reveal`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ message_id: MESSAGE_ID, content: PLAINTEXT });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(observed).not.toContain('agent_messaging.message.revealed');
      expect(db.tables.get(adminEvents)).toEqual([
        expect.objectContaining({
          type: 'agent_messaging.message.revealed',
          payload: { message_id: MESSAGE_ID, admin_user_id: 7 },
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('keeps the service event as the single live event while persisting the route audit', async () => {
    const { app, db } = await buildApp();
    const observed: string[] = [];
    const unsubscribe = wsPublisher.subscribe((event) => {
      if (event.type === 'agent_messaging.address.changed') observed.push(event.type);
    });

    try {
      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/agent-messaging/addresses/${ADDRESS_ID}`,
        payload: { alias: 'build' },
      });

      expect(response.statusCode).toBe(200);
      expect(observed).toEqual(['agent_messaging.address.changed']);
      expect(db.tables.get(adminEvents)).toEqual([
        expect.objectContaining({
          type: 'agent_messaging.address.changed',
          payload: { address_id: ADDRESS_ID, alias: 'build', admin_user_id: 7 },
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });
});
