import { and, eq } from 'drizzle-orm';
import { mcpMemories, type Host } from '../../../src/db/schema.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeMcpMemoryOverrides {
  memoryKey?: string;
  content?: string;
  metadata?: unknown;
  tags?: unknown;
  tagsText?: string;
  summary?: string;
  engine?: 'codex' | 'claude' | null;
}

export async function makeMcpMemory(
  db: TestDb,
  host: Host,
  overrides: MakeMcpMemoryOverrides = {},
) {
  const memoryKey =
    overrides.memoryKey ?? `mem-${Math.random().toString(36).slice(2, 10)}`;
  const now = nowIso();

  await db.insert(mcpMemories).values({
    hostId: host.id,
    memoryKey,
    content: overrides.content ?? 'test memory content',
    metadata: overrides.metadata ?? null,
    tags: overrides.tags ?? null,
    tagsText: overrides.tagsText ?? null,
    summary: overrides.summary ?? null,
    createdAt: now,
    updatedAt: now,
    engine: overrides.engine ?? null,
  });

  const [row] = await db
    .select()
    .from(mcpMemories)
    .where(and(eq(mcpMemories.hostId, host.id), eq(mcpMemories.memoryKey, memoryKey)))
    .limit(1);
  if (!row) throw new Error('makeMcpMemory: row not found after insert');
  return row;
}
