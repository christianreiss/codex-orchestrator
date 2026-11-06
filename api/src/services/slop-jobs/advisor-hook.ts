/**
 * Server-side capture of a Fleet Advisor answer that belongs to a full slop
 * run. Both advisor completion paths (owned command and legacy transaction)
 * call `recordSlopAdvisorReply` inside the same transaction that records the
 * turn, so the reply is durable before anyone is told. The advisor session's
 * client key is `<caller-address>:<run-id>` because the run id is the ask's
 * client_message_id; ordinary advisor sessions match no run and are untouched.
 */
import { EventEmitter } from 'node:events';
import { and, eq, isNull } from 'drizzle-orm';
import { slopRuns } from '../../db/schema.js';
import { encrypt } from '../../security/secret-box.js';
import type { Keyring } from '../../security/keyring.js';

const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Emits `reply` with the run id after a reply was staged; listeners re-read the row. */
export const slopAdvisorEvents = new EventEmitter();
slopAdvisorEvents.setMaxListeners(20);

export function slopRunIdFromClientKey(clientKey: string | null | undefined): string | null {
  const runId = clientKey?.split(':')[1];
  return runId && RUN_ID.test(runId) ? runId.toLowerCase() : null;
}

interface UpdateCapable {
  update: (table: typeof slopRuns) => {
    set: (values: Partial<typeof slopRuns.$inferInsert>) => { where: (condition: unknown) => unknown };
  };
}

export async function recordSlopAdvisorReply(
  tx: unknown,
  keyring: Keyring,
  clientKey: string | null | undefined,
  turn: number,
  result: { status: string; reply: string },
): Promise<void> {
  const runId = slopRunIdFromClientKey(clientKey);
  if (!runId || turn !== 1) return;
  await (tx as UpdateCapable)
    .update(slopRuns)
    .set({
      advisorReplyEnc: encrypt(result.reply ?? '', keyring),
      advisorReplyStatus: result.status.slice(0, 32),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(slopRuns.id, runId), eq(slopRuns.status, 'reviewing'), isNull(slopRuns.advisorReplyEnc)));
  // Listeners run after the surrounding transaction had time to commit; the
  // sweeper re-checks reviewing runs if this nudge arrives too early.
  setTimeout(() => slopAdvisorEvents.emit('reply', runId), 500).unref();
}
