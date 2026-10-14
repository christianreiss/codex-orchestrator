/**
 * View-model helpers for the topology page: labels, filtering, and how a node
 * that just disappeared stays visible long enough to be understood.
 *
 * No Svelte, no DOM, no clock reads — callers pass `now` — so the rules are
 * testable and the page stays a thin shell.
 */
import type { Topology, TopologyAgent, TopologyCommunicator, TopologyDisconnect } from "$lib/api/topology";

/** How long a node that has left stays on screen, faded, before it is dropped. */
export const GHOST_TTL_MS = 12_000;

export type GraphNodeState = "live" | "stale" | "closing" | "gone";

/** Host labels use the full FQDN; keep the server's runtime disambiguation. */
export function communicatorLabel(c: Pick<TopologyCommunicator, "host"> & { label?: string }): string {
  const suffix = c.label?.indexOf(" · ") ?? -1;
  return c.host + (suffix >= 0 ? c.label!.slice(suffix) : "");
}

export const COMMUNICATOR_APPEARANCE = {
  persistent: { kind: "persistent", label: "Persistent", color: "hsl(var(--info))", fill: "hsl(var(--info) / .16)" },
  spawned: { kind: "spawned", label: "Spawned", color: "hsl(var(--persona-claude))", fill: "hsl(var(--persona-claude) / .16)" },
  unknown: { kind: "unknown", label: "Mode unknown", color: "hsl(var(--muted-foreground))", fill: "hsl(var(--muted-foreground) / .12)" },
} as const;

/** Requested residence and an attached daemon do not prove the owner's mode. */
export function communicatorAppearance(c: Pick<TopologyCommunicator, "resident">) {
  const report = c.resident;
  if (!report || report.stale) return COMMUNICATOR_APPEARANCE.unknown;
  return report.mode === "resident" ? COMMUNICATOR_APPEARANCE.persistent : COMMUNICATOR_APPEARANCE.spawned;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export type AnyNode = TopologyCommunicator | TopologyAgent;

export interface Ghost<T extends AnyNode = AnyNode> {
  node: T;
  /** When the page first saw it missing. */
  since: number;
  /** What the server recorded about its leaving, when it recorded anything. */
  departure: TopologyDisconnect | null;
}

export interface GhostState {
  known: Map<string, AnyNode>;
  ghosts: Map<string, Ghost>;
}

export const emptyGhostState = (): GhostState => ({ known: new Map(), ghosts: new Map() });

/**
 * Compare a fresh snapshot with what was on screen. A node that vanished is kept
 * as a ghost for {@link GHOST_TTL_MS} (so a disconnect is something the operator
 * sees happen rather than a node that is simply absent next time they look); one
 * that returns stops being a ghost.
 */
export function trackGhosts(previous: GhostState, snapshot: Topology, now: number, ttlMs = GHOST_TTL_MS): GhostState {
  const current = new Map<string, AnyNode>();
  for (const c of snapshot.communicators) current.set(c.id, c);
  for (const a of snapshot.agents) current.set(a.id, a);

  const ghosts = new Map<string, Ghost>();
  for (const [id, ghost] of previous.ghosts) {
    if (!current.has(id) && now - ghost.since < ttlMs) ghosts.set(id, ghost);
  }
  for (const [id, node] of previous.known) {
    if (current.has(id) || ghosts.has(id)) continue;
    const departure = snapshot.recent_disconnects.find((d) => d.id === id) ?? null;
    ghosts.set(id, { node, since: now, departure });
  }
  // Refresh a ghost's departure record when the server learns more (a successor).
  for (const [id, ghost] of ghosts) {
    const departure = snapshot.recent_disconnects.find((d) => d.id === id);
    if (departure && departure !== ghost.departure) ghosts.set(id, { ...ghost, departure });
  }
  return { known: current, ghosts };
}

export function nodeState(node: AnyNode, ghost: boolean): GraphNodeState {
  if (ghost) return "gone";
  if (node.kind === "communicator") return node.health;
  return node.association.state === "stale" ? "stale" : "live";
}

/** Case-insensitive match over everything an operator might type to find a node. */
export function matchesQuery(node: AnyNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields =
    node.kind === "communicator"
      ? [node.username, node.host, node.version, node.id, "communicator"]
      : [node.name, node.engine, node.host, node.username, node.id, node.address ?? "", node.address_alias ?? "", node.cwd, node.presence];
  return fields.some((field) => field.toLowerCase().includes(q));
}

export interface TreeSummary {
  communicators: number;
  liveCommunicators: number;
  agents: number;
  attributed: number;
  stale: number;
  unattributed: number;
  working: number;
  listening: number;
}

export function summarize(snapshot: Topology | undefined): TreeSummary {
  const empty = { communicators: 0, liveCommunicators: 0, agents: 0, attributed: 0, stale: 0, unattributed: 0, working: 0, listening: 0 };
  if (!snapshot) return empty;
  return {
    communicators: snapshot.communicators.length,
    liveCommunicators: snapshot.communicators.filter((c) => c.health === "live").length,
    agents: snapshot.agents.length,
    attributed: snapshot.counts.attributed,
    stale: snapshot.counts.stale,
    unattributed: snapshot.counts.unattributed,
    working: snapshot.agents.filter((a) => a.presence === "working").length,
    listening: snapshot.agents.filter((a) => a.presence === "listening").length,
  };
}

/** Plain-language reason an action is unavailable. */
export function actionReason(reason: string | null): string {
  switch (reason) {
    case "session_ended": return "This session has already ended.";
    case "close_already_requested": return "A close request is already waiting for this agent.";
    case "agent_not_listening": return "The agent is not listening for instructions, so a polite close cannot be delivered.";
    case "not_daemon_managed": return "This session was not launched by a host daemon, so there is no process the server can stop.";
    case "daemon_session_closed": return "The daemon session is already closed.";
    case "stop_in_progress": return "A stop is already in progress.";
    default: return reason ?? "";
  }
}

export function ageLabel(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 2) return "just now";
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** A node on the canvas: live, or lingering after it left. */
export interface GraphItem<T extends AnyNode = AnyNode> {
  node: T;
  ghost: Ghost | null;
  /** 1 while live; falls towards 0 as a ghost approaches {@link GHOST_TTL_MS}. */
  strength: number;
}

export interface GraphModel {
  communicators: GraphItem<TopologyCommunicator>[];
  agents: GraphItem<TopologyAgent>[];
}

/**
 * Merge the live snapshot with the ghosts into what the canvas draws.
 * Agents keep the parent the server last gave them; a ghost keeps its own.
 */
export function graphModel(snapshot: Topology | undefined, state: GhostState, now: number): GraphModel {
  const live = (nodes: AnyNode[]) => nodes.map((node) => ({ node, ghost: null, strength: 1 }));
  const fade = (ghost: Ghost) => Math.max(0.12, 1 - (now - ghost.since) / GHOST_TTL_MS);
  const communicators = [
    ...live(snapshot?.communicators ?? []),
    ...[...state.ghosts.values()].filter((g) => g.node.kind === "communicator").map((g) => ({ node: g.node, ghost: g, strength: fade(g) })),
  ] as GraphItem<TopologyCommunicator>[];
  const agents = [
    ...live(snapshot?.agents ?? []),
    ...[...state.ghosts.values()].filter((g) => g.node.kind === "agent").map((g) => ({ node: g.node, ghost: g, strength: fade(g) })),
  ] as GraphItem<TopologyAgent>[];
  return { communicators, agents };
}

/** Where a confirmed action stands: awaiting the operator, in flight, or settled. */
export type ActionPhase = "confirm" | "pending" | "done" | "error";
