import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { RouteContext } from '../routes/index.js';
import { hostSpawns, hostDaemons } from '../db/schema.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { encrypt, decrypt } from '../security/secret-box.js';
import { mutateOwnerState, requireOwnerRuntime } from '../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import { stageUpdate } from '../control-plane/state/rows.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { ownerPresence } from '../control-plane/presence.js';
import { HostManagementService, type InstallerInfo } from './host-management.js';
import { makeAdminEventsWriter } from './admin-events-writer.js';
import { daemonSettingsSchema, daemonExpired } from './host-daemon/policy.js';
import { wsPublisher } from '../ws/publisher.js';
import type { HostSpawnService, hostSpawnSchema, hostSpawnStatusSchema } from './host-spawn.js';
import type { Json } from '../control-plane/commands.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const now = () => new Date().toISOString();
function caller(state: OwnerStateSnapshot, hostId: number) {
  const host = state.hosts.get(hostId);
  if (!host || host.status !== 'active' || host.vip !== 1)
    throw new ForbiddenError('System spawn requires an active VIP source host', 'host_spawn_vip_required');
  if (state.setting('host_spawn_enabled') !== '1')
    throw new ForbiddenError('System spawn is disabled', 'host_spawn_disabled');
}
function management(ctx: RouteContext) {
  return new HostManagementService({
    db: ctx.db,
    env: ctx.env,
    keyring: ctx.keyring,
    events: makeAdminEventsWriter(ctx.db),
  });
}
export async function prepareOwned(
  ctx: RouteContext,
  service: HostSpawnService,
  input: z.infer<typeof hostSpawnSchema>,
  sourceHostId: number,
) {
  const owner = requireOwnerRuntime(ctx.db),
    requestHash = hash(input);
  const result = (await mutateOwnerState(owner, {
    kind: 'host_spawn.prepare',
    responseAuthorization: 'commit',
    payload: { sourceHostId, input },
    authorize: (state) => caller(state, sourceHostId),
    prepare: async (command) => {
      const existing = command.draft
        .table('hostSpawns')
        .by('sourceHostId', sourceHostId)
        .find((row) => row.clientMessageId === input.client_message_id);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ConflictError('Idempotency key reused with different input');
        if (existing.installerRevision !== 0)
          throw new ConflictError('Installer was renewed; use host_spawn_status');
        const [cold] = await ctx.db.select().from(hostSpawns).where(eq(hostSpawns.id, existing.id));
        if (!cold) throw new Error('Spawn operation has no durable installer');
        return service.response({ ...cold, ...existing }) as unknown as Json;
      }
      if (input.daemon.mode !== 'none' && command.snapshot.setting('agent_messaging_enabled') !== '1')
        throw new ConflictError('Enable Agent Messaging before installing a daemon');
      let response!: ReturnType<HostSpawnService['response']>;
      management(ctx).stageRegisterOwned(
        command,
        { fqdn: input.fqdn, engines: input.engines, secure: input.secure, vip: false },
        { createOnly: true },
        ({ host, installer }) => {
          const at = now();
          if (input.daemon.mode !== 'none') {
            const settings = daemonSettingsSchema.parse({
              enabled: true,
              username: input.daemon.username,
              default_cwd: input.daemon.default_cwd,
              lifetime_minutes: input.daemon.mode === 'timed' ? input.daemon.duration_minutes : null,
            });
            const row = { hostId: host.id, settings, enabledAt: at, updatedAt: at, runtime: null };
            command.draft.upsert('hostDaemons', row);
            command.write((tx) => tx.insert(hostDaemons).values(row));
          }
          const row = {
            id: randomUUID(),
            sourceHostId,
            targetHostId: host.id,
            clientMessageId: input.client_message_id,
            requestHash,
            request: input,
            installerEnc: encrypt(JSON.stringify(installer), ctx.keyring),
            installerRevision: 0,
            renewalReceipts: {},
            renewalClientMessageId: null,
            setupCompletedAt: null,
            createdAt: at,
            updatedAt: at,
          };
          command.draft.upsert('hostSpawns', row);
          command.write((tx) => tx.insert(hostSpawns).values(row));
          adminAudit(
            command,
            'host.spawn.prepared',
            { source_host_id: sourceHostId, target_host_id: host.id, operation_id: row.id },
            at,
            host.id,
          );
          response = service.response(row);
        },
      );
      return () => response as unknown as Json;
    },
  })) as unknown as ReturnType<HostSpawnService['response']>;
  wsPublisher.publish('host.updated', { id: result.host_id });
  return result;
}
export async function statusOwned(
  ctx: RouteContext,
  service: HostSpawnService,
  input: z.infer<typeof hostSpawnStatusSchema>,
  sourceHostId: number,
) {
  const owner = requireOwnerRuntime(ctx.db);
  caller(owner.state.snapshot(), sourceHostId);
  let metadata = owner.state.snapshot().table('hostSpawns').get(input.operation_id);
  if (!metadata || metadata.sourceHostId !== sourceHostId)
    throw new NotFoundError('Spawn operation not found');
  // Returning the installer is an explicit credential read; connectivity and
  // operation state remain owned metadata and are revalidated after this await.
  const [cold] = await ctx.db.select().from(hostSpawns).where(eq(hostSpawns.id, metadata.id));
  if (!cold) throw new Error('Spawn operation has no durable installer');
  let row = { ...cold, ...metadata };
  if (input.renew_installer) {
    row = (await mutateOwnerState(owner, {
      kind: 'host_spawn.renew',
      payload: { sourceHostId, input },
      authorize: (state) => caller(state, sourceHostId),
      prepare: async (command) => {
        const current = command.draft.table('hostSpawns').get(input.operation_id);
        if (!current || current.sourceHostId !== sourceHostId)
          throw new NotFoundError('Spawn operation not found');
        if (current.installerRevision !== metadata!.installerRevision)
          throw new ConflictError('Installer changed; retry status');
        const receipt = current.renewalReceipts[input.client_message_id!];
        if (receipt) return { ...cold, ...current, installerEnc: receipt } as unknown as Json;
        const previous = JSON.parse(decrypt(cold.installerEnc, ctx.keyring)) as InstallerInfo;
        const token = command.draft
          .table('installTokens')
          .by('hostId', current.targetHostId)
          .find((t) => t.token === tokenHash(previous.token));
        if (token && !token.usedAt && Date.parse(token.expiresAt) > Date.now())
          throw new ConflictError('Installer is still available; retry the existing setup');
        const installer = await management(ctx).stageMintExistingOwned(command, current.targetHostId);
        const installerEnc = encrypt(JSON.stringify(installer), ctx.keyring),
          at = now();
        const patch = {
          installerEnc,
          installerRevision: current.installerRevision + 1,
          renewalReceipts: { ...current.renewalReceipts, [input.client_message_id!]: installerEnc },
          renewalClientMessageId: input.client_message_id!,
          updatedAt: at,
        };
        stageUpdate(command, 'hostSpawns', current.id, patch);
        adminAudit(
          command,
          'host.spawn.installer_renewed',
          { source_host_id: sourceHostId, operation_id: current.id },
          at,
          current.targetHostId,
        );
        return { ...cold, ...current, ...patch } as unknown as Json;
      },
    })) as unknown as typeof row;
  }
  owner.assertOwner();
  const state = owner.state.snapshot();
  caller(state, sourceHostId);
  metadata = state.table('hostSpawns').get(input.operation_id);
  if (!metadata || metadata.sourceHostId !== sourceHostId)
    throw new NotFoundError('Spawn operation not found');
  // A concurrent rotation cannot return an obsolete credential as the current one.
  if (metadata.installerRevision !== row.installerRevision)
    throw new ConflictError('Installer changed; retry status');
  const config = state.table('hostDaemons').get(metadata.targetHostId),
    deadlineExpired = !!config && daemonExpired(config.settings);
  const instance = config?.runtime?.instance_id;
  const connected = !!instance && ownerPresence(owner).hasDaemon(metadata.targetHostId, instance);
  const response = service.response({ ...row, ...metadata }, deadlineExpired);
  const token = state
    .table('installTokens')
    .by('hostId', metadata.targetHostId)
    .find((t) => t.token === tokenHash(response.installer.token));
  return {
    ...response,
    installer_used: !!token?.usedAt,
    setup_completed_at: metadata.setupCompletedAt,
    daemon_connected: connected,
    daemon_deadline_expired: deadlineExpired,
    daemon_expires_at: config?.settings.expires_at ?? null,
    state: metadata.setupCompletedAt ? 'installed' : token?.usedAt ? 'installer_downloaded' : 'registered',
  };
}
export async function completeOwned(ctx: RouteContext, targetHostId: number) {
  const owner = requireOwnerRuntime(ctx.db);
  if (
    owner.state
      .snapshot()
      .table('hostSpawns')
      .by('targetHostId', targetHostId)
      .some((row) => !row.setupCompletedAt)
  )
    await mutateOwnerState(owner, {
      kind: 'host_spawn.complete',
      payload: { targetHostId },
      prepare(command) {
        const at = now();
        for (const row of command.draft.table('hostSpawns').by('targetHostId', targetHostId))
          if (!row.setupCompletedAt)
            stageUpdate(command, 'hostSpawns', row.id, { setupCompletedAt: at, updatedAt: at });
        return null;
      },
    });
  wsPublisher.publish('host.updated', { id: targetHostId });
  return { stored: true };
}
