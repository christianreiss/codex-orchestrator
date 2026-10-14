/** Planned reboot transfers accepted execution without redelivery. */
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agentRebootHandoffs,
  agentSessions,
  agentBusAddresses,
  agentBusMessages,
  agentMessages,
  agentEvents,
  hostDaemonOperations,
  hostDaemonSessions,
  hostDaemonPortalBindings,
  hosts,
  versions,
} from '../db/schema.js';
import { AGENT_MESSAGING_ENABLED_KEY } from './agent-messaging/constants.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt, decrypt } from '../security/secret-box.js';
import { sha256 } from '../security/hash.js';
import { NotFoundError } from '../http/errors.js';
import { nowIso, isoOffsetSeconds } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { active, fail, noCompetingRecovery, prepareSchema, type Handoff } from './reboot-handoffs/policy.js';
import { expireRebootHandoffs } from './reboot-handoffs/binding.js';
export { assertNoRebootRecovery, plannedRebootForSession } from './reboot-handoffs/policy.js';
export {
  beginRebootBinding,
  completeRebootBinding,
  expireRebootHandoffs,
} from './reboot-handoffs/binding.js';

export class RebootHandoffs {
  constructor(
    private readonly db: Database,
    private readonly keyring: Keyring,
  ) {}
  async prepare(sessionId: string, token: string, raw: unknown) {
    const v = prepareSchema.parse(raw),
      now = nowIso(),
      hash = sha256(JSON.stringify(v));
    const row = await this.db.transaction(async (tx) => {
      // Serialise with messaging (agent_messaging_enabled row), then lock
      // address -> host -> session so this cannot deadlock against a send or
      // an activity report. The unlocked read only picks rows; the checks
      // below run on locked data.
      await tx.select({ name: versions.name }).from(versions).where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY)).for('update');
      const [owner] = await tx
        .select({ hostId: agentSessions.hostId, addressId: agentSessions.agentBusAddressId })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId));
      if (owner?.addressId)
        await tx.select({ id: agentBusAddresses.id }).from(agentBusAddresses).where(eq(agentBusAddresses.id, owner.addressId)).for('update');
      if (owner) await tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, owner.hostId)).for('update');
      const [session] = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .for('update');
      if (
        !session ||
        session.endedAt ||
        session.bridgeTokenHash !== sha256(token) ||
        session.bridgeExpiresAt <= now ||
        !session.agentBusAddressId ||
        !session.upstreamSessionId ||
        session.closeRequestedAt
      )
        throw fail('Current native binding is unavailable');
      if ((session.adapterCapabilities as Record<string, unknown> | null)?.reboot_protocol_version !== 1)
        throw fail('Wrapper upgrade required for planned reboot');
      await tx.select().from(hosts).where(eq(hosts.id, session.hostId)).for('update');
      const [address] = await tx
        .select()
        .from(agentBusAddresses)
        .where(eq(agentBusAddresses.id, session.agentBusAddressId))
        .for('update');
      if (
        !address ||
        address.currentSessionId !== sessionId ||
        address.bindingGeneration !== session.bindingGeneration ||
        address.lastUpstreamSessionId !== session.upstreamSessionId
      )
        throw fail('Native binding changed');
      const [existing] = await tx
        .select()
        .from(agentRebootHandoffs)
        .where(eq(agentRebootHandoffs.id, v.request_id));
      if (existing) {
        if (existing.oldSessionId !== sessionId || existing.requestSha !== hash)
          throw fail('Request ID reused with different input');
        return existing;
      }
      await noCompetingRecovery(tx, address.id);
      const [reserved] = await tx
        .select()
        .from(agentRebootHandoffs)
        .where(eq(agentRebootHandoffs.activeHostId, session.hostId));
      if (reserved) throw fail('This host already has a planned reboot');
      const [consumed] = await tx
        .select()
        .from(agentRebootHandoffs)
        .where(
          and(
            eq(agentRebootHandoffs.hostId, session.hostId),
            eq(agentRebootHandoffs.engine, session.engine),
            eq(agentRebootHandoffs.nativeSessionId, session.upstreamSessionId),
            isNotNull(agentRebootHandoffs.resumeBootId),
          ),
        );
      if (consumed)
        throw fail('This native session already consumed a reboot; automatic rearming is forbidden');
      const record: Handoff = {
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
        continuationEnc: encrypt(v.continuation, this.keyring),
        reason: v.reason,
        status: 'prepared',
        busMessageIds: [],
        portalMessageIds: [],
        expiresAt: isoOffsetSeconds(86400),
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentRebootHandoffs).values(record);
      return record;
    });
    return { ...this.view(row), continuation: decrypt(row.continuationEnc, this.keyring) };
  }
  async arm(sessionId: string, requestId: string) {
    const row = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(agentRebootHandoffs)
        .where(eq(agentRebootHandoffs.id, requestId))
        .for('update');
      if (!r || r.oldSessionId !== sessionId) throw new NotFoundError('Reboot handoff not found');
      if (r.status === 'armed') return r;
      if (r.status !== 'prepared' || r.expiresAt <= nowIso())
        throw fail('Reboot handoff is no longer prepared');
      const [session] = await tx
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .for('update');
      const [address] = await tx
        .select()
        .from(agentBusAddresses)
        .where(eq(agentBusAddresses.id, r.addressId))
        .for('update');
      if (
        !session ||
        session.endedAt ||
        session.closeRequestedAt ||
        address?.currentSessionId !== sessionId ||
        session.upstreamSessionId !== r.nativeSessionId
      )
        throw fail('Native binding changed before arm');
      await noCompetingRecovery(tx, r.addressId);
      const bus = await tx
        .select()
        .from(agentBusMessages)
        .where(
          and(eq(agentBusMessages.targetAddressId, r.addressId), eq(agentBusMessages.status, 'accepted')),
        )
        .for('update');
      for (const message of bus)
        if (
          !message.claimId ||
          message.cancelRequestedAt ||
          (message.leaseOwner !== `session:${sessionId}` && message.deliverySessionId !== sessionId)
        )
          throw fail('An accepted delivery belongs to another process');
      const portal = session.activeTurnId
        ? await tx
            .select()
            .from(agentMessages)
            .where(
              and(
                eq(agentMessages.sessionId, sessionId),
                eq(agentMessages.status, 'accepted'),
                eq(agentMessages.upstreamId, session.activeTurnId),
              ),
            )
            .for('update')
        : [];
      if (portal.some((m) => m.kind === 'close')) throw fail('An operator stop prevents reboot');
      const now = nowIso();
      const updated = {
        ...r,
        status: 'armed',
        busMessageIds: bus.map((m) => m.id),
        portalMessageIds: portal.map((m) => m.messageId),
        updatedAt: now,
      };
      await tx
        .update(agentRebootHandoffs)
        .set({
          status: 'armed',
          busMessageIds: updated.busMessageIds,
          portalMessageIds: updated.portalMessageIds,
          updatedAt: now,
        })
        .where(eq(agentRebootHandoffs.id, r.id));
      if (bus.length)
        await tx
          .update(agentBusMessages)
          .set({ status: 'reboot_hold', leaseUntil: r.expiresAt, updatedAt: now })
          .where(inArray(agentBusMessages.id, updated.busMessageIds));
      if (portal.length)
        await tx
          .update(agentMessages)
          .set({ status: 'reboot_hold', updatedAt: now })
          .where(inArray(agentMessages.messageId, updated.portalMessageIds));
      const [remote] = await tx
        .select()
        .from(hostDaemonPortalBindings)
        .where(eq(hostDaemonPortalBindings.portalSessionId, sessionId));
      if (remote)
        await tx
          .update(hostDaemonOperations)
          .set({ status: 'reboot_hold', updatedAt: now })
          .where(
            and(
              eq(hostDaemonOperations.sessionId, remote.daemonSessionId),
              eq(hostDaemonOperations.status, 'accepted'),
            ),
          );
      await tx
        .update(agentSessions)
        .set({ status: 'reboot_wait', bridgeExpiresAt: r.expiresAt, updatedAt: now })
        .where(eq(agentSessions.id, sessionId));
      await tx.insert(agentEvents).values({
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
          this.keyring,
        ),
        createdAt: now,
      });
      return updated;
    });
    wsPublisher.publish('agent_portal.sessions.changed', { session_id: sessionId });
    return this.view(row);
  }
  async status(sessionId: string) {
    const rows = await this.db
      .select()
      .from(agentRebootHandoffs)
      .where(
        or(eq(agentRebootHandoffs.oldSessionId, sessionId), eq(agentRebootHandoffs.newSessionId, sessionId)),
      );
    return { handoffs: rows.map((r) => this.view(r)) };
  }
  async restore(sessionId: string) {
    const [r] = await this.db
      .select()
      .from(agentRebootHandoffs)
      .where(eq(agentRebootHandoffs.newSessionId, sessionId));
    if (!r) return { peer: [], portal: null };
    const peers = r.busMessageIds.length
      ? await this.db
          .select()
          .from(agentBusMessages)
          .where(
            and(
              inArray(agentBusMessages.id, r.busMessageIds),
              eq(agentBusMessages.status, 'accepted'),
              eq(agentBusMessages.leaseOwner, `session:${sessionId}`),
            ),
          )
      : [];
    const portals = r.portalMessageIds.length
      ? await this.db
          .select()
          .from(agentMessages)
          .where(
            and(
              inArray(agentMessages.messageId, r.portalMessageIds),
              eq(agentMessages.status, 'accepted'),
              eq(agentMessages.sessionId, sessionId),
            ),
          )
      : [];
    return {
      request_id: r.id,
      peer: peers.map((m) => ({
        message_id: m.id,
        claim_id: m.claimId,
        work_kind: m.workKind,
        kind: m.kind,
      })),
      portal: portals[0]
        ? {
            message_id: portals[0].messageId,
            lease_owner: portals[0].leaseOwner,
            upstream_id: portals[0].upstreamId,
          }
        : null,
    };
  }
  async ready(hostId: number, requestId: string, bootId: string) {
    const [r] = await this.db.select().from(agentRebootHandoffs).where(eq(agentRebootHandoffs.id, requestId));
    if (!r || r.hostId !== hostId) throw new NotFoundError('Reboot handoff not found');
    const [old] = await this.db.select().from(agentSessions).where(eq(agentSessions.id, r.oldSessionId));
    if (r.status !== 'armed' || r.expiresAt <= nowIso() || r.bootId === bootId || old?.closeRequestedAt)
      throw fail('Reboot handoff is not available for this boot');
    return this.view(r);
  }
  async observe(hostId: number, requestId: string) {
    const [r] = await this.db.select().from(agentRebootHandoffs).where(eq(agentRebootHandoffs.id, requestId));
    if (!r || r.hostId !== hostId) throw new NotFoundError('Reboot handoff not found');
    const [session] = await this.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, r.newSessionId ?? r.oldSessionId));
    const [binding] = await this.db
      .select()
      .from(hostDaemonPortalBindings)
      .where(eq(hostDaemonPortalBindings.portalSessionId, r.oldSessionId));
    const [remote] = binding
      ? await this.db
          .select()
          .from(hostDaemonSessions)
          .where(eq(hostDaemonSessions.id, binding.daemonSessionId))
      : [];
    return {
      stop_requested:
        !session ||
        !!session.closeRequestedAt ||
        !!session.endedAt ||
        (!!remote && ['stopping', 'closed'].includes(remote.status)),
    };
  }
  async disarm(hostId: number, requestId: string) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(agentRebootHandoffs)
        .where(eq(agentRebootHandoffs.id, requestId))
        .for('update');
      if (!r || r.hostId !== hostId) throw new NotFoundError('Reboot handoff not found');
      if (r.status === 'disarmed') return this.view(r);
      if (!active.includes(r.status)) throw fail('Only an unconsumed reboot can be disarmed');
      await tx
        .update(agentRebootHandoffs)
        .set({ expiresAt: nowIso() })
        .where(eq(agentRebootHandoffs.id, r.id));
      await expireRebootHandoffs(tx, nowIso());
      await tx
        .update(agentRebootHandoffs)
        .set({ status: 'disarmed' })
        .where(eq(agentRebootHandoffs.id, r.id));
      return { ...this.view(r), state: 'disarmed' };
    });
  }
  async finish(
    hostId: number,
    requestId: string,
    failed: boolean,
    report?: { status: string; summary: string },
  ) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(agentRebootHandoffs)
        .where(eq(agentRebootHandoffs.id, requestId))
        .for('update');
      if (!r || r.hostId !== hostId) throw new NotFoundError('Reboot handoff not found');
      if (['finished', 'failed'].includes(r.status)) return this.view(r);
      const now = nowIso();
      // Exit zero is not a work result. Any accepted work without an explicit
      // receipt becomes unknown; it is never put back on the dispatch queue.
      if (r.busMessageIds.length)
        await tx
          .update(agentBusMessages)
          .set({
            status: 'ambiguous',
            lastErrorCode: 'reboot_resume_without_result',
            ambiguousAt: now,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          })
          .where(
            and(
              inArray(agentBusMessages.id, r.busMessageIds),
              inArray(agentBusMessages.status, ['accepted', 'reboot_hold']),
            ),
          );
      if (r.portalMessageIds.length)
        await tx
          .update(agentMessages)
          .set({
            status: 'dead',
            lastError: 'Reboot continuation failed before binding',
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          })
          .where(
            and(
              inArray(agentMessages.messageId, r.portalMessageIds),
              eq(agentMessages.status, 'reboot_hold'),
            ),
          );
      const [remote] = await tx
        .select()
        .from(hostDaemonPortalBindings)
        .where(eq(hostDaemonPortalBindings.portalSessionId, r.oldSessionId));
      if (remote) {
        await tx
          .update(hostDaemonOperations)
          .set({
            status: report
              ? report.status === 'succeeded'
                ? 'completed'
                : report.status === 'failed'
                  ? 'failed'
                  : 'unknown'
              : 'unknown',
            resultEnc: encrypt(
              JSON.stringify({
                status: report
                  ? report.status === 'succeeded'
                    ? 'completed'
                    : report.status === 'failed'
                      ? 'failed'
                      : 'unknown'
                  : 'unknown',
                reply:
                  report?.summary ??
                  'Planned reboot continuation ended without an explicit result; see linked native transcript.',
              }),
              this.keyring,
            ),
            updatedAt: now,
          })
          .where(
            and(
              eq(hostDaemonOperations.sessionId, remote.daemonSessionId),
              eq(hostDaemonOperations.status, 'reboot_hold'),
            ),
          );
        await tx
          .update(hostDaemonSessions)
          .set({ status: 'waiting', lastActivityAt: now })
          .where(
            and(eq(hostDaemonSessions.id, remote.daemonSessionId), eq(hostDaemonSessions.status, 'running')),
          );
      }
      await tx
        .update(agentRebootHandoffs)
        .set({ status: failed ? 'failed' : 'finished', activeHostId: null, updatedAt: now })
        .where(eq(agentRebootHandoffs.id, r.id));
      return { ...this.view(r), state: failed ? 'failed' : 'finished' };
    });
  }
  private view(r: Handoff) {
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
}
