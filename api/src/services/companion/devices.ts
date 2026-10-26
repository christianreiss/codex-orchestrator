import { observeCompanion, companionLastSeen } from './presence.js';
import { encrypt } from '../../security/secret-box.js';
import { ownerRuntimeFor, mutateOwnerState, setOwnerRequestPrincipal } from '../../control-plane/state/runtime.js';
import { stageUpdate, stageDelete } from '../../control-plane/state/rows.js';
import { adminAudit } from '../../control-plane/state/admin.js';
import { firebaseClientConfig } from './firebase-config.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import { adminUsers, agentEvents, companionDevices, companionPairings, companionFollows } from '../../db/schema.js';
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
    const deviceId = randomUUID();
    const server = companionBaseUrl(this.ctx.env.PUBLIC_BASE_URL);
    const expiresAt = isoOffsetSeconds(300);
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) {
      await mutateOwnerState(owner, { kind: 'companion.pair', payload: { userId }, prepare(context) {
        if (!context.draft.table('adminUsers').get(userId)?.active) throw new UnauthorizedError('Account disabled', 'admin_disabled');
        for (const pairing of context.draft.table('companionPairings').by('userId', userId)) stageDelete(context, 'companionPairings', pairing.tokenHash);
        const row = { tokenHash: sha256(token), userId, expiresAt, deviceId }; context.draft.upsert('companionPairings', row);
        context.write(async tx => { await tx.insert(companionPairings).values(row); });
        adminAudit(context, 'companion.pairing.created', { admin_user_id: userId }); return null;
      } });
      return { qr: JSON.stringify({ version: 1, server, token }), expires_at: expiresAt, device_id: deviceId };
    }
    await this.ctx.db.transaction(async (tx) => {
      await tx.select().from(adminUsers).where(eq(adminUsers.id, userId)).for('update');
      await tx.delete(companionPairings).where(eq(companionPairings.userId, userId));
      await tx.insert(companionPairings).values({ tokenHash: sha256(token), userId, expiresAt, deviceId });
      await makeAdminEventsWriter(tx as unknown as RouteContext['db']).append('companion.pairing.created', {
        admin_user_id: userId,
      });
    });
    return { qr: JSON.stringify({ version: 1, server, token }), expires_at: expiresAt, device_id: deviceId };
  }

  async exchange(token: string, name: string) {
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) {
      const credential = randomBytes(32).toString('hex');
      let id = '';
      let capabilities: ReturnType<typeof capabilitiesForRole> = [];
      await mutateOwnerState(owner, { kind: 'companion.exchange', payload: { tokenHash: sha256(token), name }, prepare: async context => {
        const pairing = context.draft.table('companionPairings').get(sha256(token));
        if (!pairing || pairing.expiresAt <= nowIso()) throw new UnauthorizedError('Pairing code expired or already used', 'pairing_invalid');
        id = pairing.deviceId ?? randomUUID();
        const user = context.draft.table('adminUsers').get(pairing.userId);
        if (!user?.active) throw new UnauthorizedError('Account disabled', 'admin_disabled');
        const latest = Number(context.snapshot.setting('owner_portal_event_id') ?? 0);
        const row = { id, userId: user.id, name, tokenHash: sha256(credential), eventCursor: latest, createdAt: nowIso(), lastSeenAt: nowIso(), expiresAt: isoOffsetSeconds(365 * 86400), fcmTokenEnc: null, notifications: 1, visibleSessionId: null, visibleUntil: null, revokedAt: null };
        context.draft.upsert('companionDevices', row); context.write(async tx => { await tx.insert(companionDevices).values(row); });
        stageDelete(context, 'companionPairings', pairing.tokenHash); adminAudit(context, 'companion.device.paired', { device_id: id, admin_user_id: user.id });
        capabilities = capabilitiesForRole(user.accessLevel); return null;
      } });
      wsPublisher.publish('companion.devices.changed', {});
      return { device_id: id, token: credential, firebase: this.firebase(), capabilities };
    }
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
      const id = pairing.deviceId ?? randomUUID();
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
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) {
      owner.assertOwner(); const hash = sha256(raw.slice(7));
      const check = (state: ReturnType<typeof owner.state.snapshot>) => {
        const device = state.table('companionDevices').by('tokenHash', hash)[0], user = device ? state.table('adminUsers').get(device.userId) : undefined;
        if (!device || device.revokedAt || device.expiresAt <= nowIso() || !user?.active) throw new UnauthorizedError('Device revoked, expired or account disabled', 'device_revoked');
        if (capability && !roleHasCapability(user.accessLevel, capability)) throw new ForbiddenError('Capability required', 'capability_required');
        return { device, user };
      };
      const row = check(owner.state.snapshot()); observeCompanion(owner, row.device.id); setOwnerRequestPrincipal({ principal: `companion:${row.device.id}`, revalidate: check }); return row;
    }
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
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) { owner.assertOwner(); return owner.state.snapshot().table('companionDevices').by('userId', userId).map(row => ({ id: row.id, name: row.name, created_at: row.createdAt, last_seen_at: companionLastSeen(owner, row.id, row.lastSeenAt), expires_at: row.expiresAt, revoked_at: row.revokedAt })); }
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

  async patch(id: string, input: { fcm_token?: string | null; notifications?: boolean; visible_session_id?: string | null }) {
    const owner = ownerRuntimeFor(this.ctx.db);
    if (!owner) {
      await this.ctx.db.update(companionDevices).set({ lastSeenAt: nowIso(), ...(input.fcm_token !== undefined ? { fcmTokenEnc: input.fcm_token ? encrypt(input.fcm_token, this.ctx.keyring) : null } : {}), ...(input.notifications !== undefined ? { notifications: Number(input.notifications) } : {}), ...(input.visible_session_id !== undefined ? { visibleSessionId: input.visible_session_id, visibleUntil: input.visible_session_id ? isoOffsetSeconds(45) : null } : {}) }).where(eq(companionDevices.id, id));
    } else {
      observeCompanion(owner, id, input.visible_session_id);
      const current = owner.state.snapshot().table('companionDevices').get(id);
      if (!current || current.revokedAt) throw new UnauthorizedError('Device revoked', 'device_revoked');
      if (input.fcm_token === undefined && (input.notifications === undefined || Number(input.notifications) === current.notifications)) return;
      await mutateOwnerState(owner, { kind: 'companion.settings', payload: { id, notifications: input.notifications ?? null, tokenChanged: input.fcm_token !== undefined }, prepare: context => {
        const row = context.draft.table('companionDevices').get(id); if (!row || row.revokedAt) throw new UnauthorizedError('Device revoked', 'device_revoked');
        stageUpdate(context, 'companionDevices', id, { ...(input.fcm_token !== undefined ? { fcmTokenEnc: input.fcm_token ? encrypt(input.fcm_token, this.ctx.keyring) : null } : {}), ...(input.notifications !== undefined ? { notifications: Number(input.notifications) } : {}) }); return null;
      } });
    }
    wsPublisher.publish('companion.devices.changed', {});
  }
  async follow(deviceId: string, sessionId: string, enabled = true) {
    const owner = ownerRuntimeFor(this.ctx.db);
    if (!owner) { if (enabled) await this.ctx.db.insert(companionFollows).values({ deviceId, sessionId }).onDuplicateKeyUpdate({ set: { sessionId } }); else await this.ctx.db.delete(companionFollows).where(and(eq(companionFollows.deviceId, deviceId), eq(companionFollows.sessionId, sessionId))); return; }
    const previous = owner.state.snapshot().table('companionFollows').get([deviceId, sessionId]);
    if (!!previous === enabled) return;
    await mutateOwnerState(owner, { kind: 'companion.follow', payload: { deviceId, sessionId, enabled }, prepare(context) {
      if (enabled) { const row = { deviceId, sessionId }; context.draft.upsert('companionFollows', row); context.write(async tx => { await tx.insert(companionFollows).values(row).onDuplicateKeyUpdate({ set: { sessionId } }); }); }
      else stageDelete(context, 'companionFollows', [deviceId, sessionId]); return null;
    } });
    wsPublisher.publish('companion.devices.changed', {});
  }
  async revoke(userId: number, id: string) {
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) {
      await mutateOwnerState(owner, { kind: 'companion.revoke', responseAuthorization:'commit', payload: { userId, id }, prepare(context) {
        const row = context.draft.table('companionDevices').get(id);
        if (row?.userId === userId) stageUpdate(context, 'companionDevices', id, { revokedAt: nowIso(), fcmTokenEnc: null });
        adminAudit(context, 'companion.device.revoked', { device_id: id, admin_user_id: userId }); return null;
      } });
      wsPublisher.publish('companion.devices.changed', {}); return;
    }
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
