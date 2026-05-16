import { eq, desc } from 'drizzle-orm';
import {
  tokenUsages,
  tokenUsageIngests,
  type Host,
} from '../../../src/db/schema.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeTokenUsageIngestOverrides {
  entries?: number;
  total?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  clientIp?: string;
  payload?: string;
  engine?: 'codex' | 'claude';
}

export async function makeTokenUsageIngest(
  db: TestDb,
  host: Host,
  overrides: MakeTokenUsageIngestOverrides = {},
) {
  const now = nowIso();
  await db.insert(tokenUsageIngests).values({
    hostId: host.id,
    entries: overrides.entries ?? 1,
    total: overrides.total ?? 100,
    inputTokens: overrides.inputTokens ?? 70,
    outputTokens: overrides.outputTokens ?? 30,
    cachedTokens: overrides.cachedTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    clientIp: overrides.clientIp ?? '127.0.0.1',
    payload: overrides.payload ?? null,
    createdAt: now,
    engine: overrides.engine ?? 'codex',
  });
  const [row] = await db
    .select()
    .from(tokenUsageIngests)
    .where(eq(tokenUsageIngests.hostId, host.id))
    .orderBy(desc(tokenUsageIngests.id))
    .limit(1);
  if (!row) throw new Error('makeTokenUsageIngest: row not found');
  return row;
}

export interface MakeTokenUsageOverrides {
  ingestId?: number;
  total?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  model?: string;
  line?: string;
  engine?: 'codex' | 'claude';
}

export async function makeTokenUsage(
  db: TestDb,
  host: Host,
  overrides: MakeTokenUsageOverrides = {},
) {
  const now = nowIso();
  await db.insert(tokenUsages).values({
    hostId: host.id,
    ingestId: overrides.ingestId ?? null,
    total: overrides.total ?? 100,
    inputTokens: overrides.inputTokens ?? 70,
    outputTokens: overrides.outputTokens ?? 30,
    cachedTokens: overrides.cachedTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    model: overrides.model ?? 'gpt-5',
    line: overrides.line ?? null,
    createdAt: now,
    engine: overrides.engine ?? 'codex',
  });
  const [row] = await db
    .select()
    .from(tokenUsages)
    .where(eq(tokenUsages.hostId, host.id))
    .orderBy(desc(tokenUsages.id))
    .limit(1);
  if (!row) throw new Error('makeTokenUsage: row not found');
  return row;
}
