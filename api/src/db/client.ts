import { getTableName, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { MySqlTable } from 'drizzle-orm/mysql-core';
import mysql from 'mysql2/promise';
import type { Env } from '../env.js';
import { installReadCache, type ReadCache } from './read-cache.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];

/**
 * Tables the API process serves from RAM (see read-cache.ts). Only tables this
 * process is the sole writer of belong here; quota-cron and the CLI tools call
 * createDb without the cache.
 */
export const READ_CACHE_TABLES = {
  hosts: { uniqueColumns: ['id', 'api_key_hash', 'api_key', 'fqdn'], rowKey: 'id' },
  versions: { uniqueColumns: ['name'], rowKey: 'name' },
  host_daemons: { uniqueColumns: ['host_id'], rowKey: 'host_id' },
  provider_accounts: { uniqueColumns: ['id'], rowKey: 'id' },
};

export function createDb(env: Env, options: { readCache?: boolean } = {}) {
  const pool = mysql.createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    charset: env.DB_CHARSET ?? 'utf8mb4',
    waitForConnections: true,
    connectionLimit: env.DB_POOL_SIZE ?? 10,
    queueLimit: 0,
    enableKeepAlive: true,
    timezone: 'Z',
    decimalNumbers: true,
    dateStrings: true,
  });

  let readCache: ReadCache | undefined;
  if (options.readCache) {
    const allTables = Object.values(schema)
      .filter((value) => is(value, MySqlTable))
      .map((table) => getTableName(table as MySqlTable));
    readCache = installReadCache(pool, {
      tables: READ_CACHE_TABLES,
      allTables,
      resyncMs: (env.DB_READ_CACHE_RESYNC_SECONDS ?? 15) * 1000,
    });
  }

  const db = drizzle(pool, { schema, mode: 'default' });

  return { db, pool, readCache };
}
