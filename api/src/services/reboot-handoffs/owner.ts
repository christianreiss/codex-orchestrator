import { stagePortalEvent } from '../../control-plane/state/portal-events.js';
import { agentRebootHandoffs } from '../../db/schema.js';
import type { Keyring } from '../../security/keyring.js';
import { encrypt } from '../../security/secret-box.js';
import { sha256 } from '../../security/hash.js';
import { NotFoundError } from '../../http/errors.js';
import { nowIso, isoOffsetSeconds } from '../../util/timestamp.js';
import {
  mutateOwnerState,
  type OwnerRuntime,
  type OwnerMutationContext,
} from '../../control-plane/state/runtime.js';
import type { StateRow } from '../../control-plane/state/catalog.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { assertNoOwnedRecovery } from '../../control-plane/state/reboot.js';
import { ownedSessionAuthority } from '../../control-plane/streams/receiver.js';
import { active, fail, prepareSchema } from './policy.js';

type Handoff = Readonly<StateRow<'agentRebootHandoffs'>>;
export function ownedHandoffView(r: Handoff) {
  return {
    request_id: r.id,
    engine: r.engine,
    native_session_id: r.nativeSessionId,
    session_id: r.oldSessionId,
    resumed_session_id: r.newSessionId,
    address: `agent:${r.addressId}`,
    cwd: r.cwd,
    boot_id: r.bootId,
    reason: r.reason,
    state: r.status,
    expires_at: r.expiresAt,
    message_ids: [...r.busMessageIds, ...r.portalMessageIds],
  };
}
function get(context: OwnerMutationContext, id: string, hostId?: number, sessionId?: string) {
  const r = context.draft.table('agentRebootHandoffs').get(id);
  if (
    !r ||
    (hostId !== undefined && r.hostId !== hostId) ||
    (sessionId !== undefined && r.oldSessionId !== sessionId)
  )
    throw new NotFoundError('Reboot handoff not found');
  return r;
}
export function stageExpireOwnedHandoff(context: OwnerMutationContext, r: Handoff, now: string) {
  for (const id of r.busMessageIds) {
    const m = context.draft.table('agentBusMessages').get(id);
    if (m?.status === 'reboot_hold')
      stageUpdate(context, 'agentBusMessages', id, {
        status: 'ambiguous',
        lastErrorCode: 'reboot_handoff_expired',
        ambiguousAt: now,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: now,
      });
  }
  for (const id of r.portalMessageIds) {
    const m = context.draft.table('agentMessages').by('messageId', id)[0];
    if (m?.status === 'reboot_hold')
      stageUpdate(context, 'agentMessages', m.id, {
        status: 'dead',
        lastError: 'Reboot handoff expired without a result',
        updatedAt: now,
      });
  }
  const remote = context.draft.table('hostDaemonPortalBindings').get(r.oldSessionId);
  if (remote) {
    for (const op of context.draft.table('hostDaemonOperations').all())
      if (op.sessionId === remote.daemonSessionId && op.status === 'reboot_hold')
        stageUpdate(context, 'hostDaemonOperations', op.id, { status: 'unknown', updatedAt: now });
    const session = context.draft.table('hostDaemonSessions').get(remote.daemonSessionId);
    if (session?.status === 'running')
      stageUpdate(context, 'hostDaemonSessions', session.id, { status: 'waiting', lastActivityAt: now });
  }
  stageUpdate(context, 'agentRebootHandoffs', r.id, {
    status: 'expired',
    activeHostId: null,
    updatedAt: now,
  });
}
export async function prepareOwnedReboot(
  runtime: OwnerRuntime,
  keyring: Keyring,
  sessionId: string,
  token: string,
  raw: unknown,
) {
  const v = prepareSchema.parse(raw),
    hash = sha256(JSON.stringify(v));
  return mutateOwnerState(runtime, {
    kind: 'reboot.prepare',
    payload: { sessionId, requestId: v.request_id, hash },
    authorize: (s) => {
      ownedSessionAuthority(s, sessionId, token);
    },
    prepare: (context) => {
      const now = nowIso(),
        session = context.draft.table('agentSessions').get(sessionId)!;
      if (!session.agentBusAddressId || !session.upstreamSessionId || session.closeRequestedAt)
        throw fail('Current native binding is unavailable');
      if ((session.adapterCapabilities as Record<string, unknown> | null)?.reboot_protocol_version !== 1)
        throw fail('Wrapper upgrade required for planned reboot');
      const address = context.draft.table('agentBusAddresses').get(session.agentBusAddressId);
      if (
        !address ||
        address.currentSessionId !== sessionId ||
        address.bindingGeneration !== session.bindingGeneration ||
        address.lastUpstreamSessionId !== session.upstreamSessionId
      )
        throw fail('Native binding changed');
      const existing = context.draft.table('agentRebootHandoffs').get(v.request_id);
      if (existing) {
        if (existing.oldSessionId !== sessionId || existing.requestSha !== hash)
          throw fail('Request ID reused with different input');
        return { ...ownedHandoffView(existing), continuation: v.continuation };
      }
      assertNoOwnedRecovery(context, address.id);
      const rows = context.draft.table('agentRebootHandoffs').all();
      if (rows.some((r) => r.activeHostId === session.hostId))
        throw fail('This host already has a planned reboot');
      if (
        rows.some(
          (r) =>
            r.hostId === session.hostId &&
            r.engine === session.engine &&
            r.nativeSessionId === session.upstreamSessionId &&
            r.resumeBootId !== null,
        )
      )
        throw fail('This native session already consumed a reboot; automatic rearming is forbidden');
      const row = {
        id: v.request_id,
        hostId: session.hostId,
        activeHostId: session.hostId,
        addressId: address.id,
        oldSessionId: sessionId,
        newSessionId: null,
        engine: session.engine,
        username: session.username,
        cwd: session.cwd,
        nativeSessionId: session.upstreamSessionId,
        bootId: v.boot_id,
        resumeBootId: null,
        requestSha: hash,
        continuationEnc: encrypt(v.continuation, keyring),
        reason: v.reason,
        status: 'prepared',
        busMessageIds: [] as string[],
        portalMessageIds: [] as string[],
        expiresAt: isoOffsetSeconds(86400),
        createdAt: now,
        updatedAt: now,
      };
      context.draft.upsert('agentRebootHandoffs', row);
      context.write(async (tx) => {
        await tx.insert(agentRebootHandoffs).values(row);
      });
      return { ...ownedHandoffView(row), continuation: v.continuation };
    },
  });
}
export async function armOwnedReboot(
  runtime: OwnerRuntime,
  keyring: Keyring,
  sessionId: string,
  requestId: string,
) {
  return mutateOwnerState(runtime, {
    kind: 'reboot.arm',
    payload: { sessionId, requestId },
    prepare: (context) => {
      const r = get(context, requestId, undefined, sessionId);
      if (r.status === 'armed') return ownedHandoffView(r);
      const now = nowIso();
      if (r.status !== 'prepared' || r.expiresAt <= now) throw fail('Reboot handoff is no longer prepared');
      const session = context.draft.table('agentSessions').get(sessionId),
        address = context.draft.table('agentBusAddresses').get(r.addressId);
      if (
        !session ||
        session.endedAt ||
        session.closeRequestedAt ||
        address?.currentSessionId !== sessionId ||
        session.upstreamSessionId !== r.nativeSessionId
      )
        throw fail('Native binding changed before arm');
      assertNoOwnedRecovery(context, r.addressId);
      const bus = context.draft
        .table('agentBusMessages')
        .by('targetAddressId', r.addressId)
        .filter((m) => m.status === 'accepted');
      if (
        bus.some(
          (m) =>
            !m.claimId ||
            m.cancelRequestedAt ||
            (m.leaseOwner !== `session:${sessionId}` && m.deliverySessionId !== sessionId),
        )
      )
        throw fail('An accepted delivery belongs to another process');
      const portal = session.activeTurnId
        ? context.draft
            .table('agentMessages')
            .all()
            .filter(
              (m) =>
                m.sessionId === sessionId && m.status === 'accepted' && m.upstreamId === session.activeTurnId,
            )
        : [];
      if (portal.some((m) => m.kind === 'close')) throw fail('An operator stop prevents reboot');
      const updated = stageUpdate(context, 'agentRebootHandoffs', r.id, {
        status: 'armed',
        busMessageIds: bus.map((m) => m.id),
        portalMessageIds: portal.map((m) => m.messageId),
        updatedAt: now,
      });
      for (const m of bus)
        stageUpdate(context, 'agentBusMessages', m.id, {
          status: 'reboot_hold',
          leaseUntil: null,
          ownershipMode: 'connection',
          updatedAt: now,
        });
      for (const m of portal)
        stageUpdate(context, 'agentMessages', m.id, { status: 'reboot_hold', updatedAt: now });
      const remote = context.draft.table('hostDaemonPortalBindings').get(sessionId);
      if (remote)
        for (const op of context.draft.table('hostDaemonOperations').all())
          if (op.sessionId === remote.daemonSessionId && op.status === 'accepted')
            stageUpdate(context, 'hostDaemonOperations', op.id, { status: 'reboot_hold', updatedAt: now });
      stageUpdate(context, 'agentSessions', sessionId, {
        status: 'reboot_wait',
        bridgeExpiresAt: r.expiresAt,
        updatedAt: now,
      });
      stagePortalEvent(context, {
        sessionId,
        clientEventId: `reboot:${r.id}`,
        eventType: 'progress',
        source: 'bridge',
        payloadEnc: encrypt(
          JSON.stringify({
            text: `Planned reboot: ${r.reason}`,
            reboot_request_id: r.id,
            reboot_state: 'armed',
          }),
          keyring,
        ),
        createdAt: now,
      });
      return ownedHandoffView(updated);
    },
  });
}
export async function finishOwnedReboot(
  runtime: OwnerRuntime,
  keyring: Keyring,
  hostId: number,
  requestId: string,
  failed: boolean,
  report?: { status: string; summary: string },
) {
  return mutateOwnerState(runtime, {
    kind: 'reboot.finish',
    payload: { hostId, requestId, failed, report: report ?? null },
    prepare: (context) => {
      const r = get(context, requestId, hostId);
      if (['finished', 'failed'].includes(r.status)) return ownedHandoffView(r);
      const now = nowIso();
      for (const id of r.busMessageIds) {
        const m = context.draft.table('agentBusMessages').get(id);
        if (m && ['accepted', 'reboot_hold'].includes(m.status))
          stageUpdate(context, 'agentBusMessages', id, {
            status: 'ambiguous',
            lastErrorCode: 'reboot_resume_without_result',
            ambiguousAt: now,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          });
      }
      for (const id of r.portalMessageIds) {
        const m = context.draft.table('agentMessages').by('messageId', id)[0];
        if (m?.status === 'reboot_hold')
          stageUpdate(context, 'agentMessages', m.id, {
            status: 'dead',
            lastError: 'Reboot continuation failed before binding',
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          });
      }
      const remote = context.draft.table('hostDaemonPortalBindings').get(r.oldSessionId);
      if (remote) {
        const status =
          report?.status === 'succeeded' ? 'completed' : report?.status === 'failed' ? 'failed' : 'unknown';
        for (const op of context.draft.table('hostDaemonOperations').all())
          if (op.sessionId === remote.daemonSessionId && op.status === 'reboot_hold')
            stageUpdate(context, 'hostDaemonOperations', op.id, {
              status,
              resultEnc: encrypt(
                JSON.stringify({
                  status,
                  reply:
                    report?.summary ??
                    'Planned reboot continuation ended without an explicit result; see linked native transcript.',
                }),
                keyring,
              ),
              updatedAt: now,
            });
        const session = context.draft.table('hostDaemonSessions').get(remote.daemonSessionId);
        if (session?.status === 'running')
          stageUpdate(context, 'hostDaemonSessions', session.id, { status: 'waiting', lastActivityAt: now });
      }
      return ownedHandoffView(
        stageUpdate(context, 'agentRebootHandoffs', r.id, {
          status: failed ? 'failed' : 'finished',
          activeHostId: null,
          updatedAt: now,
        }),
      );
    },
  });
}
export async function disarmOwnedReboot(runtime: OwnerRuntime, hostId: number, requestId: string) {
  return mutateOwnerState(runtime, {
    kind: 'reboot.disarm',
    payload: { hostId, requestId },
    prepare: (context) => {
      const r = get(context, requestId, hostId);
      if (r.status === 'disarmed') return ownedHandoffView(r);
      if (!active.includes(r.status)) throw fail('Only an unconsumed reboot can be disarmed');
      const now = nowIso();
      stageExpireOwnedHandoff(context, r, now);
      return ownedHandoffView(
        stageUpdate(context, 'agentRebootHandoffs', r.id, { status: 'disarmed', expiresAt: now }),
      );
    },
  });
}
