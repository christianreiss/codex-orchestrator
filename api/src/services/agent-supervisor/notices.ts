import { randomUUID } from 'node:crypto';
import type { OwnerMutationContext } from '../../control-plane/state/runtime.js';
import { stagePortalEvent } from '../../control-plane/state/portal-events.js';
import { adminAudit } from '../../control-plane/state/admin.js';
import { agentChatNotices } from '../../db/schema.js';
import { encrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';

/** Caller commits the incident's terminal marker in the same transaction. */
export function stageSupervisorAttention(
  ctx: OwnerMutationContext,
  keyring: Keyring,
  input: { sessionId: string; target: string; taskKey: string; reason: string },
  at: string,
) {
  const noticeId = randomUUID();
  const payloadEnc = encrypt(
    JSON.stringify({
      notice_id: noticeId,
      severity: 'important',
      summary: `Task supervision needs attention: ${input.reason.replaceAll('_', ' ')}`,
      content: `${input.target}, task ${input.taskKey}: ${input.reason}. Automatic intervention has stopped. Inspect the retained native session and original work receipts before continuing.`,
    }),
    keyring,
  );
  if (ctx.draft.table('agentSessions').has(input.sessionId)) {
    const event = stagePortalEvent(ctx, {
      sessionId: input.sessionId,
      clientEventId: noticeId,
      eventType: 'attention',
      source: 'server',
      payloadEnc,
      createdAt: at,
    });
    ctx.write(async (tx) => {
      const row = {
        id: noticeId,
        sessionId: input.sessionId,
        severity: 'important',
        payloadEnc,
        eventId: event.id,
        resolvedAt: null,
        createdAt: at,
      };
      await tx.insert(agentChatNotices).values(row);
      ctx.draft.upsert('agentChatNotices', row);
    });
  }
  adminAudit(
    ctx,
    'supervisor.attention',
    { target: input.target, reason: input.reason, task_key: input.taskKey },
    at,
  );
}
