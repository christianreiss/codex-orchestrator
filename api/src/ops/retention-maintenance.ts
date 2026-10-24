/** Offline activation/compaction only. Online deletion belongs to the owner worker. */
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../env.js';
import { createDb } from '../db/client.js';
import { versions } from '../db/schema.js';
import { acquireOfflineDatabase } from './offline-database.js';
import { coldPreview } from '../services/server-retention/cold.js';
import { parseServerRetention, RETENTION_POLICY_KEY, RETENTION_RUN_KEY } from '../services/server-retention/policy.js';

const args = new Set(process.argv.slice(2));
for (const arg of args) if (!['--preview','--activate','--compact','--no-backup'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
if (!args.has('--preview') && !args.has('--activate') && !args.has('--compact')) throw new Error('Use --preview, --activate or --compact --no-backup');
if ((args.has('--activate') || args.has('--compact')) && !args.has('--no-backup')) throw new Error('Explicit --no-backup is required for maintenance');
const env = loadEnv(), { db, pool } = createDb(env);
let offline: Awaited<ReturnType<typeof acquireOfflineDatabase>> | undefined;
try {
  const write = args.has('--activate') || args.has('--compact');
  if (write) offline = await acquireOfflineDatabase(pool, env.DB_DATABASE);
  const handle = offline?.db ?? db;
  const [stored] = await handle.select().from(versions).where(eq(versions.name, RETENTION_POLICY_KEY));
  const policy = parseServerRetention(stored?.version);
  if (args.has('--preview')) process.stdout.write(JSON.stringify(await coldPreview(handle, policy))+'\n');
  if (args.has('--activate')) {
    await handle.transaction(async tx => {
      const at = new Date().toISOString();
      const row = { name: RETENTION_POLICY_KEY, version: JSON.stringify({ ...policy, armed: true }), updatedAt: at };
      await tx.insert(versions).values(row).onDuplicateKeyUpdate({ set: { version: row.version, updatedAt: at } });
      const [previous] = await tx.select().from(versions).where(eq(versions.name, RETENTION_RUN_KEY));
      const run = JSON.parse(previous?.version ?? '{}') as { status?: string };
      if (run.status !== 'running') {
        const start = { name: RETENTION_RUN_KEY, version: JSON.stringify({ id: randomUUID(), status: 'running', started_at: at, families: {}, counts: {} }), updatedAt: at };
        await tx.insert(versions).values(start).onDuplicateKeyUpdate({ set: { version: start.version, updatedAt: at } });
      }
    });
    process.stdout.write('Retention activated; the next API owner will resume the recorded guarded run. No backup created.\n');
  }
  if (args.has('--compact')) {
    const [row] = await handle.select().from(versions).where(eq(versions.name, RETENTION_RUN_KEY));
    const status = JSON.parse(row?.version ?? '{}') as { status?: string; counts?: Record<string, number> };
    if (status.status !== 'completed') throw new Error('A completed, recorded retention run is required before compaction');
    const counts = status.counts ?? {}, tables: string[] = [];
    if (counts.auditlogs) tables.push('logs');
    if (counts.adminaudit) tables.push('admin_events');
    if (counts.conversations) tables.push('agent_bus_messages');
    if (counts.receipts) tables.push('control_plane_command_receipts');
    if (counts.quota) tables.push('chatgpt_usage_snapshots','claude_usage_snapshots','dashboard_graph_quota_snapshots','dashboard_graph_claude_quota_snapshots');
    for (const table of tables) {
      const [rows] = await handle.execute(sql`OPTIMIZE TABLE ${sql.identifier(table)}`);
      const outcomes = rows as unknown as Array<{ Msg_type: string; Msg_text: string }>;
      if (outcomes.some(r => r.Msg_type === 'error')) throw new Error(`Compaction failed for ${table}`);
      process.stdout.write(`Compacted ${table}\n`);
    }
    if (!tables.length) process.stdout.write('No tables with recorded deletions require compaction.\n');
  }
} finally { await offline?.close(); await pool.end(); }
