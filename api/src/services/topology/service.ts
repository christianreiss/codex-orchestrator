import { visibleHost } from '../internal-hosts.js';
import { controlView } from '../native-stop.js';
import { nativeControlConnections } from '../native-control-connections.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { RouteContext } from '../../routes/index.js';
import { agentNativeControls, agentBusAddresses, hostDaemonPortalBindings, hostDaemonSessions, hosts } from '../../db/schema.js';
import { createAgentPortalService } from '../agent-portal.js';
import { communicatorRegistry, type CommunicatorRegistry } from './communicator-registry.js';
import { buildTopology, type DaemonBindingInput, type PortalSessionInput } from './build.js';
import type { TopologySnapshot } from './types.js';

const SNAPSHOT_TTL_MS = 1000;
const PROCESS_STARTED_MS = Date.now() - Math.round(process.uptime() * 1000);

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

function narrowSession(row: Record<string, unknown>): PortalSessionInput {
  const close = row.close as { requested_at?: string | null; state?: string } | null | undefined;
  return {
    id: text(row.id),
    engine: text(row.engine),
    host_id: Number(row.host_id),
    host: text(row.host),
    username: text(row.username),
    cwd: text(row.cwd),
    launch_name: typeof row.launch_name === 'string' ? row.launch_name : null,
    session_name: typeof row.session_name === 'string' ? row.session_name : null,
    invocation_kind: text(row.invocation_kind),
    presence: text(row.presence, 'offline'),
    status: text(row.status),
    relay_ready: row.relay_ready === true,
    started_at: text(row.started_at),
    heartbeat_at: text(row.heartbeat_at),
    ended_at: typeof row.ended_at === 'string' ? row.ended_at : null,
    close: close ? { requested_at: close.requested_at ?? null, state: close.state } : null,
  };
}

/**
 * Reads the live connection tree: the server at the root, the communicators
 * connected to it, and the agent sessions each one demonstrably carries.
 *
 * Sessions come from the portal's own projection rather than a second
 * derivation of presence — `services/agent-presence.ts` explains what that
 * drift cost the last time. Communicators come from the process-local
 * registry, which is also the only thing that can close one.
 */
export class TopologyService {
  private readonly portal;
  private cached: { at: number; value: TopologySnapshot } | null = null;
  private inflight: Promise<TopologySnapshot> | null = null;

  constructor(
    private readonly ctx: RouteContext,
    private readonly registry: CommunicatorRegistry = communicatorRegistry,
  ) {
    this.portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  }

  /** Drop the coalescing cache, so the next read reflects an action just taken. */
  invalidate(): void {
    this.cached = null;
  }

  async snapshot(): Promise<TopologySnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < SNAPSHOT_TTL_MS) return this.cached.value;
    // Concurrent readers (every WebSocket-driven refetch lands together) share
    // one build rather than each running the session projection.
    if (!this.inflight) {
      this.inflight = this.build().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async build(): Promise<TopologySnapshot> {
    const { db, env } = this.ctx;
    const portalEnabled = await this.portal.isEnabled();
    const projection = portalEnabled ? await this.portal.listAgentsSnapshot() : { sessions: [] };
    const sessions = projection.sessions.map(narrowSession).filter((session) => !session.ended_at);
    // Observe after the projection: a heartbeat that landed while it ran is
    // contact, not a timestamp from the future.
    const now = Date.now();
    const communicators = this.registry.snapshot(now);

    const sessionIds = sessions.map((session) => session.id);
    const hostIds = [...new Set([...communicators.map((c) => c.view.host_id), ...this.registry.tombstones(now).map((t) => t.host_id), ...sessions.map((s) => s.host_id)])];

    const [hostRows, addressRows, daemonRows] = await Promise.all([
      hostIds.length
        ? db.select({ id: hosts.id, fqdn: hosts.fqdn }).from(hosts).where(and(inArray(hosts.id, hostIds), visibleHost))
        : Promise.resolve([]),
      sessionIds.length
        ? db
            .select({
              sessionId: agentBusAddresses.currentSessionId,
              address: agentBusAddresses.address,
              alias: agentBusAddresses.displayAlias,
              generation: agentBusAddresses.bindingGeneration,
            })
            .from(agentBusAddresses)
            .where(inArray(agentBusAddresses.currentSessionId, sessionIds))
        : Promise.resolve([]),
      sessionIds.length
        ? db
            .select({
              portalSessionId: hostDaemonPortalBindings.portalSessionId,
              daemonSessionId: hostDaemonSessions.id,
              status: hostDaemonSessions.status,
            })
            .from(hostDaemonPortalBindings)
            .innerJoin(hostDaemonSessions, eq(hostDaemonSessions.id, hostDaemonPortalBindings.daemonSessionId))
            .where(and(inArray(hostDaemonPortalBindings.portalSessionId, sessionIds)))
        : Promise.resolve([]),
    ]);

    const addresses = new Map(
      addressRows.flatMap((row) =>
        row.sessionId
          ? [[row.sessionId, { address: row.address, alias: row.alias ?? null, binding_generation: row.generation ?? null }] as const]
          : [],
      ),
    );
    const daemonBySession = new Map<string, DaemonBindingInput>(
      daemonRows.map((row) => [row.portalSessionId, { session_id: row.daemonSessionId, status: row.status }]),
    );

    let label = 'Orchestrator';
    try {
      if (env.PUBLIC_BASE_URL) label = new URL(env.PUBLIC_BASE_URL).host;
    } catch {
      /* An unparsable base URL keeps the generic label. */
    }

    const nativeControls = sessionIds.length ? await db.select().from(agentNativeControls).where(inArray(agentNativeControls.sessionId, sessionIds)) : [];
    const value = buildTopology({
      now,
      serverLabel: label,
      startedAtMs: PROCESS_STARTED_MS,
      communicatorEnabled: Boolean(env.CXX_COMMUNICATOR_ENABLED),
      portalEnabled,
      evidenceFreshSeconds: env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS,
      communicators,
      hostNames: new Map(hostRows.map((row) => [row.id, row.fqdn])),
      sessions,
      addresses,
      daemonBySession,
      tombstones: this.registry.tombstones(now),
    });
    const nativeBySession = new Map(nativeControls.map(row => [row.sessionId, controlView(row, now, nativeControlConnections(db).connected(row))]));
    for (const agent of value.agents) agent.native_control = agent.daemon ? null : nativeBySession.get(agent.id) ?? null;
    this.cached = { at: Date.now(), value };
    return value;
  }
}
