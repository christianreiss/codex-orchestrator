import { firebaseClientConfig } from './firebase-config.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import { adminUsers, agentEvents, companionDevices, companionPairings } from '../../db/schema.js';
import { sha256 } from '../../security/hash.js';
import { capabilitiesForRole, roleHasCapability, type Capability } from '../../security/capabilities.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../http/errors.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { wsPublisher } from '../../ws/publisher.js';
import { makeAdminEventsWriter } from '../admin-events-writer.js';

export function companionBaseUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new ValidationError('PUBLIC_BASE_URL must be an HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new ValidationError(
      'Companion requires an HTTPS PUBLIC_BASE_URL without credentials, path, query or fragment',
    );
  }
  return url.origin;
}

export class CompanionDevices {
  private readonly clientConfig: ReturnType<typeof firebaseClientConfig>;
  constructor(readonly ctx: RouteContext) {
    this.clientConfig = firebaseClientConfig(ctx.env);
  }

  firebase() {
    return this.clientConfig;
  }

  async pair(userId: number) {
    const token = randomBytes(32).toString('hex');
    const server = companionBaseUrl(this.ctx.env.PUBLIC_BASE_URL);
    const expiresAt = isoOffsetSeconds(300);
    await this.ctx.db.transaction(async (tx) => {
      await tx.select().from(adminUsers).where(eq(adminUsers.id, userId)).for('update');
      await tx.delete(companionPairings).where(eq(companionPairings.userId, userId));
      await tx.insert(companionPairings).values({ tokenHash: sha256(token), userId, expiresAt });
      await makeAdminEventsWriter(tx as unknown as RouteContext['db']).append('companion.pairing.created', {
        admin_user_id: userId,
      });
    });
    return { qr: JSON.stringify({ version: 1, server, token }), expires_at: expiresAt };
  }

  async exchange(token: string, name: string) {
    const result = await this.ctx.db.transaction(async (tx) => {
      const [pairing] = await tx
        .select()
        .from(companionPairings)
        .where(and(eq(companionPairings.tokenHash, sha256(token)), gt(companionPairings.expiresAt, nowIso())))
        .for('update');
      if (!pairing) throw new UnauthorizedError('Pairing code expired or already used', 'pairing_invalid');
      const [user] = await tx.select().from(adminUsers).where(eq(adminUsers.id, pairing.userId));
      if (!user?.active) throw new UnauthorizedError('Account disabled', 'admin_disabled');
      const [latest] = await tx
        .select({ id: agentEvents.id })
        .from(agentEvents)
        .orderBy(desc(agentEvents.id))
        .limit(1);
      const credential = randomBytes(32).toString('hex');
      const id = randomUUID();
      await tx.insert(companionDevices).values({
        id,
        userId: user.id,
        name,
        tokenHash: sha256(credential),
        eventCursor: latest?.id ?? 0,
        createdAt: nowIso(),
        lastSeenAt: nowIso(),
        expiresAt: isoOffsetSeconds(365 * 86400),
      });
      await tx.delete(companionPairings).where(eq(companionPairings.tokenHash, pairing.tokenHash));
      await makeAdminEventsWriter(tx as unknown as RouteContext['db']).append('companion.device.paired', {
        device_id: id,
        admin_user_id: user.id,
      });
      return {
        device_id: id,
        token: credential,
        firebase: this.firebase(),
        capabilities: capabilitiesForRole(user.accessLevel),
      };
    });
    wsPublisher.publish('companion.devices.changed', {});
    return result;
  }

  async authenticate(raw: string | undefined, capability?: Capability) {
    if (!raw || !/^Bearer [a-f0-9]{64}$/.test(raw))
      throw new UnauthorizedError('Device credential required', 'device_required');
    const [row] = await this.ctx.db
      .select({ device: companionDevices, user: adminUsers })
      .from(companionDevices)
      .innerJoin(adminUsers, eq(companionDevices.userId, adminUsers.id))
      .where(
        and(
          eq(companionDevices.tokenHash, sha256(raw.slice(7))),
          isNull(companionDevices.revokedAt),
          gt(companionDevices.expiresAt, nowIso()),
        ),
      )
      .limit(1);
    if (!row?.user.active)
      throw new UnauthorizedError('Device revoked, expired or account disabled', 'device_revoked');
    if (capability && !roleHasCapability(row.user.accessLevel, capability))
      throw new ForbiddenError('Capability required', 'capability_required');
    return row;
  }

  async list(userId: number) {
    return this.ctx.db
      .select({
        id: companionDevices.id,
        name: companionDevices.name,
        created_at: companionDevices.createdAt,
        last_seen_at: companionDevices.lastSeenAt,
        expires_at: companionDevices.expiresAt,
        revoked_at: companionDevices.revokedAt,
      })
      .from(companionDevices)
      .where(eq(companionDevices.userId, userId));
  }

  async revoke(userId: number, id: string) {
    await this.ctx.db.transaction(async (tx) => {
      await tx
        .update(companionDevices)
        .set({ revokedAt: nowIso(), fcmTokenEnc: null })
        .where(and(eq(companionDevices.id, id), eq(companionDevices.userId, userId)));
      await makeAdminEventsWriter(tx as unknown as RouteContext['db']).append('companion.device.revoked', {
        device_id: id,
        admin_user_id: userId,
      });
    });
    wsPublisher.publish('companion.devices.changed', {});
  }
}
