import { agentsDocumentState } from '../../db/schema.js';
import type { OwnerStateSnapshot } from './store.js';
import type { OwnerMutationContext } from './runtime.js';
import { stageDelete, stageUpdate } from './rows.js';
import { ValidationError } from '../../http/errors.js';
import type { Engine } from '../../util/engine.js';

export const agentDocumentStateId = (engine: Engine) => ({ codex: 1, claude: 2, grok: 3 })[engine];
export function servedAgentDocument(state: OwnerStateSnapshot, engine: Engine, override?: number | null) {
  const docs = state.table('agentsDocuments'),
    pin = override ? docs.get(override) : undefined;
  if (pin) return pin;
  const mode = state.table('agentsDocumentState').get(agentDocumentStateId(engine));
  const active =
    mode?.mode === 'locked' && mode.activeDocumentId ? docs.get(mode.activeDocumentId) : undefined;
  if (active?.engine === engine) return active;
  const ordered = [...docs.all()].sort((a, b) => b.id - a.id);
  return ordered.find((row) => row.engine === engine) ?? ordered[0];
}
export function stageAgentDocumentMode(
  ctx: OwnerMutationContext,
  engine: Engine,
  mode: string,
  activeDocumentId: number | null,
) {
  const id = agentDocumentStateId(engine),
    now = new Date().toISOString();
  if (
    mode === 'locked' &&
    (!activeDocumentId || ctx.draft.table('agentsDocuments').get(activeDocumentId)?.engine !== engine)
  )
    throw new ValidationError('version_id belongs to another engine or is missing', { param: 'version_id' });
  const existing = ctx.draft.table('agentsDocumentState').get(id);
  if (existing) stageUpdate(ctx, 'agentsDocumentState', id, { mode, activeDocumentId, updatedAt: now });
  else {
    const row = { id, mode, activeDocumentId, engine, createdAt: now, updatedAt: now };
    ctx.draft.upsert('agentsDocumentState', row);
    ctx.write(async (tx) => tx.insert(agentsDocumentState).values(row));
  }
}
export function pruneAgentDocuments(
  ctx: OwnerMutationContext,
  limit: number,
  protectId: number | null,
): number {
  const protectedIds = new Set<number>(protectId === null ? [] : [protectId]);
  for (const state of ctx.draft.table('agentsDocumentState').all())
    if (state.mode === 'locked' && state.activeDocumentId) protectedIds.add(state.activeDocumentId);
  for (const host of ctx.draft.table('hosts').all())
    if (host.agentsDocumentIdOverride) protectedIds.add(host.agentsDocumentIdOverride);
  const eligible = [...ctx.draft.table('agentsDocuments').all()]
    .filter((row) => !protectedIds.has(row.id))
    .sort((a, b) => b.id - a.id);
  for (const row of eligible.slice(limit)) stageDelete(ctx, 'agentsDocuments', row.id);
  return Math.max(0, eligible.length - limit);
}
