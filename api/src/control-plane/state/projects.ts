import { boundedProjectEvents } from './project-history.js';
import { coordProjectEvents } from '../../db/schema.js';
import type { OwnerMutationContext } from './runtime.js';
import { stageUpdate } from './rows.js';
import { NotFoundError } from '../../http/errors.js';
/** Project mutation and audit sequence share the enclosing owner transaction. */
export function stageProjectEvent(
  ctx: OwnerMutationContext,
  projectId: number,
  eventType: string,
  action: string,
  entityType: string | null,
  entityId: number | string | null,
  payload: Record<string, unknown> | null,
  sourceHostId: number | null,
): { seq: number; id: number } {
  const project = ctx.draft.table('coordProjects').get(projectId);
  if (!project) throw new NotFoundError('Project not found', 'project_not_found');
  const now = new Date().toISOString(),
    event = { seq: project.latestEventSeq + 1, id: 0 };
  stageUpdate(ctx, 'coordProjects', projectId, { latestEventSeq: event.seq, updatedAt: now });
  ctx.write(async (tx) => {
    const inserted = await tx
      .insert(coordProjectEvents)
      .values({
        projectId,
        seq: event.seq,
        eventType,
        action,
        entityType,
        entityId: entityId === null ? null : String(entityId),
        payloadJson: payload,
        sourceHostId,
        createdAt: now,
      });
    event.id = Number(inserted[0].insertId);
    const current = ctx.draft.table('coordProjects').get(projectId)!;
    ctx.draft.upsert('coordProjects', {
      ...current,
      recentEvents: boundedProjectEvents([
        {
          id: event.id,
          projectId,
          seq: event.seq,
          eventType,
          action,
          entityType,
          entityId: entityId === null ? null : String(entityId),
          payloadJson: payload,
          sourceHostId,
          createdAt: now,
        },
        ...current.recentEvents,
      ]),
    });
  });
  return event;
}
