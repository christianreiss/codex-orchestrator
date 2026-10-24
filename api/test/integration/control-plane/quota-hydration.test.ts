import { randomUUID } from 'node:crypto';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { describe, it, expect } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { workingSetPredicate } from '../../../src/control-plane/state/catalog.js';
import { readDbConfig } from '../../helpers/test-db.js';

const config = readDbConfig();
describe.skipIf(!config)('quota hydration ranking on real MySQL', () => {
  it(
    'preserves independent ID/fetch heads, NULL accounts, usable heads and earliest daily weekly observations',
    { timeout: 30000 },
    async () => {
      const admin = await mysql.createConnection(config!);
      const database = 'owner_quota_' + randomUUID().replaceAll('-', '');
      let connection: mysql.Connection | undefined;
      try {
        await admin.query('CREATE DATABASE `' + database + '`');
        for (const table of ['chatgpt_usage_snapshots', 'claude_usage_snapshots'])
          await admin.query(
            'CREATE TABLE `' +
              database +
              '`.`' +
              table +
              '` LIKE `' +
              String(config!.database).replaceAll('`', '``') +
              '`.`' +
              table +
              '`',
          );
        connection = await mysql.createConnection({ ...config!, database });
        const [[clock]] = await connection.query<RowDataPacket[]>(
          "SELECT DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS day",
        );
        const today = String(clock!.day),
          at = (hour: string) => today + 'T' + hour + ':00:00.000Z';
        const db = drizzle(connection, { schema, mode: 'default' }),
          chatgpt: Array<typeof schema.chatgptUsageSnapshots.$inferInsert> = [],
          claude: Array<typeof schema.claudeUsageSnapshots.$inferInsert> = [];
        const expectedChatgpt: number[] = [],
          expectedClaude: number[] = [];
        for (const [index, accountId] of [null, 11, 22].entries()) {
          const base = index * 100;
          const variants = [
            {
              id: 1,
              fetchedAt: '2000-01-01T00:00:00.000Z',
              status: 'ok',
              primaryLimitSeconds: 604800,
              primaryUsedPercent: 20,
            },
            {
              id: 2,
              fetchedAt: at('01'),
              status: 'rate_limited',
              primaryLimitSeconds: 604800,
              primaryUsedPercent: 0,
            },
            {
              id: 3,
              fetchedAt: at('01'),
              status: 'ok',
              secondaryLimitSeconds: 604800,
              secondaryUsedPercent: 10,
            },
            {
              id: 4,
              fetchedAt: at('00'),
              status: 'ok',
              primaryLimitSeconds: 604800,
              primaryUsedPercent: null,
            },
            {
              id: 5,
              fetchedAt: at('00'),
              status: 'error',
              secondaryLimitSeconds: 604800,
              secondaryUsedPercent: 10,
            },
            { id: 6, fetchedAt: at('04'), status: 'ok', primaryLimitSeconds: 18000, primaryUsedPercent: 40 },
            {
              id: 7,
              fetchedAt: at('04'),
              status: 'rate_limited',
              primaryLimitSeconds: 18000,
              primaryUsedPercent: 50,
            },
            { id: 8, fetchedAt: at('06'), status: 'error' },
            { id: 9, fetchedAt: at('03'), status: 'error' },
          ];
          // Account 22's earliest daily baseline exists only in the secondary window.
          if (accountId === 22)
            Object.assign(variants[1]!, {
              primaryLimitSeconds: 18000,
              secondaryLimitSeconds: 604800,
              secondaryUsedPercent: 0,
            });
          for (const row of variants)
            chatgpt.push({
              ...row,
              id: base + row.id,
              accountId,
              nextEligibleAt: at('07'),
              createdAt: row.fetchedAt,
            });
          expectedChatgpt.push(base + 2, base + 7, base + 8, base + 9);
          for (const [offset, hour] of ['05', '05', '03'].entries())
            claude.push({ id: base + offset + 1, accountId, fetchedAt: at(hour), createdAt: at(hour) });
          expectedClaude.push(base + 2, base + 3);
        }
        chatgpt.push(
          {
            id: 301,
            accountId: 99,
            status: 'error',
            fetchedAt: at('05'),
            nextEligibleAt: at('07'),
            createdAt: at('05'),
          },
          {
            id: 302,
            accountId: 99,
            status: 'error',
            fetchedAt: at('04'),
            nextEligibleAt: at('07'),
            createdAt: at('04'),
          },
        );
        expectedChatgpt.push(301, 302);
        await db.insert(schema.chatgptUsageSnapshots).values(chatgpt);
        await db.insert(schema.claudeUsageSnapshots).values(claude);
        const chatQuery = db
          .select({ id: schema.chatgptUsageSnapshots.id })
          .from(schema.chatgptUsageSnapshots)
          .where(workingSetPredicate('chatgptUsageSnapshots'));
        const claudeQuery = db
          .select({ id: schema.claudeUsageSnapshots.id })
          .from(schema.claudeUsageSnapshots)
          .where(workingSetPredicate('claudeUsageSnapshots'));
        const ids = (rows: { id: number }[]) => rows.map((row) => row.id).sort((a, b) => a - b);
        expect(ids(await chatQuery)).toEqual(expectedChatgpt);
        expect(ids(await claudeQuery)).toEqual(expectedClaude);
        for (const query of [chatQuery, claudeQuery]) {
          const compiled = query.toSQL();
          const [plan] = await connection.query<RowDataPacket[]>('EXPLAIN ' + compiled.sql, compiled.params);
          expect(plan.some((row) => String(row.select_type).includes('DEPENDENT'))).toBe(false);
        }
      } finally {
        await connection?.end();
        await admin.query('DROP DATABASE IF EXISTS `' + database + '`');
        await admin.end();
      }
    },
  );
});
