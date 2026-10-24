import type { Pool } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import * as schema from '../db/schema.js';
import type { Database } from '../db/client.js';
import { ControlPlaneOwnership } from '../control-plane/owner.js';

/** Maintenance tools may write only while the API is stopped. Both the lock
 * and writes use one connection: loss cannot fall through to a new pool peer. */
export async function acquireOfflineDatabase(pool: Pool, database: string) {
  const ownership = new ControlPlaneOwnership(pool, database);
  try {
    const connection = await ownership.acquire();
    const borrowed = new Proxy(connection, {
      get(target, key) {
        if (key === 'release') return () => {};
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return {
      db: drizzle(connection, { schema, mode: 'default' }) as unknown as Database,
      pool: { getConnection: async () => borrowed },
      close: () => ownership.close(),
    };
  } catch (error) {
    await ownership.close();
    throw error;
  }
}
