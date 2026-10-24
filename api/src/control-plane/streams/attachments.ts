import { and, eq, inArray } from 'drizzle-orm';
import { agentEvents } from '../../db/schema.js';
import type { OwnerMutationContext } from '../state/runtime.js';
import { stageUpdate } from '../state/rows.js';
import { ForbiddenError, ValidationError } from '../../http/errors.js';
import type { ChatMetadata } from '../../services/agent-chat/contracts.js';

/** Compose with the caller's command; linking never starts a nested transaction. */
export function stageAttachmentLink(
  context: OwnerMutationContext,
  originalSessionId: string,
  metadata: ChatMetadata,
  maxTotalBytes: number,
  owner?: string,
) {
  const binding = context.draft.table('hostDaemonPortalBindings').get(originalSessionId);
  const sessionId = binding?.daemonSessionId ?? originalSessionId;
  if (owner?.startsWith('agent:')) owner = `agent:${sessionId}`;
  if (metadata.reply_to) {
    const ids = [
      originalSessionId,
      ...context.draft
        .table('hostDaemonPortalBindings')
        .by('daemonSessionId', sessionId)
        .map((b) => b.portalSessionId),
    ];
    // The event body/history stays cold. This finite reply validation is scoped
    // to one exact event and the already-authorized conversation binding.
    context.write(async (tx) => {
      const [event] = await tx
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .where(and(inArray(agentEvents.sessionId, ids), eq(agentEvents.id, metadata.reply_to!)))
        .limit(1);
      if (!event) throw new ValidationError('Reply target is outside this conversation');
    });
  }
  const ids = [...new Set(metadata.attachments ?? [])];
  if (!ids.length) return;
  const rows = ids.map((id) => context.draft.table('agentChatAttachments').get(id));
  if (
    rows.some(
      (row) =>
        !row ||
        row.sessionId !== sessionId ||
        !['ready', 'linked'].includes(row.status) ||
        (owner && row.owner !== owner),
    )
  )
    throw new ForbiddenError('Attachment is unavailable or belongs to another sender');
  if (rows.reduce((sum, row) => sum + row!.sizeBytes, 0) > maxTotalBytes)
    throw new ValidationError('Attachments exceed total limit');
  for (const row of rows)
    if (row!.status !== 'linked') stageUpdate(context, 'agentChatAttachments', row!.id, { status: 'linked' });
}
