import { withNativePrincipal } from '../../control-plane/state/native-principal.js';
import { ownerRuntimeFor } from '../../control-plane/state/runtime.js';
import { ownerPresence } from '../../control-plane/presence.js';
import { livenessDueAt } from '../../control-plane/state/owner-liveness.js';
import { GitDirectorNotifications } from '../../services/git-director/notifications.js';
import { normalizePath } from '../../services/git-director.js';
import { SettingsService } from '../../services/settings.js';
import { and, eq } from 'drizzle-orm';
import { gitWorktrees, gitClones, gitMergeRequests } from '../../db/schema.js';
import { GitDirectorService } from '../../services/git-director.js';
import { remoteGitOwner } from '../../services/git-director/remote.js';
import { ForbiddenError } from '../../http/errors.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { UnauthorizedError } from '../../http/errors.js';
import type { AgentMessagingService } from '../../services/agent-messaging.js';
import { AgentCoordination } from '../../services/agent-coordination/index.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import { wsPublisher } from '../../ws/publisher.js';

export function registerCoordinationRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  messaging: AgentMessagingService,
) {
  const service = new AgentCoordination(ctx.db, ctx.env, ctx.keyring, messaging);
  const audit = createAdminEventsService(ctx.db);
  const director = new GitDirectorService({ db: ctx.db, settings: new SettingsService(ctx.db), notifications: new GitDirectorNotifications(messaging), cloneArchiveDays: ctx.env.GIT_DIRECTOR_CLONE_ARCHIVE_DAYS });
  const bridge = (req: FastifyRequest) => {
    const token = req.headers['x-agent-bridge-token'];
    if (typeof token !== 'string' || !token) throw new UnauthorizedError('Bridge credential required');
    return {
      id: z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      token,
    };
  };
  const operations: Record<string, (id: string, token: string, body: unknown) => Promise<unknown>> = {
    'context/get': (id, token) => service.context(id, token),
    'context/update': (id, token, body) => service.update(id, token, body),
    'rooms/list': (id, token) => service.context(id, token),
    'rooms/read': (id, token, body) => service.read(id, token, body),
    'rooms/send': (id, token, body) => service.send(id, token, body),
    'claims/acquire': (id, token, body) => service.claims.acquire(id, token, body),
    'claims/status': (id, token, body) => service.claims.status(id, token, body),
    'claims/release': (id, token, body) => service.claims.release(id, token, body),
  };
  const invoke = (path: string, req: FastifyRequest) => {
    const { id, token } = bridge(req);
    return operations[path]!(id, token, req.body ?? {});
  };
  app.post('/host/agent-sessions/:id/agent-messaging/context/get', (req) => invoke('context/get', req));
  app.post('/host/agent-sessions/:id/agent-messaging/context/update', (req) => invoke('context/update', req));
  app.post('/host/agent-sessions/:id/agent-messaging/rooms/list', (req) => invoke('rooms/list', req));
  app.post('/host/agent-sessions/:id/agent-messaging/rooms/read', (req) => invoke('rooms/read', req));
  app.post('/host/agent-sessions/:id/agent-messaging/rooms/send', (req) => invoke('rooms/send', req));
  app.post('/host/agent-sessions/:id/agent-messaging/git/remote', async (req) => {
    const { id, token } = bridge(req);
    await messaging.self(id, token);
    const { session } = await messaging.authenticateBridge(id, token);
    const canonicalPath = z.string().startsWith('/').refine((v) => !v.includes('\0') && !v.split('/').includes('..'), 'Canonical absolute path required').transform(normalizePath);
    const input = z.object({
      target_host_id: z.number().int().positive(), claim_id: z.string().uuid(),
      common_dir: canonicalPath, branch: z.string().min(1).max(255),
      operation: z.enum(['register', 'join', 'list', 'merge_request', 'merge_status', 'release']),
      args: z.object({ worktree_path: canonicalPath }).catchall(z.unknown()),
    }).strict().parse(req.body);
    if (!(await director.getEnabled())) throw new ForbiddenError('Git Director is disabled');
    const proof = { sessionId: id, generation: session.bindingGeneration, claimId: input.claim_id,
      hostId: input.target_host_id, commonDir: input.common_dir, branch: input.branch, worktreePath: input.args.worktree_path };
    if (input.args.target_branch !== undefined && input.args.target_branch !== input.branch)
      throw new ForbiddenError('Target branch must match the claimed remote branch', 'git_remote_scope_mismatch');
    const { host } = await remoteGitOwner(ctx.db, proof);
    const args = { ...input.args, clone_dir: input.common_dir, engine: session.engine, username: session.username };
    // Only this bridge-authenticated route can supply private provenance. A
    // remote host key cannot impersonate the originating managed session.
    if (input.operation === 'register') return withNativePrincipal({ sessionId: id, bridgeToken: token }, () => director.register(args, host, proof));
    const runtime=ownerRuntimeFor(ctx.db),snapshot=runtime?.state.snapshot();
    const registration=snapshot?snapshot.table('gitWorktrees').by('hostId',host.id).flatMap(worktree=>{
      const clone=snapshot.table('gitClones').get(worktree.cloneId);
      return clone&&worktree.worktreePath===input.args.worktree_path&&clone.cloneDir===input.common_dir&&worktree.status==='active'?[{worktree,clone}]:[];
    })[0]:(await ctx.db.select({worktree:gitWorktrees,clone:gitClones}).from(gitWorktrees).innerJoin(gitClones,eq(gitWorktrees.cloneId,gitClones.id)).where(and(eq(gitWorktrees.hostId,host.id),eq(gitWorktrees.worktreePath,input.args.worktree_path),eq(gitClones.cloneDir,input.common_dir),eq(gitWorktrees.status,'active'))).limit(1))[0];
    if (!registration || registration.worktree.agentSessionId !== id || registration.worktree.agentBindingGeneration !== session.bindingGeneration)
      throw new ForbiddenError('Remote registration belongs to another session binding', 'git_remote_binding_stale');
    if (typeof input.args.request_id === 'string') {
      const request=snapshot?snapshot.table('gitMergeRequests').get(input.args.request_id):(await ctx.db.select().from(gitMergeRequests).where(eq(gitMergeRequests.id,input.args.request_id)))[0];
      if (!request || request.worktreeId !== registration.worktree.id)
        throw new ForbiddenError('Remote request belongs to another worktree', 'git_remote_scope_mismatch');
    }
    const methods = { join: 'join', list: 'list', merge_request: 'requestMerge', merge_status: 'mergeStatus', release: 'release' } as const;
    const method = methods[input.operation];
    return withNativePrincipal({ sessionId: id, bridgeToken: token }, () => director[method](args, host));
  });
  app.post('/host/agent-sessions/:id/agent-messaging/claims/acquire', (req) => invoke('claims/acquire', req));
  app.post('/host/agent-sessions/:id/agent-messaging/claims/status', (req) => invoke('claims/status', req));
  app.post('/host/agent-sessions/:id/agent-messaging/claims/release', (req) => invoke('claims/release', req));
  app.get('/admin/agent-messaging/scopes/state', { preHandler: app.requireAdmin }, () => service.state());
  app.post('/admin/agent-messaging/scopes/state', { preHandler: app.requireAdmin }, async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return service.setEnabled(enabled, req.admin!.user.id);
  });
  app.get('/admin/agent-messaging/scopes', { preHandler: app.requireAdmin }, async () =>
    (await messaging.isEnabled())
      ? service.context(null, null)
      : { enabled: false, rooms: [], claims: [], reason: 'messaging_disabled' },
  );
  app.get('/admin/agent-messaging/scopes/:scopeId/members', { preHandler: app.requireAdmin }, (req) =>
    service.memberPage(
      z
        .string()
        .uuid()
        .parse((req.params as { scopeId: string }).scopeId),
      z.coerce
        .number()
        .int()
        .nonnegative()
        .default(0)
        .parse((req.query as { offset?: string }).offset),
    ),
  );
  app.post('/admin/agent-messaging/scopes/read', { preHandler: app.requireAdmin }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const result = await service.read(null, null, req.body);
    await audit.record(
      {
        type: 'agent_coordination.revealed',
        payload: { scope_id: result.scope.id, admin_user_id: req.admin!.user.id },
      },
      { broadcast: false },
    );
    return result;
  });
  app.post('/admin/agent-messaging/scopes/send', { preHandler: app.requireAdmin }, (req) =>
    service.send(null, null, req.body, { id: req.admin!.user.id, name: req.admin!.user.name }),
  );
  app.post('/admin/agent-messaging/scopes/resolve', { preHandler: app.requireAdmin }, async (req) => {
    const result = await service.claims.release(null, null, req.body, req.admin!.user.id);
    if (!ownerRuntimeFor(ctx.db)) await audit.record(
      {
        type: 'agent_coordination.resolved',
        payload: {
          claim_id: result.id,
          admin_user_id: req.admin!.user.id,
          outcome: (req.body as { outcome: string }).outcome,
          reason: (req.body as { reason: string }).reason,
        },
      },
      { broadcast: false },
    );
    return result;
  });
  const owner = ownerRuntimeFor(ctx.db);
  if (owner) {
    const key = 'coordination:event', pendingKey = 'coordination:pending', gitKey='coordination:git-expiry', livenessKey='coordination:liveness';
    let closed = false, running: Promise<void> | undefined, again = false;
    const armPending = () => {
      const snapshot=owner.state.snapshot();
      owner.deadlines.cancel(gitKey);
      const leases=snapshot.table('gitMergeRequests').all().filter(row=>row.verdict==='allow'&&!row.completedAt&&row.leaseExpiresAt).map(row=>Date.parse(row.leaseExpiresAt!)).filter(Number.isFinite);
      if(leases.length)owner.deadlines.schedule(gitKey,Math.max(Date.now()+1,Math.min(...leases)),run);
      // Grace periods elapse without any state or presence change, so they need
      // their own wake-up. The floor stops a due item that something else still
      // holds (a present successor, an armed reboot) from spinning the tick.
      owner.deadlines.cancel(livenessKey);
      const liveness=livenessDueAt(owner,snapshot,ctx.env.AGENT_PORTAL_BRIDGE_TTL_SECONDS*1000);
      if(liveness!==null)owner.deadlines.schedule(livenessKey,Math.max(Date.now()+30_000,liveness),run);
      if(snapshot.setting('agent_coordination_enabled')!=='1'||snapshot.setting('agent_messaging_enabled')!=='1'){owner.deadlines.cancel(pendingKey);return;}
      const due = owner.state.snapshot().table('agentScopeEvents').all().filter(row => row.dispatched === 0).map(row => Date.parse(row.createdAt)+2000).filter(Number.isFinite);
      owner.deadlines.cancel(pendingKey);
      if (due.length) owner.deadlines.schedule(pendingKey, Math.max(Date.now()+1,Math.min(...due)), run);
    };
    const run = () => {
      if (closed) return;
      if (running) { again=true; return; }
      let failed=false;
      running=service.tick().then(()=>director.reconcileOwned()).catch(error=>{
        failed=true;
        app.log.error({err:error},'Scope coordination event failed');
        if (!closed) owner.deadlines.schedule(key,Date.now()+5000,run);
      }).finally(()=>{
        running=undefined;
        if (!closed) { if(!failed)armPending(); if(again){again=false; schedule();} }
      });
    };
    const schedule=()=>{if(!closed)owner.deadlines.schedule(key,Date.now(),run);};
    let observed = owner.state.snapshot();
    const unsubscribeState=owner.state.subscribe(snapshot=>{
      const relevant=['agentSessions','hosts','versions','agentScopeBindings','agentResourceClaims','agentScopeEvents','gitWorktrees','gitMergeRequests'] as const;
      const changed=relevant.some(table=>observed.table(table)!==snapshot.table(table)); observed=snapshot;
      if(changed)schedule();
    });
    const unsubscribePresence=ownerPresence(owner).subscribe(schedule);
    schedule();
    app.addHook('onClose',async()=>{closed=true;unsubscribeState();unsubscribePresence();owner.deadlines.cancel(key);owner.deadlines.cancel(pendingKey);owner.deadlines.cancel(gitKey);owner.deadlines.cancel(livenessKey);await running;});
    return;
  }
  // Reconciliation follows the events that change its input. The fallback only
  // catches time-based transitions: presence freshness, claim expiry, and the
  // 2 s dispatch delay of a scope event that nobody announced. A blind 2 s
  // interval cost one ~6,000-row input snapshot every tick (2026-10-23).
  let running: Promise<void> | undefined;
  let again = false;
  let soon: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (running) {
      again = true;
      return;
    }
    running = service
      .tick()
      .catch((error) => app.log.error({ err: error }, 'Scope coordination tick failed'))
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          schedule();
        }
      });
  };
  const schedule = () => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = undefined;
      run();
    }, COORDINATION_EVENT_DELAY_MS);
    soon.unref();
  };
  const unsubscribe = wsPublisher.subscribe(({ type }) => {
    if (COORDINATION_INPUT_EVENTS.test(type)) schedule();
  });
  const timer = setInterval(run, COORDINATION_FALLBACK_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    unsubscribe();
    clearInterval(timer);
    if (soon) clearTimeout(soon);
    await running;
  });
}

/** Just past the 2 s scope-event dispatch delay, so one tick sees the new event as due. */
const COORDINATION_EVENT_DELAY_MS = 2100;
const COORDINATION_FALLBACK_MS = 10_000;
const COORDINATION_INPUT_EVENTS =
  /^(agent_portal\.sessions\.|agent_coordination\.|agent_messaging\.(address|state|host|relay)\.|host\.(?!daemon\.)|settings\.|engine\.|auth\.invalidated|apikey\.|project\.)/;
