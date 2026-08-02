/**
 * Ensure a fresh orchestrator can serve a useful fleet policy immediately and
 * migrate the one known production legacy document into structured builder
 * provenance without touching arbitrary operator-authored Markdown.
 */
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentsDocuments } from '../db/schema.js';
import { AgentsService } from '../services/agents.js';
import { defaultAgentPolicyComposition } from '../services/agent-policy-composer.js';

export const LEGACY_V55_SHA256 = '6ee7638f7996281bc011a0db8bca6d74c06cbbe6d188d7731cc673b8c7e23b7e';

export interface AgentPolicyBootstrapResult {
  status: 'created_default' | 'converted_v55' | 'already_builder' | 'legacy_untouched';
  version_id?: number;
}

export async function ensureAgentPolicy(db: Database): Promise<AgentPolicyBootstrapResult> {
  const latest = await db
    .select()
    .from(agentsDocuments)
    .where(eq(agentsDocuments.engine, 'codex'))
    .orderBy(desc(agentsDocuments.id))
    .limit(1);
  const row = latest[0] ?? null;
  const service = new AgentsService(db);

  if (!row) {
    const stored = await service.storeComposition(defaultAgentPolicyComposition());
    return { status: 'created_default', version_id: stored.version_id };
  }
  if (row.builderState !== null) return { status: 'already_builder', version_id: row.id };
  if (row.sha256 !== LEGACY_V55_SHA256) return { status: 'legacy_untouched', version_id: row.id };

  const stored = await service.storeComposition(defaultAgentPolicyComposition());
  return { status: 'converted_v55', version_id: stored.version_id };
}
