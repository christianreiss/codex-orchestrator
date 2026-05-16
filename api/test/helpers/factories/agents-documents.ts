import { eq, desc } from 'drizzle-orm';
import {
  agentsDocuments,
  agentsDocumentState,
  type AgentsDocument,
} from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeAgentsDocumentOverrides {
  body?: string;
  engine?: 'codex' | 'claude';
  sourceHostId?: number;
  /** Also write/upsert the agents_document_state singleton pointing at this doc. */
  setActive?: boolean;
  mode?: 'auto' | 'pinned';
}

export async function makeAgentsDocument(
  db: TestDb,
  overrides: MakeAgentsDocumentOverrides = {},
): Promise<AgentsDocument> {
  const body = overrides.body ?? `# AGENTS\n\nTest doc ${Math.random().toString(36).slice(2, 8)}\n`;
  const digest = sha256(body);
  const engine = overrides.engine ?? 'codex';
  const now = nowIso();

  await db.insert(agentsDocuments).values({
    sha256: digest,
    body,
    sourceHostId: overrides.sourceHostId ?? null,
    createdAt: now,
    updatedAt: now,
    engine,
  });
  const [doc] = await db
    .select()
    .from(agentsDocuments)
    .where(eq(agentsDocuments.sha256, digest))
    .orderBy(desc(agentsDocuments.id))
    .limit(1);
  if (!doc) throw new Error('makeAgentsDocument: row not found after insert');

  if (overrides.setActive) {
    const mode = overrides.mode ?? 'auto';
    // PK on agents_document_state.id = 1 (singleton). Try INSERT; on dup, update.
    try {
      await db.insert(agentsDocumentState).values({
        id: 1,
        mode,
        activeDocumentId: doc.id,
        createdAt: now,
        updatedAt: now,
        engine,
      });
    } catch {
      await db
        .update(agentsDocumentState)
        .set({ mode, activeDocumentId: doc.id, updatedAt: now, engine })
        .where(eq(agentsDocumentState.id, 1));
    }
  }
  return doc;
}
