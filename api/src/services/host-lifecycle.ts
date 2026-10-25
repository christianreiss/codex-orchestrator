import { persistAuditLog } from './audit-log.js';
import { hostActivity, observeHostActivity } from '../control-plane/state/host-activity.js';
import { projectHostDeletion } from '../control-plane/state/deletion.js';
import { suspendOwnedMessaging } from '../control-plane/state/suspension.js';
import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { requestHost } from '../control-plane/state/admission.js';
import { hashApiKey } from '../util/api-key-helpers.js';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  hosts,
  hostAuthDigests,
  hostAuthStates,
  hostUsers,
  installTokens,
  logs,
  type Host,
} from '../db/schema.js';
import { UnauthorizedError } from '../http/errors.js';
import { isoOffsetSeconds } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { SettingsService } from './settings.js';
import { suspendAgentMessagingRuntimeLocked } from './agent-messaging.js';
import { CONTACT_CHECKPOINT_MS } from './host-contact.js';

export const TEMPORARY_HOST_IDLE_SECONDS = 7200;

function contactCheckpointDue(host: Host, now: Date): boolean {
  const age = now.getTime() - Date.parse(host.lastContactAt ?? '');
  return Boolean(host.expiresAt) || !Number.isFinite(age) || age < 0 || age >= CONTACT_CHECKPOINT_MS;
}

function validateContact(current: Host | undefined, authenticated: Host, now: Date): asserts current is Host {
  if (!current) throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
  if (current.status && current.status !== 'active')
    throw new UnauthorizedError(`Host ${current.status}`, `host_${current.status}`);
  if (current.apiKeyHash !== authenticated.apiKeyHash || current.apiKey !== authenticated.apiKey) {
    throw new UnauthorizedError('Host key changed', 'invalid_api_key');
  }
  assertHostNotExpired(current, now);
}

export function assertHostNotExpired(host: Host, now = new Date()): void {
  if (host.expiresAt && Date.parse(host.expiresAt) <= now.getTime()) {
    throw new UnauthorizedError('Temporary host expired', 'host_expired');
  }
}

function pruneReason(host: Omit<Host, 'apiKey' | 'apiKeyEnc'>, days: number, now: Date): string | null {
  // Server-owned hosts (the Fleet Advisor) belong to the stack, not the fleet.
  if (host.internalRole) return null;
  if (host.expiresAt && Date.parse(host.expiresAt) <= now.getTime()) return 'expired';
  if (days > 0 && Date.parse(host.lastContactAt ?? host.createdAt) < now.getTime() - days * 86400_000)
    return 'inactive';
  // Pooled accounts may have no per-host digest. Any engine's installed
  // version/auth metadata or successful auth calls prove provisioning.
  const provisioned =
    Number(host.apiCalls ?? 0) > 0 ||
    [
      host.clientVersion,
      host.wrapperVersion,
      host.authDigest,
      host.lastRefresh,
      host.claudeClientVersion,
      host.claudeWrapperVersion,
      host.claudeAuthDigest,
      host.claudeLastRefresh,
      host.grokClientVersion,
      host.grokWrapperVersion,
      host.grokAuthDigest,
      host.grokLastRefresh,
    ].some(Boolean);
  if (
    !provisioned &&
    Date.parse(host.createdAt) < now.getTime() - 1800_000 &&
    Date.parse(host.lastContactAt ?? host.createdAt) < now.getTime() - 1800_000
  )
    return 'never_provisioned';
  return null;
}

/** Recheck under the host lock so a successful concurrent contact wins. */
export async function pruneHosts(
  db: Database,
  settings = new SettingsService(db),
  now = new Date(),
): Promise<number> {
  const days = Math.max(0, Math.min(60, await settings.getInt('inactivity_window_days', 30)));
  const owner = ownerRuntimeFor(db);
  if (owner) {
    owner.assertOwner();
    let removed = 0;
    for (const candidate of owner.state.snapshot().hosts.all()) {
      const activity = hostActivity(owner, candidate.id);
      const contact = activity.lastAt
        ? new Date(
            Math.max(activity.lastAt, Date.parse(candidate.lastContactAt ?? candidate.createdAt) || 0),
          ).toISOString()
        : candidate.lastContactAt;
      const candidateReason = pruneReason({ ...candidate, lastContactAt: contact }, days, now);
      if (!candidateReason || (candidateReason !== 'expired' && activity.connected)) continue;
      const result = await mutateOwnerState(owner, {
        kind: 'host.prune',
        payload: { hostId: candidate.id, at: now.toISOString() },
        prepare(ctx) {
          const host = ctx.draft.table('hosts').get(candidate.id);
          if (!host) return null;
          const currentDays = Math.max(
            0,
            Math.min(60, Number(ctx.snapshot.setting('inactivity_window_days') ?? 30)),
          );
          const activity = hostActivity(owner, host.id);
          const contact = activity.lastAt
            ? new Date(
                Math.max(activity.lastAt, Date.parse(host.lastContactAt ?? host.createdAt) || 0),
              ).toISOString()
            : host.lastContactAt;
          const reason = pruneReason(
            { ...host, lastContactAt: contact },
            Number.isFinite(currentDays) ? currentDays : 30,
            now,
          );
          if (reason !== 'expired' && activity.connected) return null;
          if (
            !reason ||
            (reason !== 'expired' &&
              host.registrationAt &&
              Date.parse(host.registrationAt) > now.getTime() - 1800_000)
          )
            return null;
          suspendOwnedMessaging(ctx, host.id, 'host_inactive', undefined, now.toISOString());
          for (const table of ['installTokens', 'hostAuthDigests', 'hostAuthStates', 'hostUsers'] as const) {
            for (const row of ctx.draft.table(table).by('hostId', host.id)) ctx.draft.removeRow(table, row);
          }
          ctx.write(async (tx) => tx.delete(installTokens).where(eq(installTokens.hostId, host.id)));
          ctx.write(async (tx) => tx.delete(hostAuthDigests).where(eq(hostAuthDigests.hostId, host.id)));
          ctx.write(async (tx) => tx.delete(hostAuthStates).where(eq(hostAuthStates.hostId, host.id)));
          ctx.write(async (tx) => tx.delete(hostUsers).where(eq(hostUsers.hostId, host.id)));
          ctx.write(async (tx) =>
            persistAuditLog(tx, {
              hostId: null,
              action: 'host.pruned',
              details: JSON.stringify({ host_id: host.id, fqdn: host.fqdn, reason }),
              createdAt: now.toISOString(),
            }),
          );
          projectHostDeletion(ctx.draft, host.id);
          ctx.draft.remove('hosts', host.id);
          ctx.write(async (tx) => tx.delete(hosts).where(eq(hosts.id, host.id)));
          return reason;
        },
      });
      if (typeof result === 'string') {
        removed++;
        wsPublisher.publish('host.pruned', { id: candidate.id, fqdn: candidate.fqdn, reason: result });
      }
    }
    return removed;
  }
  const rows = await db.select().from(hosts);
  let removed = 0;
  for (const candidate of rows) {
    if (!pruneReason(candidate, days, now)) continue;
    const reason = await db.transaction(async (tx) => {
      const [host] = await tx.select().from(hosts).where(eq(hosts.id, candidate.id)).limit(1).for('update');
      if (!host) return null;
      const reason = pruneReason(host, days, now);
      if (!reason) return null;
      // An explicit key rotation starts a new provisioning attempt. Other admin
      // edits cannot reset inactivity, and an absolute host expiry still wins.
      if (reason !== 'expired') {
        const [registration] = await tx
          .select({ id: logs.id })
          .from(logs)
          .where(
            and(
              eq(logs.hostId, host.id),
              inArray(logs.action, ['host.created', 'host.rotated']),
              gt(logs.createdAt, isoOffsetSeconds(-1800, now)),
            ),
          )
          .limit(1);
        if (registration) return null;
      }
      await suspendAgentMessagingRuntimeLocked(tx, host.id, 'host_inactive');
      await tx.delete(installTokens).where(eq(installTokens.hostId, host.id));
      await tx.delete(hostAuthDigests).where(eq(hostAuthDigests.hostId, host.id));
      await tx.delete(hostAuthStates).where(eq(hostAuthStates.hostId, host.id));
      await tx.delete(hostUsers).where(eq(hostUsers.hostId, host.id));
      await persistAuditLog(tx, {
        hostId: null,
        action: 'host.pruned',
        details: JSON.stringify({ host_id: host.id, fqdn: host.fqdn, reason }),
        createdAt: isoOffsetSeconds(0, now),
      });
      await tx.delete(hosts).where(eq(hosts.id, host.id));
      return reason;
    });
    if (!reason) continue;
    wsPublisher.publish('host.pruned', { id: candidate.id, fqdn: candidate.fqdn, reason });
    removed += 1;
  }
  return removed;
}

/** A valid authenticated contact; it cannot resurrect an expired/deleted host. */
export async function recordHostContact(
  db: Database,
  host: Host,
  now = new Date(),
  freshlyAuthenticated = false,
): Promise<Host> {
  const owner = ownerRuntimeFor(db);
  if (owner) {
    owner.assertOwner();
    const readCurrent = () => {
      const row = owner.state.snapshot().hosts.get(host.id);
      if (!row || row.credentialLookupHash !== hashApiKey(host.apiKey))
        throw new UnauthorizedError('Host key changed', 'invalid_api_key');
      const current = requestHost(row, host.apiKey);
      validateContact(current, host, now);
      return current;
    };
    const current = readCurrent();
    observeHostActivity(owner, host.id, now.getTime());
    if (!current.expiresAt) return { ...current, lastContactAt: now.toISOString() };
    if (!contactCheckpointDue(current, now)) return current;
    await mutateOwnerState(owner, {
      kind: 'host.contact.checkpoint',
      principal: `host:${host.id}`,
      payload: { hostId: host.id, at: now.toISOString() },
      prepare(ctx) {
        const row = ctx.draft.table('hosts').get(host.id);
        if (!row || row.credentialLookupHash !== hashApiKey(host.apiKey))
          throw new UnauthorizedError('Host key changed', 'invalid_api_key');
        const current = requestHost(row, host.apiKey);
        validateContact(current, host, now);
        if (!contactCheckpointDue(current, now)) return null;
        const patch = {
          updatedAt: now.toISOString(),
          lastContactAt: now.toISOString(),
          ...(current.expiresAt ? { expiresAt: isoOffsetSeconds(TEMPORARY_HOST_IDLE_SECONDS, now) } : {}),
        };
        ctx.draft.upsert('hosts', { ...row, ...patch });
        ctx.write(async (tx) => tx.update(hosts).set(patch).where(eq(hosts.id, host.id)));
        return null;
      },
    });
    return readCurrent();
  }
  // Legacy fixture path validates its database directly.
  // Only a checkpoint that actually writes needs the contact/prune row lock.
  if (!host.expiresAt) {
    // Authentication already read this row during the same request. Reuse it
    // only for optional bookkeeping; every write still revalidates under lock.
    const current = freshlyAuthenticated
      ? host
      : (await db.select().from(hosts).where(eq(hosts.id, host.id)).limit(1))[0];
    validateContact(current, host, now);
    if (!contactCheckpointDue(current, now)) return { ...current };
  }
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(hosts).where(eq(hosts.id, host.id)).limit(1).for('update');
    validateContact(current, host, now);
    if (!contactCheckpointDue(current, now)) return { ...current };
    const patch = {
      updatedAt: isoOffsetSeconds(0, now),
      lastContactAt: isoOffsetSeconds(0, now),
      ...(current.expiresAt ? { expiresAt: isoOffsetSeconds(TEMPORARY_HOST_IDLE_SECONDS, now) } : {}),
    };
    await tx.update(hosts).set(patch).where(eq(hosts.id, host.id));
    return { ...current, ...patch };
  });
}
