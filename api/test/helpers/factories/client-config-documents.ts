import { eq, desc } from 'drizzle-orm';
import {
  clientConfigDocuments,
  type ClientConfigDocument,
} from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeClientConfigDocumentOverrides {
  body?: string;
  settings?: unknown;
  engine?: 'codex' | 'claude';
  sourceHostId?: number;
}

export async function makeClientConfigDocument(
  db: TestDb,
  overrides: MakeClientConfigDocumentOverrides = {},
): Promise<ClientConfigDocument> {
  const body = overrides.body ?? '# config\nmodel = "gpt-5"\n';
  const digest = sha256(body);
  const now = nowIso();

  await db.insert(clientConfigDocuments).values({
    sha256: digest,
    body,
    settings: overrides.settings ?? null,
    sourceHostId: overrides.sourceHostId ?? null,
    createdAt: now,
    updatedAt: now,
    engine: overrides.engine ?? 'codex',
  });
  const [row] = await db
    .select()
    .from(clientConfigDocuments)
    .where(eq(clientConfigDocuments.sha256, digest))
    .orderBy(desc(clientConfigDocuments.id))
    .limit(1);
  if (!row) throw new Error('makeClientConfigDocument: row not found after insert');
  return row;
}
