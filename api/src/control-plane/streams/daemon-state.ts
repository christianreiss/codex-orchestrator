import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hostDaemons } from '../../db/schema.js';
import type { RouteContext } from '../../routes/index.js';
import type { OwnerRuntime, OwnerMutationContext } from '../state/runtime.js';
import { mutateOwnerState } from '../state/runtime.js';
import { stageUpdate } from '../state/rows.js';
import type { OwnerStateSnapshot } from '../state/store.js';
import { ownerPresence } from '../presence.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../http/errors.js';
import { daemonAccess } from '../../services/host-daemon/access.js';
import {
  daemonAccepting,
  daemonExpired,
  daemonSettingsSchema,
  type DaemonSettings,
  type DaemonRuntime,
} from '../../services/host-daemon/policy.js';
import { assertEngine } from './authorization.js';
import type { Engine } from '../../util/engine.js';
import { wsPublisher } from '../../ws/publisher.js';
import type { Json } from '../commands.js';

const now = () => new Date().toISOString();
export class DaemonState {
  constructor(
    readonly ctx: RouteContext,
    readonly owner: OwnerRuntime,
  ) {}
  host(id: number, s = this.owner.state.snapshot()) {
    this.owner.assertOwner();
    const host = s.hosts.get(id);
    if (!host) throw new NotFoundError('Host not found');
    return host;
  }
  settings(id: number, s = this.owner.state.snapshot()) {
    this.owner.assertOwner();
    const row = s.daemons.get(id);
    return row
      ? {
          ...row,
          settings: {
            ...row.settings,
            enabled: row.settings.enabled && !daemonExpired(row.settings),
            resident_enabled: row.settings.resident_enabled ?? false,
          },
        }
      : {
          hostId: id,
          settings: { ...daemonSettingsSchema.parse({}), resident_enabled: false },
          runtime: null,
          enabledAt: null,
          updatedAt: now(),
        };
  }
  eligible(id: number, engine?: Engine, drain = false, s = this.owner.state.snapshot()) {
    const host = this.host(id, s),
      config = this.settings(id, s);
    if (s.setting('api_disabled') === '1' || s.setting('agent_messaging_enabled') !== '1')
      throw new ForbiddenError('Agent messaging or API disabled');
    if ((!daemonAccepting(config.settings) && !drain) || host.status !== 'active')
      throw new ForbiddenError('Host daemon is not available', 'daemon_disabled');
    if (!drain && !daemonAccess(host).allowed)
      throw new ForbiddenError('Insecure host window is closed', 'daemon_insecure_window_closed');
    if (engine) assertEngine(s, host, engine);
    return config;
  }
  workAccess(s: OwnerStateSnapshot, id: number, engine?: Engine) {
    const host = this.host(id, s);
    if (!daemonAccess(host).allowed)
      throw new ForbiddenError('Host work access is blocked', 'daemon_insecure_window_closed');
    if (engine) assertEngine(s, host, engine);
    return host;
  }
  changed(id: number) {
    wsPublisher.publish('host.daemon.changed', { host_id: id });
  }
  cancelPending(c: OwnerMutationContext, id: number) {
    for (const op of c.draft
      .table('hostDaemonOperations')
      .by('hostId', id)
      .filter((o) => ['queued', 'offered'].includes(o.status)))
      stageUpdate(c, 'hostDaemonOperations', op.id, { status: 'canceled', updatedAt: now() });
    for (const session of c.draft
      .table('hostDaemonSessions')
      .by('hostId', id)
      .filter((s) => ['idle', 'waiting', 'queued'].includes(s.status)))
      stageUpdate(c, 'hostDaemonSessions', session.id, { status: 'closed', lastActivityAt: now() });
  }
  async configure(id: number, resolve: (settings: DaemonSettings) => DaemonSettings) {
    const requested = resolve(this.settings(id).settings);
    await mutateOwnerState(this.owner, {
      kind: 'daemon.configure',
      payload: { id, settings: requested } as unknown as Json,
      prepare: (c) => {
        this.host(id, c.snapshot);
        const old = c.snapshot.daemons.get(id);
        const settings = {
          ...requested,
          migration: old?.settings.migration,
          resident_enabled: requested.resident_enabled ?? old?.settings.resident_enabled ?? false,
          lifetime_minutes: requested.lifetime_minutes ?? old?.settings.lifetime_minutes,
          expires_at: old?.settings.expires_at ?? requested.expires_at,
        };
        if (
          c.snapshot
            .table('hostDaemonSessions')
            .by('hostId', id)
            .some((s) => ['running', 'stopping', 'queued'].includes(s.status)) &&
          old?.settings.username !== settings.username
        )
          throw new ConflictError('Stop sessions before changing the service user');
        const values = {
          settings,
          updatedAt: now(),
          enabledAt: settings.enabled ? (old?.settings.enabled ? old.enabledAt : now()) : null,
        };
        c.draft.upsert('hostDaemons', { hostId: id, runtime: old?.runtime ?? null, ...values });
        c.write((tx) =>
          tx
            .insert(hostDaemons)
            .values({ hostId: id, ...values })
            .onDuplicateKeyUpdate({ set: values }),
        );
        if (!settings.enabled) this.cancelPending(c, id);
        return null;
      },
    });
    this.changed(id);
  }
  async migration(id: number, requestId: string, command: 'fence' | 'status' | 'release') {
    if (command !== 'status')
      await mutateOwnerState(this.owner, {
        kind: 'daemon.migration',
        payload: { id, requestId, command },
        prepare: (c) => {
          this.host(id, c.snapshot);
          const row = c.snapshot.daemons.get(id);
          if (!row) throw new ConflictError('Resident settings are missing');
          if (row.settings.migration && row.settings.migration.request_id !== requestId)
            throw new ConflictError('Another migration holds admission', 'daemon_migration_conflict');
          const settings = { ...row.settings };
          if (command === 'fence') settings.migration = { request_id: requestId, fenced: true };
          else delete settings.migration;
          stageUpdate(c, 'hostDaemons', id, { settings, updatedAt: now() });
          return null;
        },
      });
    const s = this.owner.state.snapshot(),
      row = this.settings(id, s),
      work = s.table('hostDaemonSessions').by('hostId', id);
    const running = work.filter((w) => ['running', 'stopping'].includes(w.status)).length;
    const accepted = s
      .table('hostDaemonOperations')
      .by('hostId', id)
      .filter((o) => o.status === 'accepted').length;
    const claims = work
      .flatMap((w) => (w.addressId ? s.messages.by('targetAddressId', w.addressId) : []))
      .filter((m) => ['leased', 'accepted'].includes(m.status)).length;
    if (command !== 'status') this.changed(id);
    return {
      request_id: requestId,
      fenced: row.settings.migration?.request_id === requestId,
      ready: row.settings.migration?.request_id === requestId && !running && !accepted && !claims,
      running,
      accepted,
      peer_claims: claims,
    };
  }
  async connect(id: number, input: Omit<DaemonRuntime, 'generation' | 'heartbeat_at' | 'connected'>) {
    const result = await mutateOwnerState(this.owner, {
      kind: 'daemon.connect',
      payload: { id, input },
      prepare: (c) => {
        this.eligible(id, undefined, true, c.snapshot);
        const config = c.snapshot.daemons.get(id);
        if (!config || input.username !== config.settings.username)
          throw new ForbiddenError('Daemon service user does not match enabled host settings');
        if (
          config.runtime?.connected &&
          config.runtime.instance_id !== input.instance_id &&
          ownerPresence(this.owner).hasDaemon(id, config.runtime.instance_id)
        )
          throw new ConflictError('Another daemon instance is connected');
        const settings = { ...config.settings };
        if (settings.lifetime_minutes && !settings.expires_at)
          settings.expires_at = new Date(Date.now() + settings.lifetime_minutes * 60000).toISOString();
        const runtime = { ...input, generation: randomUUID(), heartbeat_at: now(), connected: true };
        stageUpdate(c, 'hostDaemons', id, { runtime, settings, updatedAt: now() });
        return {
          generation: runtime.generation,
          settings: { ...settings, enabled: daemonAccepting(settings) },
        } as unknown as Json;
      },
    });
    this.changed(id);
    return result as unknown as { generation: string; settings: DaemonSettings };
  }
  async heartbeat(id: number, generation: string, engines: string[], error: string | null) {
    const current = this.eligible(id, undefined, true);
    if (!current.runtime || current.runtime.generation !== generation)
      throw new ConflictError('Daemon generation changed');
    if (
      current.runtime.error !== error ||
      JSON.stringify(current.runtime.engines) !== JSON.stringify(engines)
    ) {
      await mutateOwnerState(this.owner, {
        kind: 'daemon.metadata',
        payload: { id, generation, engines, error },
        prepare: (c) => {
          this.eligible(id, undefined, true, c.snapshot);
          const row = c.snapshot.daemons.get(id);
          if (!row?.runtime || row.runtime.generation !== generation)
            throw new ConflictError('Daemon generation changed');
          stageUpdate(c, 'hostDaemons', id, {
            runtime: { ...row.runtime, engines, error },
            updatedAt: now(),
          });
          return null;
        },
      });
      this.changed(id);
    }
    const row = this.settings(id);
    return {
      settings: { ...row.settings, enabled: daemonAccepting(row.settings) },
      stop: this.owner.state
        .snapshot()
        .table('hostDaemonSessions')
        .by('hostId', id)
        .filter((s) => s.status === 'stopping')
        .map((s) => s.id),
    };
  }
  async disconnect(id: number, generation: string) {
    const row = this.owner.state.snapshot().daemons.get(id);
    if (!row?.runtime?.connected || row.runtime.generation !== generation) return;
    await mutateOwnerState(this.owner, {
      kind: 'daemon.disconnect',
      payload: { id, generation },
      prepare: (c) => {
        const current = c.snapshot.daemons.get(id);
        if (current?.runtime?.connected && current.runtime.generation === generation)
          stageUpdate(c, 'hostDaemons', id, {
            runtime: { ...current.runtime, connected: false },
            updatedAt: now(),
          });
        return null;
      },
    });
    this.changed(id);
  }
  async expirePending(id: number) {
    const current = this.owner.state.snapshot().daemons.get(id);
    if (!current || !daemonExpired(current.settings)) return;
    const snapshot = this.owner.state.snapshot();
    if (
      !snapshot
        .table('hostDaemonOperations')
        .by('hostId', id)
        .some((o) => ['queued', 'offered'].includes(o.status)) &&
      !snapshot
        .table('hostDaemonSessions')
        .by('hostId', id)
        .some((s) => ['idle', 'waiting', 'queued'].includes(s.status))
    )
      return;
    await mutateOwnerState(this.owner, {
      kind: 'daemon.expire',
      payload: { id },
      prepare: (c) => {
        const row = c.snapshot.daemons.get(id);
        if (row && daemonExpired(row.settings)) this.cancelPending(c, id);
        return null;
      },
    });
    this.changed(id);
  }
}
