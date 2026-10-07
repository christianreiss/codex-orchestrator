import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { ENGINES } from '../../../src/util/engine.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
describe.skipIf(!config)('messaging with one database connection', () => {
  const pool = mysql.createPool({ ...config, connectionLimit: 1 });
  const db = drizzle(pool, { schema, mode: 'default' });
  let service: AgentMessagingService;
  let host: typeof schema.hosts.$inferSelect;
  const fqdn = `pool-regression-${randomUUID()}.test`;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await db
      .insert(schema.hosts)
      .values({
        fqdn,
        apiKey: randomBytes(32).toString('hex'),
        status: 'active',
        secure: 1,
        engines: ENGINES.join(','),
        agentMessagingEnabled: 1,
        createdAt: now,
        updatedAt: now,
      });
    host = (await db.select().from(schema.hosts).where(eq(schema.hosts.fqdn, fqdn)))[0]!;
    await db
      .insert(schema.versions)
      .values({ name: 'agent_messaging_enabled', version: '1', updatedAt: now })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    await db
      .insert(schema.versions)
      .values({ name: 'agent_portal_enabled', version: '1', updatedAt: now })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    for (const engine of ENGINES) {
      await db
        .insert(schema.versions)
        .values({ name: `${engine}_engine_disabled`, version: '0', updatedAt: now })
        .onDuplicateKeyUpdate({ set: { version: '0' } });
    }
    // Model a cache expiring between bridge authentication and its transaction.
    // The transaction owns the only connection; escaping to the pool must hang.
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((callback, options) =>
      transaction(async (tx) => {
        invalidateFleetEngineState(db);
        return callback(tx);
      }, options),
    );
    service = new AgentMessagingService(db, loadTestEnv(), testKeyring());
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (host) {
      await db.delete(schema.agentSessions).where(eq(schema.agentSessions.hostId, host.id));
      await db.delete(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.hostId, host.id));
      await db.delete(schema.hosts).where(eq(schema.hosts.id, host.id));
    }
    await pool.end();
  });

  it.each(ENGINES)(
    'registers, checks eligibility, and re-enables a %s address without borrowing another connection',
    async (engine) => {
      const sessionId = randomUUID(),
        bridgeToken = randomBytes(32).toString('base64url');
      const registered = await service.registerSession(host, {
        sessionId,
        bridgeToken,
        engine,
        username: `pool-${engine}`,
        cwd: '/tmp/pool-regression',
        invocationKind: 'interactive',
      });
      expect(registered.enabled).toBe(true);
      await expect(service.listAddresses(sessionId, bridgeToken)).resolves.toHaveProperty('addresses');
      const addressId = (registered.address as { id: string }).id;
      await service.setAddressEnabled(addressId, false);
      await expect(service.setAddressEnabled(addressId, true)).resolves.toHaveProperty('enabled', true);
    },
    2_000,
  );
  it.each(ENGINES)(
    'registers and heartbeats a %s portal session on its transaction connection',
    async (engine) => {
      const portal = new AgentPortalService(db, loadTestEnv(), testKeyring());
      const sessionId = randomUUID(),
        bridgeToken = randomBytes(32).toString('base64url');
      await expect(
        portal.registerAgent(host, {
          sessionId,
          bridgeToken,
          engine,
          username: `pool-portal-${engine}`,
          cwd: '/tmp/pool-regression',
          invocationKind: 'interactive',
        }),
      ).resolves.toHaveProperty('enabled', true);
      await expect(portal.heartbeatAgent(sessionId, bridgeToken, {})).resolves.toHaveProperty('expires_at');
    },
    2_000,
  );
});
