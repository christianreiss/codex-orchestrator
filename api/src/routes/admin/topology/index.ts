import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ConflictError, NotFoundError } from '../../../http/errors.js';
import { roleHasCapability } from '../../../security/capabilities.js';
import { createAdminEventsService } from '../../../services/admin-events.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';
import { communicatorRegistry, type TerminateOutcome } from '../../../services/topology/communicator-registry.js';
import { TopologyService } from '../../../services/topology/service.js';

/**
 * The console's live connection tree and the one control the server itself can
 * exercise on it.
 *
 * Agent sessions are not stopped from here: the console calls the existing
 * `/admin/agent-sessions/:id/close[/force]` and `/admin/daemon-sessions/:id/stop`
 * contracts, which already own durable-work semantics, idempotency and audit.
 * What this module adds is the communicator socket, which nothing else could
 * reach, and the evidence that says which sessions ride on it.
 */

const disconnectSchema = z
  .object({
    client_message_id: z.string().uuid(),
    // What the operator was looking at. The connection id already names one
    // socket exactly; this makes a mismatched label an error rather than a surprise.
    expect: z
      .object({
        host_id: z.number().int().positive(),
        username: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

type DisconnectResult = {
  outcome: 'closed' | 'requested';
  connection_id: string;
  host_id: number;
  username: string;
  version: string;
  /** A communicator redials by itself; closing its socket never disables it. */
  reconnect_expected: true;
  affected: { agent_ids: string[]; leases_reported: number };
  replayed: boolean;
};

type TerminateResult = {
  outcome: Exclude<TerminateOutcome, 'not_connected' | 'unsupported' | 'in_progress'>;
  connection_id: string;
  host_id: number;
  username: string;
  version: string;
  /** The owner's own account of its process; this server cannot observe a pid. */
  process: { pid: number | null; started_at: string | null };
  /** The owner said, in its own words, that it will stop. */
  acknowledged: boolean;
  /** Its connection to this server then closed. */
  connection_closed: boolean;
  affected: { agent_ids: string[]; leases_reported: number };
  replayed: boolean;
};

const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const IDEMPOTENCY_MAX = 256;

export async function registerAdminTopologyRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const topology = new TopologyService(ctx);
  const events = createAdminEventsService(ctx.db);
  // `/admin/topology` is both this JSON snapshot and the console's own page: a
  // browser navigation (text/html) gets the SPA shell, the client's JSON call the data.
  const adminSpa = adminSpaHtmlPreHandler(ctx);
  const recent = new Map<string, { at: number; connectionId: string; kind: 'disconnect' | 'terminate'; result: DisconnectResult | TerminateResult }>();

  app.get('/admin/topology', { preHandler: [adminSpa, app.requireAdmin] }, async (req) => {
    const snapshot = await topology.snapshot();
    // Sessions are agent-portal data. `hosts.read` opens this route; a role that
    // may read hosts but not the portal sees the communicators without them.
    if (roleHasCapability(req.admin!.user.accessLevel, 'agent_portal.read')) return snapshot;
    return {
      ...snapshot,
      agents: [],
      communicators: snapshot.communicators.map((c) => ({ ...c, agent_ids: [] })),
      recent_disconnects: snapshot.recent_disconnects.map((d) => ({ ...d, affected_agent_ids: [] })),
      counts: { ...snapshot.counts, agents: 0, attributed: 0, stale: 0, unattributed: 0 },
    };
  });

  app.post('/admin/communicators/:id/disconnect', { preHandler: app.requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = disconnectSchema.parse(req.body ?? {});
    const admin = req.admin!.user;
    const actor = admin.username || admin.name || `admin:${admin.id}`;

    const now = Date.now();
    for (const [key, entry] of recent) if (now - entry.at > IDEMPOTENCY_TTL_MS) recent.delete(key);
    const replay = recent.get(body.client_message_id);
    if (replay) {
      if (replay.connectionId !== id || replay.kind !== 'disconnect') {
        throw new ConflictError('client_message_id was already used for another target', 'client_message_id_reused');
      }
      return { ...replay.result, replayed: true };
    }

    const target = communicatorRegistry.get(id);
    if (!target) {
      throw new NotFoundError('Communicator is not connected (it may already have disconnected)', 'communicator_not_connected');
    }
    if (body.expect && (body.expect.host_id !== target.view.host_id || body.expect.username !== target.view.username)) {
      throw new ConflictError('The connection no longer matches what was selected', 'communicator_target_changed', {
        host_id: target.view.host_id,
        username: target.view.username,
      });
    }

    // The children as the server knows them at this instant, not as the page
    // last drew them. Evidence is what makes a session this socket's child.
    const snapshot = await topology.snapshot();
    const node = snapshot.communicators.find((c) => c.id === id);
    const agentIds = node?.agent_ids ?? [...target.evidence.keys()];
    const result: DisconnectResult = {
      outcome: 'requested',
      connection_id: id,
      host_id: target.view.host_id,
      username: target.view.username,
      version: target.view.version,
      reconnect_expected: true,
      affected: { agent_ids: agentIds, leases_reported: target.view.sessions },
      replayed: false,
    };

    let failure: string | null = null;
    try {
      const closed = await communicatorRegistry.disconnect(id, actor);
      // `not_connected` here means it left between the lookup and the close:
      // the socket is gone, which is what was asked for.
      result.outcome = closed.outcome === 'requested' ? 'requested' : 'closed';
    } catch (error) {
      failure = error instanceof Error ? error.message : 'close failed';
      throw error;
    } finally {
      topology.invalidate();
      await events.record({
        type: 'communicator.disconnected',
        hostId: target.view.host_id,
        payload: {
          connection_id: id,
          host_id: target.view.host_id,
          username: target.view.username,
          version: target.view.version,
          outcome: failure ? 'failed' : result.outcome,
          error: failure,
          affected_count: agentIds.length,
          affected_agent_ids: agentIds.slice(0, 100),
          leases_reported: target.view.sessions,
          note: body.note ?? null,
          client_message_id: body.client_message_id,
          admin_user_id: admin.id,
        },
      });
    }

    if (recent.size >= IDEMPOTENCY_MAX) recent.delete(recent.keys().next().value as string);
    recent.set(body.client_message_id, { at: Date.now(), connectionId: id, kind: 'disconnect', result });
    return result;
  });

  app.post('/admin/communicators/:id/terminate', { preHandler: app.requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = disconnectSchema.parse(req.body ?? {});
    const admin = req.admin!.user;
    const actor = admin.username || admin.name || `admin:${admin.id}`;

    const now = Date.now();
    for (const [key, entry] of recent) if (now - entry.at > IDEMPOTENCY_TTL_MS) recent.delete(key);
    const replay = recent.get(body.client_message_id);
    if (replay) {
      if (replay.connectionId !== id || replay.kind !== 'terminate') {
        throw new ConflictError('client_message_id was already used for another target', 'client_message_id_reused');
      }
      return { ...replay.result, replayed: true };
    }

    const target = communicatorRegistry.get(id);
    if (!target) {
      throw new NotFoundError('Communicator is not connected (it may already have disconnected)', 'communicator_not_connected');
    }
    if (body.expect && (body.expect.host_id !== target.view.host_id || body.expect.username !== target.view.username)) {
      throw new ConflictError('The connection no longer matches what was selected', 'communicator_target_changed', {
        host_id: target.view.host_id,
        username: target.view.username,
      });
    }
    if (!target.capabilities.terminate) {
      throw new ConflictError(
        'This communicator never announced that it can be stopped remotely (it predates the control frame)',
        'communicator_terminate_unsupported',
      );
    }

    const snapshot = await topology.snapshot();
    const agentIds = snapshot.communicators.find((c) => c.id === id)?.agent_ids ?? [...target.evidence.keys()];
    let outcome: TerminateOutcome = 'unacknowledged';
    let observed = { pid: target.capabilities.pid, started_at: target.capabilities.started_at, reason: null as string | null };
    let failure: string | null = null;
    try {
      const stopped = await communicatorRegistry.terminate(id, actor, { ackMs: 5000, closeMs: 8000 });
      outcome = stopped.outcome;
      observed = { pid: stopped.pid, started_at: stopped.started_at, reason: stopped.reason };
    } catch (error) {
      failure = error instanceof Error ? error.message : 'terminate failed';
      throw error;
    } finally {
      topology.invalidate();
      await events.record({
        type: 'communicator.terminated',
        hostId: target.view.host_id,
        payload: {
          connection_id: id,
          host_id: target.view.host_id,
          username: target.view.username,
          version: target.view.version,
          reported_pid: observed.pid,
          outcome: failure ? 'failed' : outcome,
          error: failure ?? observed.reason,
          affected_count: agentIds.length,
          affected_agent_ids: agentIds.slice(0, 100),
          leases_reported: target.view.sessions,
          note: body.note ?? null,
          client_message_id: body.client_message_id,
          admin_user_id: admin.id,
        },
      });
    }
    if (outcome === 'not_connected') {
      throw new NotFoundError('Communicator is not connected (it may already have disconnected)', 'communicator_not_connected');
    }
    if (outcome === 'unsupported') {
      throw new ConflictError('This communicator cannot be stopped remotely', 'communicator_terminate_unsupported');
    }
    if (outcome === 'in_progress') {
      throw new ConflictError('A stop request for this communicator is already in flight', 'communicator_terminate_in_progress');
    }
    const result: TerminateResult = {
      outcome,
      connection_id: id,
      host_id: target.view.host_id,
      username: target.view.username,
      version: target.view.version,
      process: { pid: observed.pid, started_at: observed.started_at },
      acknowledged: outcome === 'terminated' || outcome === 'acknowledged',
      connection_closed: outcome === 'terminated',
      affected: { agent_ids: agentIds, leases_reported: target.view.sessions },
      replayed: false,
    };
    if (recent.size >= IDEMPOTENCY_MAX) recent.delete(recent.keys().next().value as string);
    recent.set(body.client_message_id, { at: Date.now(), connectionId: id, kind: 'terminate', result });
    return result;
  });
}
