import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentBusAddresses, agentBusMessages } from '../db/schema.js';
import { ConflictError } from '../http/errors.js';
import { isEngine } from '../util/engine.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { ownedAddress, requireOwnedMessaging } from '../control-plane/state/messaging.js';
import { persistAuditLog } from './audit-log.js';
import { assertEmulationAdmission, emulationBlocks, emulationLimitError } from './quota-emulation.js';
import { quotaSnapshot } from './quota-observation.js';

/** Explicit operator retry preserves the message, account and original native session. */
export async function retryEmulatedWork(db: Database, id: string, actor: string) {
  const now = new Date().toISOString();
  const validate = (
    message:
      | Pick<
          typeof agentBusMessages.$inferSelect,
          'quotaEmulationWait' | 'status' | 'acceptedAt' | 'cancelRequestedAt' | 'expiresAt'
        >
      | undefined,
    native: string | null | undefined,
  ) => {
    if (
      !message ||
      !message.quotaEmulationWait ||
      message.status !== 'queued' ||
      message.acceptedAt ||
      message.cancelRequestedAt ||
      message.expiresAt <= now
    )
      throw new ConflictError('Message is not waiting for an emulated quota reset', 'quota_wait_unavailable');
    if (!native || native !== message.quotaEmulationWait.native_session_id)
      throw new ConflictError('Original native session is unavailable', 'quota_native_session_changed');
    return message.quotaEmulationWait;
  };
  const patch = { quotaEmulationWait: null, lastErrorCode: null, nextAttemptAt: now, updatedAt: now };
  const audit = {
    action: 'quota.emulation.retry',
    details: JSON.stringify({ message_id: id, actor }),
    createdAt: now,
  };
  const owner = ownerRuntimeFor(db);
  if (owner) {
    await mutateOwnerState(owner, {
      kind: 'quota.emulation.retry',
      payload: { id, actor },
      prepare(context) {
        requireOwnedMessaging(context.snapshot);
        const message = context.snapshot.messages.get(id);
        const target = message ? ownedAddress(context.snapshot, message.targetAddressId) : undefined;
        const waiting = validate(
          message,
          target?.continuity === 'native' ? target.lastUpstreamSessionId : null,
        );
        if (!target || !isEngine(target.engine)) throw new ConflictError('Invalid target engine');
        if (context.snapshot.accounts.get(waiting.account_id)?.state !== 'enabled')
          throw new ConflictError('Provider account is unavailable');
        assertEmulationAdmission(context.snapshot, target.engine, waiting.account_id);
        stageUpdate(context, 'agentBusMessages', id, {
          ...patch,
          quotaEmulationWait: { ...waiting, manual_resume: true, reset_at: now },
        });
        context.write((tx) => persistAuditLog(tx, audit));
        return null;
      },
    });
  } else
    await db.transaction(async (tx) => {
      const [message] = await tx
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.id, id))
        .for('update');
      const [target] = message
        ? await tx
            .select()
            .from(agentBusAddresses)
            .where(eq(agentBusAddresses.id, message.targetAddressId))
            .for('update')
        : [];
      const waiting = validate(
        message,
        target?.continuity === 'native' ? target.lastUpstreamSessionId : null,
      );
      if (!target?.enabled || !isEngine(target.engine)) throw new ConflictError('Target unavailable');
      const q = await quotaSnapshot(tx, waiting.account_id, target.engine);
      if (!q || q.account_state !== 'enabled') throw new ConflictError('Provider account is unavailable');
      if (!q.unlimited && emulationBlocks(q?.short)) throw emulationLimitError(q!.short!.resets_at!);
      await tx
        .update(agentBusMessages)
        .set({ ...patch, quotaEmulationWait: { ...waiting, manual_resume: true, reset_at: now } })
        .where(eq(agentBusMessages.id, id));
      await persistAuditLog(tx, audit);
    });
  return { message_id: id, status: 'queued' };
}
