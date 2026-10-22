import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { hosts, hostAuthDigests, hostAuthStates, hostUsers, installTokens, logs, type Host } from '../db/schema.js';
import { UnauthorizedError } from '../http/errors.js';
import { isoOffsetSeconds } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { SettingsService } from './settings.js';
import { suspendAgentMessagingRuntimeLocked } from './agent-messaging.js';

export const TEMPORARY_HOST_IDLE_SECONDS = 7200;
const CONTACT_CHECKPOINT_MS = 30_000;

function contactCheckpointDue(host: Host, now: Date): boolean {
  const age = now.getTime() - Date.parse(host.lastContactAt ?? '');
  return Boolean(host.expiresAt) || !Number.isFinite(age) || age < 0 || age >= CONTACT_CHECKPOINT_MS;
}

function validateContact(current: Host | undefined, authenticated: Host, now: Date): asserts current is Host {
  if (!current) throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
  if (current.status && current.status !== 'active') throw new UnauthorizedError(`Host ${current.status}`, `host_${current.status}`);
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

function pruneReason(host: Host, days: number, now: Date): string | null {
  // Server-owned hosts (the Fleet Advisor) belong to the stack, not the fleet.
  if (host.internalRole) return null;
  if (host.expiresAt && Date.parse(host.expiresAt) <= now.getTime()) return 'expired';
  if (days > 0 && Date.parse(host.lastContactAt ?? host.createdAt) < now.getTime() - days * 86400_000) return 'inactive';
  // Pooled accounts may have no per-host digest. Any engine's installed
  // version/auth metadata or successful auth calls prove provisioning.
  const provisioned = Number(host.apiCalls ?? 0) > 0 || [
    host.clientVersion, host.wrapperVersion, host.authDigest, host.lastRefresh,
    host.claudeClientVersion, host.claudeWrapperVersion, host.claudeAuthDigest, host.claudeLastRefresh,
    host.grokClientVersion, host.grokWrapperVersion, host.grokAuthDigest, host.grokLastRefresh,
  ].some(Boolean);
  if (!provisioned && Date.parse(host.createdAt) < now.getTime() - 1800_000 && Date.parse(host.lastContactAt ?? host.createdAt) < now.getTime() - 1800_000) return 'never_provisioned';
  return null;
}

/** Recheck under the host lock so a successful concurrent contact wins. */
export async function pruneHosts(db: Database, settings = new SettingsService(db), now = new Date()): Promise<number> {
  const days = Math.max(0, Math.min(60, await settings.getInt('inactivity_window_days', 30)));
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
        const [registration] = await tx.select({ id: logs.id }).from(logs).where(and(
          eq(logs.hostId, host.id), inArray(logs.action, ['host.created','host.rotated']),
          gt(logs.createdAt, isoOffsetSeconds(-1800, now)),
        )).limit(1);
        if (registration) return null;
      }
      await suspendAgentMessagingRuntimeLocked(tx, host.id, 'host_inactive');
      await tx.delete(installTokens).where(eq(installTokens.hostId, host.id));
      await tx.delete(hostAuthDigests).where(eq(hostAuthDigests.hostId, host.id));
      await tx.delete(hostAuthStates).where(eq(hostAuthStates.hostId, host.id));
      await tx.delete(hostUsers).where(eq(hostUsers.hostId, host.id));
      await tx.insert(logs).values({ hostId: null, action: 'host.pruned', details: JSON.stringify({ host_id: host.id, fqdn: host.fqdn, reason }), createdAt: isoOffsetSeconds(0, now) });
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
export async function recordHostContact(db: Database, host: Host, now = new Date(), freshlyAuthenticated = false): Promise<Host> {
  // Revalidate against a fresh durable row, never an in-memory auth cache.
  // Only a checkpoint that actually writes needs the contact/prune row lock.
  if (!host.expiresAt) {
    // Authentication already read this row during the same request. Reuse it
    // only for optional bookkeeping; every write still revalidates under lock.
    const current = freshlyAuthenticated ? host : (await db.select().from(hosts).where(eq(hosts.id, host.id)).limit(1))[0];
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
