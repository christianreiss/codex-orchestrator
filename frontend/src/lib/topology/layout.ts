/**
 * Radial layout for the connection tree: the server at the centre, communicators
 * on the first ring, and every agent on the rings beyond, inside the angular
 * sector of whatever it hangs from.
 *
 * Pure and deterministic. The same input order always yields the same
 * coordinates, so a node that is still connected does not wander when its
 * neighbours come and go — only the sectors it shares breathe.
 */

export interface LayoutCommunicator {
  id: string;
}

export interface LayoutAgent {
  id: string;
  /** A communicator id, or {@link SERVER_ID} for sessions with no communicator. */
  parent: string;
}

export const SERVER_ID = "server";

export interface PlacedNode {
  id: string;
  kind: "server" | "communicator" | "agent";
  parent: string | null;
  x: number;
  y: number;
  /** Radians, clockwise from twelve o'clock. */
  angle: number;
  radius: number;
  /** 0 = server, 1 = communicators, 2.. = agent rows. */
  ring: number;
}

export interface PlacedSector {
  /** The communicator id, or {@link SERVER_ID} for the direct sessions' sector. */
  id: string;
  start: number;
  end: number;
}

export interface Layout {
  nodes: Map<string, PlacedNode>;
  sectors: PlacedSector[];
  /** Radii of the guide circles worth drawing. */
  rings: number[];
  /** Distance from the centre to the outside edge of the furthest node. */
  extent: number;
}

export interface LayoutOptions {
  /** Radius of the communicator ring when there is room to spare. */
  communicatorRadius?: number;
  /** Space between the communicator ring and the first agent row. */
  agentGap?: number;
  /** Distance between agent rows inside a sector. */
  rowGap?: number;
  /** Minimum centre-to-centre distance between communicators. */
  communicatorSpacing?: number;
  /** Minimum centre-to-centre distance between agents on a row. */
  agentSpacing?: number;
  /** Radius of an agent node, used for the extent. */
  agentRadius?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  communicatorRadius: 150,
  agentGap: 105,
  rowGap: 50,
  communicatorSpacing: 96,
  agentSpacing: 44,
  agentRadius: 16,
};

const TAU = Math.PI * 2;

/** Polar to cartesian with 0 at twelve o'clock and angles growing clockwise. */
export function polar(radius: number, angle: number): { x: number; y: number } {
  return { x: radius * Math.sin(angle), y: -radius * Math.cos(angle) };
}

export function radialLayout(
  communicators: readonly LayoutCommunicator[],
  agents: readonly LayoutAgent[],
  options: LayoutOptions = {},
): Layout {
  const o = { ...DEFAULTS, ...options };
  const nodes = new Map<string, PlacedNode>();
  nodes.set(SERVER_ID, { id: SERVER_ID, kind: "server", parent: null, x: 0, y: 0, angle: 0, radius: 0, ring: 0 });

  const known = new Set(communicators.map((c) => c.id));
  const childrenOf = new Map<string, string[]>();
  for (const agent of agents) {
    // An agent pointing at a communicator that is not in this layout is direct.
    const parent = known.has(agent.parent) ? agent.parent : SERVER_ID;
    const list = childrenOf.get(parent) ?? [];
    list.push(agent.id);
    childrenOf.set(parent, list);
  }

  const clusters: string[] = communicators.map((c) => c.id);
  if ((childrenOf.get(SERVER_ID)?.length ?? 0) > 0) clusters.push(SERVER_ID);

  // The first ring grows when there are too many communicators to keep apart.
  const minAngleAt = (radius: number) => o.communicatorSpacing / radius;
  const crowdedRadius = clusters.length > 0 ? (clusters.length * o.communicatorSpacing) / TAU : 0;
  const ring1 = Math.max(o.communicatorRadius, crowdedRadius);
  const minAngle = clusters.length > 0 ? Math.min(minAngleAt(ring1), TAU / clusters.length) : 0;

  const totalChildren = clusters.reduce((sum, id) => sum + (childrenOf.get(id)?.length ?? 0), 0);
  const spare = Math.max(0, TAU - minAngle * clusters.length);
  const sectors: PlacedSector[] = [];
  let cursor = 0;
  for (const id of clusters) {
    const children = childrenOf.get(id)?.length ?? 0;
    const share = totalChildren > 0 ? children / totalChildren : 1 / clusters.length;
    const width = minAngle + spare * share;
    sectors.push({ id, start: cursor, end: cursor + width });
    cursor += width;
  }

  const ring2 = ring1 + o.agentGap;
  let furthest = ring1 + 40;
  const usedRows = new Set<number>();

  for (const sector of sectors) {
    const centre = (sector.start + sector.end) / 2;
    const width = sector.end - sector.start;
    if (sector.id !== SERVER_ID) {
      const at = polar(ring1, centre);
      nodes.set(sector.id, { id: sector.id, kind: "communicator", parent: SERVER_ID, ...at, angle: centre, radius: ring1, ring: 1 });
    }
    const children = childrenOf.get(sector.id) ?? [];
    let placed = 0;
    for (let row = 0; placed < children.length; row++) {
      const radius = ring2 + row * o.rowGap;
      const capacity = Math.max(1, Math.floor((width * radius) / o.agentSpacing));
      const inRow = children.slice(placed, placed + capacity);
      // Fill the row from the middle of the sector, at a natural spacing, rather
      // than stretching two agents across a wide sector.
      const step = Math.min(width / inRow.length, (o.agentSpacing * 1.5) / radius);
      // Alternate rows are offset by half a step so rows interleave, not stack,
      // when the sector has room for the shift.
      const stagger = row % 2 === 1 && (inRow.length - 1) * step + step <= width ? step / 2 : 0;
      inRow.forEach((id, index) => {
        const angle = centre + (index - (inRow.length - 1) / 2) * step + stagger;
        nodes.set(id, { id, kind: "agent", parent: sector.id === SERVER_ID ? SERVER_ID : sector.id, ...polar(radius, angle), angle, radius, ring: 2 + row });
      });
      placed += inRow.length;
      usedRows.add(row);
      furthest = Math.max(furthest, radius + o.agentRadius);
    }
  }

  const rings: number[] = [];
  if (clusters.some((id) => id !== SERVER_ID)) rings.push(ring1);
  for (const row of [...usedRows].sort((a, b) => a - b)) rings.push(ring2 + row * o.rowGap);
  return { nodes, sectors, rings, extent: furthest };
}

/**
 * The order arrow keys walk the graph: communicators clockwise, then each
 * communicator's agents clockwise. The direct sessions come last.
 */
export function traversalOrder(layout: Layout): string[] {
  const placed = [...layout.nodes.values()].filter((n) => n.kind !== "server");
  const sectorOrder = new Map(layout.sectors.map((s, index) => [s.id, index]));
  const sectorOf = (n: PlacedNode) => sectorOrder.get(n.kind === "communicator" ? n.id : (n.parent ?? SERVER_ID)) ?? Infinity;
  return placed
    .sort((a, b) => sectorOf(a) - sectorOf(b) || (a.kind === b.kind ? 0 : a.kind === "communicator" ? -1 : 1) || a.ring - b.ring || a.angle - b.angle)
    .map((n) => n.id);
}
