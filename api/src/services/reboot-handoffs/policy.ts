import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { agentRebootHandoffs, agentSchedules, agentWatchdogs } from '../../db/schema.js';
import { ConflictError } from '../../http/errors.js';
import type { AgentMessagingDb } from '../agent-messaging/types.js';

export type Handoff = typeof agentRebootHandoffs.$inferSelect;
export const active = ['prepared', 'armed'];
export const prepareSchema = z
  .object({
    request_id: z.string().uuid(),
    boot_id: z.string().uuid(),
    reason: z.string().trim().min(1).max(1000),
    continuation: z.string().trim().min(1).max(32768),
  })
  .strict();
export const fail = (message: string) => new ConflictError(message, 'reboot_handoff_conflict');

export async function assertNoRebootRecovery(db: AgentMessagingDb, addressId: string) {
  const runtime = ownerRuntimeFor(db);
  if (runtime) {
    runtime.assertOwner();
    if (
      runtime.state
        .snapshot()
        .table('agentRebootHandoffs')
        .all()
        .some((r) => r.addressId === addressId && active.includes(r.status))
    )
      throw fail('A planned reboot already owns this session; recovery cannot be enabled');
    return;
  }
  const [row] = await db
    .select()
    .from(agentRebootHandoffs)
    .where(and(eq(agentRebootHandoffs.addressId, addressId), inArray(agentRebootHandoffs.status, active)))
    .limit(1);
  if (row) throw fail('A planned reboot already owns this session; recovery cannot be enabled');
}
export async function noCompetingRecovery(db: AgentMessagingDb, addressId: string) {
  const runtime = ownerRuntimeFor(db);
  if (runtime) {
    runtime.assertOwner();
    const s = runtime.state.snapshot();
    if (
      s
        .table('agentSchedules')
        .all()
        .some(
          (r) => r.targetAddressId === addressId && r.enabled === 1 && r.persistent === 1 && !r.deletedAt,
        ) ||
      s
        .table('agentWatchdogs')
        .all()
        .some(
          (r) =>
            r.targetAddressId === addressId && ['watching', 'recovering', 'capacity_wait'].includes(r.status),
        )
    )
      throw fail('Disable competing watchdog/persistent Wake recovery before preparing a reboot');
    return;
  }
  const [schedule] = await db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.targetAddressId, addressId),
        eq(agentSchedules.enabled, 1),
        eq(agentSchedules.persistent, 1),
        isNull(agentSchedules.deletedAt),
      ),
    )
    .limit(1);
  const [watchdog] = await db
    .select()
    .from(agentWatchdogs)
    .where(
      and(
        eq(agentWatchdogs.targetAddressId, addressId),
        inArray(agentWatchdogs.status, ['watching', 'recovering', 'capacity_wait']),
      ),
    )
    .limit(1);
  if (schedule || watchdog)
    throw fail('Disable competing watchdog/persistent Wake recovery before preparing a reboot');
}
export async function plannedRebootForSession(db: AgentMessagingDb, sessionId: string) {
  const runtime = ownerRuntimeFor(db);
  if (runtime) {
    runtime.assertOwner();
    return (
      runtime.state
        .snapshot()
        .table('agentRebootHandoffs')
        .all()
        .find((r) => r.oldSessionId === sessionId && r.status === 'armed') ?? null
    );
  }
  const [row] = await db
    .select()
    .from(agentRebootHandoffs)
    .where(and(eq(agentRebootHandoffs.oldSessionId, sessionId), eq(agentRebootHandoffs.status, 'armed')))
    .limit(1);
  return row ?? null;
}
