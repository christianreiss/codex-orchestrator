import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';
import { ServiceUnavailableError } from '../http/errors.js';

export interface GrokAccountOwner {
  accountId: number;
  db: Database;
  connection: PoolConnection;
}

/** The durable state is the spend fence; this connection lock serializes live owners. */
export async function withGrokAccountLock<T>(
  db: Database,
  accountId: number,
  operation: (owner: GrokAccountOwner) => Promise<T>,
  deadline = Date.now() + 6000,
): Promise<T> {
  const pool = db.$client as Pool;
  let expired = false;
  const acquiring = pool.getConnection();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connection = await Promise.race([
    acquiring.then(conn => { if (expired) conn.release(); return conn; }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(pending()); }, Math.max(1, deadline - Date.now())); }),
  ]).finally(() => clearTimeout(timer));
  let held = false;
  let name = '';
  try {
    const [identity] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS db');
    const schemaHash = createHash('sha256').update(String(identity[0]?.db ?? '')).digest('hex').slice(0, 16);
    name = `cxx:grok:${schemaHash}:${accountId}`;
    while (Date.now() < deadline) {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS held', [name]);
      if (rows[0]?.held === 1) { held = true; break; }
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    if (!held) throw pending();
    return await operation({ accountId, connection, db: drizzle(connection, { schema, mode: 'default' }) as unknown as Database });
  } finally {
    try { if (held) await connection.query('SELECT RELEASE_LOCK(?)', [name]); } finally { connection.release(); }
  }
}

function pending() {
  return new ServiceUnavailableError('Grok account refresh is still pending', 'grok_refresh_pending');
}
