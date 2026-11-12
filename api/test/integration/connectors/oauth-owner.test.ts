import { randomUUID, createHash } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import * as schema from '../../../src/db/schema.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { scopedDatabase, protectOwnerReadHandle } from '../../../src/db/fresh-read.js';
import { ConnectorStore } from '../../../src/services/connectors/store.js';
import { ConnectorOAuth } from '../../../src/services/connectors/oauth.js';
const handle = await getTestDb();
afterAll(async () => {
  await handle?.pool.end();
});
it.skipIf(!handle)(
  'persists OAuth exchange and reloads the same grants after owner hydration',
  async () => {
    const priorRecords = await handle!.db.select().from(schema.connectorRecords);
    const now = new Date().toISOString(),
      suffix = randomUUID(),
      keyring = testKeyring();
    const [insert] = await handle!.db
      .insert(schema.adminUsers)
      .values({
        username: `oauth-${suffix}`,
        name: 'Connector test',
        email: `${suffix}@example.test`,
        passwordHash: 'test-only',
        accessLevel: 'owner',
        active: 1,
        createdAt: now,
        updatedAt: now,
      });
    const userId = Number(insert.insertId),
      owner = new ControlPlaneOwnership(handle!.pool, `connector_${suffix}`),
      deadlines = new DeadlineQueue((e) => {
        throw e;
      });
    let executor:
      | CommandExecutor<
          import('../../../src/control-plane/state/store.js').OwnerStateSnapshot,
          import('../../../src/control-plane/persistence.js').PersistenceTransaction,
          import('../../../src/control-plane/state/store.js').PreparedOwnerState
        >
      | undefined;
    try {
      await owner.acquire();
      const { store } = await owner.hydrate((connection, epoch) =>
        hydrateOwnerState(drizzle(connection, { schema, mode: 'default' }), { epoch, sequence: 0n }),
      );
      owner.ready();
      executor = new CommandExecutor({
        state: store,
        persistence: new OwnerPersistence(owner, keyring),
        assertOwner: () => owner.assertReady(),
        loseOwner: (e) => owner.lose(e),
        notificationError: (e) => {
          throw e;
        },
        committed() {},
      });
      const runtime: OwnerRuntime = {
        state: store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (c) => executor!.execute(c),
      };
      const db = scopedDatabase(handle!.db);
      bindOwnerRuntime(db, runtime);
      protectOwnerReadHandle(db);
      const records = new ConnectorStore(db),
        oauth = new ConnectorOAuth(records, 'https://fleet.example');
      await oauth.setPolicy({
        enabled: true,
        providers: { chatgpt: true, claude: true, grok: true, kimi: true },
        ceiling: { categories: { hosts: 'ro' }, hosts: [1] },
      });
      const client = await oauth.register({ redirect_uris: ['https://client.example/callback'] }, 'grok'),
        verifier = 'v'.repeat(64);
      const request = oauth.validateAuthorization({
        client_id: client.id,
        redirect_uri: client.redirects[0],
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: 'https://fleet.example/connectors/mcp',
      });
      await records.change('request', (ctx) => {
        records.put(ctx, 'request:db', 'request', request, 600);
        return true;
      });
      const redirect = await oauth.consent(
        userId,
        request,
        { categories: { hosts: 'ro' }, hosts: [1] },
        () => ['hosts_list'],
        'request:db',
      );
      const token = await oauth.exchange({
        grant_type: 'authorization_code',
        client_id: client.id,
        redirect_uri: client.redirects[0],
        code_verifier: verifier,
        code: new URL(redirect).searchParams.get('code'),
      });
      expect(oauth.authenticate(token.access_token).user.id).toBe(userId);
      await executor.drain();
      const hydrated = await hydrateOwnerState(handle!.db, { epoch: randomUUID(), sequence: 0n });
      expect(
        hydrated.store
          .snapshot()
          .table('connectorRecords')
          .all()
          .some((r) => r.kind === 'grant'),
      ).toBe(true);
      expect(
        (await handle!.db.select().from(schema.connectorRecords)).every(
          (r) => !r.bodyJson.includes(token.access_token) && !r.bodyJson.includes(token.refresh_token),
        ),
      ).toBe(true);
    } finally {
      await executor?.drain();
      deadlines.close();
      await owner.close();
      for (const row of await handle!.db.select().from(schema.connectorRecords))
        if (!priorRecords.some((prior) => prior.id === row.id))
          await handle!.db.delete(schema.connectorRecords).where(eq(schema.connectorRecords.id, row.id));
      for (const row of priorRecords)
        await handle!.db
          .insert(schema.connectorRecords)
          .values(row)
          .onDuplicateKeyUpdate({
            set: { bodyJson: row.bodyJson, expiresAt: row.expiresAt, createdAt: row.createdAt },
          });
      await handle!.db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, userId));
    }
  },
  60000,
);
