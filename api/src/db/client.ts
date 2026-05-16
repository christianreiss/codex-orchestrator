import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import type { Env } from '../env.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];

export function createDb(env: Env) {
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

  const db = drizzle(pool, { schema, mode: 'default' });

  return { db, pool };
}
