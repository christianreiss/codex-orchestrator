import { startMediaResultWatch } from '../services/agent-chat/media-watch.js';
import { withOwnerBackgroundScope } from '../control-plane/state/runtime.js';
import { startOwnerWorker } from './owner-worker.js';
import { expireRebootHandoffs } from '../services/reboot-handoffs.js';
import { flushGatewayKeyUsage } from '../services/gateway-key-usage.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../routes/index.js';
import type { createOwnedControlPlane } from '../control-plane/bootstrap.js';
import { OutboxDispatcher } from '../control-plane/outbox.js';
import type { Json } from '../control-plane/commands.js';
import { controlPlaneOutbox } from '../db/schema.js';
import { decrypt } from '../security/secret-box.js';
import { InsecureWindowAdminService } from '../services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../services/admin-events-writer.js';
import { AgentMessagingService } from '../services/agent-messaging.js';
import {
  conferenceHasOwnedDeliveries,
  maintainOwnedMessaging,
  relayHeldWorkGoneAt,
} from '../services/agent-messaging/owned-maintenance.js';
import { createCompanionEffectHandlers } from '../services/companion/push-owner.js';
import { bindOwnerMaintenanceCommands, type OwnerMaintenanceOperation } from './owner-maintenance.js';
import {
  createAuxiliaryMaintenanceHandlers,
  type OwnerMaintenanceHandler,
} from './owner-maintenance-handlers.js';
import { createOwnerProviderMaintenance } from './owner-provider-maintenance.js';
import { createProviderUsageCommands } from './provider-usage-commands.js';
import { createMailer, type MailMessage } from '../services/mailer.js';
import { createWrapperSigningKeyService } from '../services/wrapper-signing-key.js';
import { ChatAttachments } from '../services/agent-chat/attachments.js';
import { mediaPrepareEffect } from '../services/agent-chat/attachments-owned.js';

/** Explicit domain registry: a missing implementation fails startup. */
export async function composeOwnerServices(
  app: FastifyInstance,
  ctx: RouteContext,
  plane: Awaited<ReturnType<typeof createOwnedControlPlane>>,
) {
  const { runtime, presence, legacyDrain } = plane;
  startOwnerWorker(app, ctx.db, {
    name: 'reboot-handoffs',
    tables: ['agentRebootHandoffs'],
    select: (snapshot) =>
      snapshot
        .table('agentRebootHandoffs')
        .all()
        .filter((row) => ['prepared', 'armed'].includes(row.status))
        .map((row) => ({
          key: row.id,
          dueAt: Date.parse(row.expiresAt),
          revision: JSON.stringify([row.status, row.expiresAt, row.updatedAt]),
        })),
    run: async () => {
      await expireRebootHandoffs(ctx.db, new Date().toISOString());
    },
    error: (err) => app.log.error({ err }, 'reboot handoff expiry failed'),
  });
  await createWrapperSigningKeyService(ctx).allActive();
  const insecure = new InsecureWindowAdminService({ ...ctx, events: makeAdminEventsWriter(ctx.db) });
  const providerUsage = createProviderUsageCommands(ctx.db, ctx.env, ctx.keyring);
  const handlers = {
    ...createAuxiliaryMaintenanceHandlers(app, ctx),
    ...createOwnerProviderMaintenance(app, ctx),
    messaging: async () => {
      await maintainOwnedMessaging(runtime);
      return { observed: true };
    },
    'insecure-expiry': async () => {
      await insecure.sweepIfLapsed();
      await insecure.sweepStaleRequests();
      return { observed: true };
    },
    'grok-usage': (work) => providerUsage('grok-usage', work),
    'chatgpt-usage': (work) => providerUsage('chatgpt-usage', work),
  } satisfies Partial<Record<OwnerMaintenanceOperation, OwnerMaintenanceHandler>>;
  const operations: OwnerMaintenanceOperation[] = [
    'messaging',
    'insecure-expiry',
    'transfer-expiry',
    'transfer-orphans',
    'auth-retention',
    'grok-usage',
    'chatgpt-usage',
    'skill-source',
    'feedback',
    'wrapper-rollout',
    'auth-verification',
    'quota-notices',
    'schedules',
    'watchdogs',
    'supervisor',
    'portal-retention',
  ];
  for (const operation of operations)
    if (!handlers[operation]) throw new Error(`Missing owner maintenance implementation: ${operation}`);
  let factRevision = 0;
  const listeners = new Set<() => void>();
  const bus = new AgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const stopPresence = presence.subscribe((change) => {
    factRevision++;
    for (const wake of listeners) wake();
    if (
      change.connected &&
      change.attachment.scope.topic === 'receiver' &&
      change.attachment.scope.session_id
    )
      void withOwnerBackgroundScope(() =>
        bus.notifyPresenceReturn(change.attachment.scope.session_id!),
      ).catch((err) => app.log.error({ err }, 'owner presence notification failed'));
  });
  const stopLegacy = legacyDrain.subscribe(() => {
    factRevision++;
    for (const wake of listeners) wake();
  });
  bindOwnerMaintenanceCommands(ctx.db, {
    retention: plane.retention,
    facts: {
      relayConnected: (id) => presence.hasRelay(id),
      relayHeldWorkGoneAt: (snapshot, message) => relayHeldWorkGoneAt(runtime, snapshot, message),
      sessionConnected: (id, generation) =>
        presence.hasSession(id, generation) || legacyDrain.session(id, generation),
      receiverConnected: (id, generation, receiver) =>
        presence.hasReceiver(id, generation, receiver) || legacyDrain.receiver(id, generation, receiver),
      revision: () => String(factRevision),
      conferenceHasPendingDeliveries: (id) => conferenceHasOwnedDeliveries(runtime.state.snapshot(), id),
    },
    subscribeFacts(wake) {
      listeners.add(wake);
      return () => {
        listeners.delete(wake);
      };
    },
    run: (operation, work) => handlers[operation]!(work),
  });
  const effects = createCompanionEffectHandlers(ctx);
  const stopMedia = await startMediaResultWatch(ctx.env.DATA_ROOT ?? 'storage', {
    error: (err) => {
      app.log.error({ err }, 'media result watch failed');
      void app.close();
    },
  });
  effects.set(
    'attachment.media_prepare',
    mediaPrepareEffect(ctx.db, new ChatAttachments(ctx.db, ctx.keyring, ctx.env.DATA_ROOT ?? 'storage')),
  );
  const mailer = createMailer(ctx.env, app.log);
  effects.set('admin.password.reset.email', async ({ payload }) => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      typeof payload.to !== 'string' ||
      typeof payload.subject !== 'string' ||
      typeof payload.text !== 'string'
    )
      throw new Error('Invalid durable password reset email');
    const sent = await mailer.send(payload as unknown as MailMessage);
    return { status: sent.delivered ? 'delivered' : 'uncertain' };
  });
  const outbox = new OutboxDispatcher(runtime, {
    handlers: effects,
    replaySafeKinds: new Set(['attachment.media_prepare']),
    async readPayload(id) {
      const [row] = await ctx.db
        .select({ payload: controlPlaneOutbox.payloadEnc })
        .from(controlPlaneOutbox)
        .where(eq(controlPlaneOutbox.id, id));
      if (!row) throw new Error('Missing durable outbox payload');
      return JSON.parse(decrypt(row.payload, ctx.keyring)) as Json;
    },
    error: (err, id) => app.log.error({ err, outbox_id: id }, 'owner external effect failed'),
  });
  app.addHook('onClose', async () => {
    stopMedia();
    stopPresence();
    stopLegacy();
    listeners.clear();
    await outbox.close();
    await flushGatewayKeyUsage(runtime);
  });
  await outbox.start();
  return { outbox };
}
