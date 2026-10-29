import { ownerRuntimeFor, mutateOwnerState } from '../../control-plane/state/runtime.js';
import { stageDelete } from '../../control-plane/state/rows.js';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { RouteContext } from '../../routes/index.js';
import {
  agentEvents,
  companionDaemonFollows,
  companionFollows,
  hostDaemons,
  hostDaemonPortalBindings,
  hostDaemonSessions,
  hostDaemonOperations,
} from '../../db/schema.js';
import { HostDaemonService } from '../host-daemon/service.js';
import { assertHostEngineEnabled } from '../host-engine-policy.js';
import { createAgentPortalService } from '../agent-portal.js';
import { readFleetEngineState } from '../engine-switch.js';
import type { Engine } from '../../util/engine.js';
import { ForbiddenError } from '../../http/errors.js';
import { decrypt } from '../../security/secret-box.js';
import { DAEMON_PERMISSION_MODES, permissionModesFor } from '../host-daemon/permission-mode.js';

export const companionStartSchema = z
  .object({
    host_id: z.number().int().positive(),
    engine: z.enum(['codex', 'claude', 'grok']),
    cwd: z.string().max(1024).optional(),
    title: z.string().trim().max(160).default(''),
    task: z.string().trim().max(32768).default(''),
    client_message_id: z.string().uuid(),
    // C7: `plan` runs every turn in native plan mode until the plan is approved.
    permission_mode: z.enum(DAEMON_PERMISSION_MODES).optional(),
  })
  .strict()
  .refine((body) => body.permission_mode !== 'plan' || body.task.length > 0, {
    path: ['task'],
    message: 'Plan mode needs a task to plan',
  });

export function contactPrompt(task: string): string {
  return `This session was started by the operator from the Android companion. Confirm your managed identity with agent_self and use agent_session_name for a concise task title. Send a real greeting to the operator through cxx portal say --text with your current name and readiness, and include --summary (one sentence, at most 160 characters). ${task ? 'Then handle the operator task below. Send your result or question through cxx portal say or cxx portal ask, including --summary.' : 'Only establish contact. Do not inspect or change project files and do not begin any other work. After the greeting, end this turn; the host daemon can resume this same native transcript when the operator sends an instruction.'}${task ? `\n\nOperator task:\n${task}` : ''}`;
}

export function hostStartable(host: {
  health: { reasons: string[] };
  engines: string[];
  free_slots: number;
}): boolean {
  return (
    host.engines.length > 0 &&
    host.free_slots > 0 &&
    host.health.reasons.every((r) => r === 'engines_partially_ready')
  );
}

/** Device-facing projections only. No runtime credentials or operation output in host cards. */
export class CompanionRemote {
  readonly daemon: HostDaemonService;
  constructor(private readonly ctx: RouteContext) {
    this.daemon = new HostDaemonService(ctx);
  }
  async hosts() {
    const owner = ownerRuntimeFor(this.ctx.db); owner?.assertOwner();
    const rows = owner ? owner.state.snapshot().table('hostDaemons').all() : await this.ctx.db.select().from(hostDaemons);
    return Promise.all(
      rows
        .filter((r) => r.settings.enabled)
        .map(async (r) => {
          const view = await this.daemon.view(r.hostId);
          const used = view.sessions.filter((s) =>
            ['queued', 'running', 'stopping'].includes(s.status),
          ).length;
          const host = {
            host_id: view.host_id,
            fqdn: view.fqdn,
            default_cwd: view.default_cwd,
            access: view.access,
            engines: view.engines,
            // Per engine: the permission modes a start on this host accepts.
            permission_modes: Object.fromEntries(
              view.engines.map((engine) => [engine, permissionModesFor(engine, view.permission_mode_version)]),
            ),
            health: {
              ...view.health,
              used_slots: used,
              reasons: view.health.reasons.map((reason) =>
                [
                  'installation_pending',
                  'heartbeat_expired',
                  'reconnecting',
                  'service_user_mismatch',
                  'no_engine_ready',
                  'engines_partially_ready',
                  'busy',
                  'host_access_blocked',
                  'insecure_window_closed',
                  'messaging_or_api_disabled',
                ].includes(reason)
                  ? reason
                  : 'daemon_error',
              ),
            },
            free_slots: Math.max(0, view.max_parallel - used),
          };
          return { ...host, startable: hostStartable(host) };
        }),
    );
  }
  async find(id: string, userId: number) {
    const owner = ownerRuntimeFor(this.ctx.db); owner?.assertOwner();
    const row = owner ? owner.state.snapshot().table('hostDaemonSessions').get(id) : (await this.ctx.db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.id, id)))[0];
    if (!row) return null;
    if (row.owner !== `admin:${userId}`)
      throw new ForbiddenError('This remote conversation belongs to another operator');
    const host = await this.daemon.host(row.hostId);
    if (host.status !== 'active') throw new ForbiddenError('Host is inactive');
    assertHostEngineEnabled(host, row.engine as Engine, await readFleetEngineState(this.ctx.db));
    if (row.sessionId)
      await createAgentPortalService(this.ctx.db, this.ctx.env, this.ctx.keyring).listEvents(
        row.sessionId,
        0,
        1,
        true,
      );
    return row;
  }
  async hasOperation(clientId: string, userId: number) {
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) { owner.assertOwner(); return owner.state.snapshot().table('hostDaemonOperations').all().some(row => row.clientKey === `admin:${userId}:${clientId}`); }
    return !!(
      await this.ctx.db
        .select()
        .from(hostDaemonOperations)
        .where(eq(hostDaemonOperations.clientKey, `admin:${userId}:${clientId}`))
        .limit(1)
    ).length;
  }
  async project(userId: number, sessions: Array<Record<string, unknown>>) {
    const owner = ownerRuntimeFor(this.ctx.db); owner?.assertOwner(); const state = owner?.state.snapshot();
    const rows = state ? state.table('hostDaemonSessions').all().filter(row => row.owner === `admin:${userId}`) : await this.ctx.db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.owner, `admin:${userId}`));
    const hosts = await this.hosts();
    const bindings = rows.length
      ? state ? state.table('hostDaemonPortalBindings').all().filter(binding => rows.some(row => row.id === binding.daemonSessionId)) : await this.ctx.db
          .select()
          .from(hostDaemonPortalBindings)
          .where(
            inArray(
              hostDaemonPortalBindings.daemonSessionId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    const byId = new Map(sessions.map((s) => [String(s.id), s]));
    const aliases = new Map(bindings.map((b) => [b.portalSessionId, b.daemonSessionId]));
    const projected: Array<Record<string, unknown>> = sessions.filter((s) => !aliases.has(String(s.id)));
    for (const row of rows) {
      // Established launches follow Portal's visibility/retention rules.
      const related = bindings.filter(b => b.daemonSessionId === row.id).map(b => byId.get(b.portalSessionId)).filter((s): s is Record<string, unknown> => !!s);
      const notices = related.flatMap(s => (s.notices ?? []) as Array<Record<string, unknown>>);
      const rank: Record<string,number> = {important:1,critical:2,blocker:3};
      notices.sort((a,b) => (rank[String(b.severity)] ?? 0) - (rank[String(a.severity)] ?? 0));
      const bound = (row.sessionId ? byId.get(row.sessionId) : undefined) ?? (notices.length ? related[0] : undefined);
      if (row.sessionId && !bound) continue;
      const host = hosts.find((h) => h.host_id === row.hostId);
      if (!host?.engines.includes(row.engine) && !bound) continue;
      const resumable =
        ['idle', 'waiting'].includes(row.status) &&
        !!row.addressId &&
        !!bound?.upstream_session_id &&
        !!host?.startable &&
        host.engines.includes(row.engine);
      const running = row.status === 'running';
      // The persisted operation state survives lost connections. Only a fresh
      // daemon or a reachable bound agent can justify live working presence.
      const daemonOnline = !!host && host.health.state !== 'disabled' &&
        !host.health.reasons.some((reason) =>
          ['heartbeat_expired', 'reconnecting', 'installation_pending'].includes(reason));
      const writable = resumable || (running && bound?.relay_ready === true && bound.read_only !== true);
      projected.push({
        ...bound,
        id: row.id,
        daemon_session: true,
        portal_session_id: row.sessionId,
        host: host?.fqdn ?? bound?.host,
        cwd: row.cwd,
        engine: row.engine,
        permission_mode: row.permissionMode ?? 'default',
        session_name: bound?.session_name ?? row.title,
        task_title: row.title,
        upstream_session_id: bound?.upstream_session_id ?? null,
        presence: writable
          ? running
            ? (bound?.presence ?? 'working')
            : 'listening'
          : ['queued', 'running', 'stopping'].includes(row.status)
            ? daemonOnline ? 'working' : 'offline'
            : ['closed', 'failed', 'unknown'].includes(row.status)
              ? 'ended'
              : 'offline',
        relay_ready: writable,
        read_only:
          ['closed', 'failed', 'unknown'].includes(row.status) ||
          (['idle', 'waiting'].includes(row.status) && !bound?.upstream_session_id),
        remote_status:
          ['idle', 'waiting'].includes(row.status) && !bound?.upstream_session_id ? 'unknown' : row.status,
        notices,
        attention: notices[0] ?? bound?.attention ?? null,
        pending_prompt: bound?.pending_prompt ?? null,
        last_event_at: bound?.last_event_at ?? row.createdAt,
        preview: null,
      });
    }
    return { sessions: projected, aliases };
  }
  async events(id: string, userId: number, after: number, tail: boolean) {
    const remote = await this.find(id, userId);
    if (!remote) return null;
    const state = ownerRuntimeFor(this.ctx.db)?.state.snapshot();
    const bindings = state ? state.table('hostDaemonPortalBindings').by('daemonSessionId', id) : await this.ctx.db
      .select()
      .from(hostDaemonPortalBindings)
      .where(eq(hostDaemonPortalBindings.daemonSessionId, id));
    if (!bindings.length) return { events: [], next_cursor: after };
    const rows = await this.ctx.db
      .select()
      .from(agentEvents)
      .where(
        and(
          inArray(
            agentEvents.sessionId,
            bindings.map((b) => b.portalSessionId),
          ),
          ...(tail ? [] : [gt(agentEvents.id, after)]),
        ),
      )
      .orderBy(tail ? desc(agentEvents.id) : asc(agentEvents.id))
      .limit(250);
    if (tail) rows.reverse();
    return {
      events: rows.map((e) => ({
        cursor: e.id,
        session_id: id,
        type: e.eventType,
        source: e.source,
        payload: JSON.parse(decrypt(e.payloadEnc, this.ctx.keyring)) as Record<string, unknown>,
        created_at: e.createdAt,
      })),
      next_cursor: rows.at(-1)?.id ?? after,
    };
  }
  async follow(deviceId: string, id: string, value: boolean) {
    const owner = ownerRuntimeFor(this.ctx.db);
    if (owner) {
      await mutateOwnerState(owner, { kind: 'companion.remote.follow', payload: { deviceId, id, value }, prepare(context) {
        const bindings = context.draft.table('hostDaemonPortalBindings').by('daemonSessionId', id);
        if (value) {
          const remote = { deviceId, daemonSessionId: id }; context.draft.upsert('companionDaemonFollows', remote);
          context.write(async tx => { await tx.insert(companionDaemonFollows).values(remote).onDuplicateKeyUpdate({ set: { daemonSessionId: id } }); });
          for (const binding of bindings) { const row = { deviceId, sessionId: binding.portalSessionId }; context.draft.upsert('companionFollows', row); context.write(async tx => { await tx.insert(companionFollows).values(row).onDuplicateKeyUpdate({ set: { sessionId: row.sessionId } }); }); }
        } else {
          stageDelete(context, 'companionDaemonFollows', [deviceId, id]);
          for (const binding of bindings) stageDelete(context, 'companionFollows', [deviceId, binding.portalSessionId]);
        }
        return null;
      } }); return;
    }
    const bindings = await this.ctx.db
      .select()
      .from(hostDaemonPortalBindings)
      .where(eq(hostDaemonPortalBindings.daemonSessionId, id));
    if (value) {
      await this.ctx.db
        .insert(companionDaemonFollows)
        .values({ deviceId, daemonSessionId: id })
        .onDuplicateKeyUpdate({ set: { daemonSessionId: id } });
      for (const b of bindings)
        await this.ctx.db
          .insert(companionFollows)
          .values({ deviceId, sessionId: b.portalSessionId })
          .onDuplicateKeyUpdate({ set: { sessionId: b.portalSessionId } });
    } else {
      await this.ctx.db
        .delete(companionDaemonFollows)
        .where(
          and(eq(companionDaemonFollows.deviceId, deviceId), eq(companionDaemonFollows.daemonSessionId, id)),
        );
      if (bindings.length)
        await this.ctx.db.delete(companionFollows).where(
          and(
            eq(companionFollows.deviceId, deviceId),
            inArray(
              companionFollows.sessionId,
              bindings.map((b) => b.portalSessionId),
            ),
          ),
        );
    }
  }
}
