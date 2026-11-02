/** Obstacle-aware group envelopes. Coordinates and memberships are read-only. */
export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface CloudNode extends Point { id: string; obstacles: Rect[] }
export interface CloudGroup { id: string; members: string[] }
export interface CloudContour { id: string; path: string; loops: Point[][] }

const padding = 38;
// Includes the contour's sampling error and stroke; unrelated objects retain a
// visible gap even when a narrow passage has to split an envelope into islands.
const clearance = 12;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}
function rectDistance(p: Point, r: Rect): number {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return dx || dy ? Math.hypot(dx, dy) : -Math.min(p.x - r.left, r.right - p.x, p.y - r.top, r.bottom - p.y);
}

/** A deterministic minimum spanning tree keeps a group connected without a
 * convex hull swallowing everything between its outermost members. */
function skeleton(nodes: CloudNode[]): Array<[Point, Point]> {
  const joined = [nodes[0]], remaining = nodes.slice(1), edges: Array<[Point, Point]> = [];
  while (remaining.length) {
    let best = Infinity, from = joined[0], index = 0;
    for (const a of joined) for (let i = 0; i < remaining.length; i++) {
      const d = distance(a, remaining[i]);
      if (d < best) { best = d; from = a; index = i; }
    }
    const [to] = remaining.splice(index, 1);
    joined.push(to);
    edges.push([from, to]);
  }
  return edges;
}

/** Route obstructed tree edges through a visibility graph of padded obstacle
 * corners. This keeps ordinary groups in one piece instead of merely cutting a
 * foreign node out of a straight connector. No graph nodes are relocated. */
function route(a: Point, b: Point, obstacles: Rect[]): Array<[Point, Point]> {
  const blocked = (from: Point, to: Point) => obstacles.some(r => touches(from, to, r, clearance + 6));
  if (!blocked(a, b)) return [[a, b]];
  // Dense fleets fall back to clipped straight connectors instead of an
  // unbounded all-pairs visibility graph. Final validation still applies.
  if (obstacles.length > 64) return [[a, b]];
  const margin = clearance + 10;
  const points = [a, b, ...obstacles.flatMap(r => [
    { x: r.left - margin, y: r.top - margin }, { x: r.right + margin, y: r.top - margin },
    { x: r.right + margin, y: r.bottom + margin }, { x: r.left - margin, y: r.bottom + margin },
  ]).filter(p => !blocked(p, p))];
  const distances = points.map((_, i) => i ? Infinity : 0), previous = points.map(() => -1), visited = new Set<number>();
  while (visited.size < points.length) {
    let current = -1;
    for (let i = 0; i < points.length; i++) if (!visited.has(i) && (current < 0 || distances[i] < distances[current])) current = i;
    if (current < 0 || !Number.isFinite(distances[current])) break;
    if (current === 1) {
      const result: Array<[Point, Point]> = [];
      for (let i = 1; previous[i] >= 0; i = previous[i]) result.unshift([points[previous[i]], points[i]]);
      return result;
    }
    visited.add(current);
    for (let i = 0; i < points.length; i++) {
      if (visited.has(i)) continue;
      const candidate = distances[current] + distance(points[current], points[i]);
      if (candidate < distances[i] && !blocked(points[current], points[i])) { distances[i] = candidate; previous[i] = current; }
    }
  }
  // Infeasible member placement is caught by the final containment validation.
  return [[a, b]];
}

/** Marching squares: shared edge keys join interpolated segments into closed
 * contours, including holes. No smoothing can round back into an obstacle. */
function trace(bounds: Rect, field: (p: Point) => number): Point[][] {
  const step = 4;
  const cols = Math.ceil((bounds.right - bounds.left) / step), rows = Math.ceil((bounds.bottom - bounds.top) / step);
  // A very large/sparse group keeps its room/list rather than blocking the UI or
  // increasing the sampling error until its outline can touch foreign objects.
  if (cols * rows > 100_000) return [];
  const values = Array.from({ length: rows + 1 }, (_, y) => Array.from({ length: cols + 1 }, (_, x) =>
    field({ x: bounds.left + x * step, y: bounds.top + y * step })));
  const vertices = new Map<string, Point>(), neighbors = new Map<string, string[]>();
  const connect = (a: string, b: string) => {
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
    const v = corners.map(([cx, cy]) => values[cy][cx]);
    const crossings: string[] = [];
    for (let e = 0; e < 4; e++) {
      const next = (e + 1) % 4;
      if ((v[e] < 0) === (v[next] < 0)) continue;
      const [ax, ay] = corners[e], [bx, by] = corners[next];
      const key = `${Math.min(ax, bx)},${Math.min(ay, by)},${ay === by ? 'h' : 'v'}`;
      if (!vertices.has(key)) {
        const t = v[e] / (v[e] - v[next]);
        vertices.set(key, { x: bounds.left + (ax + (bx - ax) * t) * step, y: bounds.top + (ay + (by - ay) * t) * step });
      }
      crossings.push(key);
    }
    if (crossings.length === 2) connect(crossings[0], crossings[1]);
    else if (crossings.length === 4) {
      const middleInside = field({ x: bounds.left + (x + .5) * step, y: bounds.top + (y + .5) * step }) < 0;
      if (middleInside === (v[0] < 0)) {
        connect(crossings[0], crossings[1]); connect(crossings[2], crossings[3]);
      } else { connect(crossings[0], crossings[3]); connect(crossings[1], crossings[2]); }
    }
  }
  const visited = new Set<string>(), loops: Point[][] = [];
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue;
    const loop: Point[] = [];
    let current = start, previous = '';
    do {
      visited.add(current);
      loop.push(vertices.get(current)!);
      const next = neighbors.get(current)!.find(id => id !== previous)!;
      previous = current; current = next;
    } while (current !== start && current && !visited.has(current));
    if (current === start && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function contains(loops: Point[][], p: Point): boolean {
  let inside = false;
  for (const loop of loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Exact segment/expanded-rectangle check protects the rendered straight edges,
 * not merely their sampled vertices. The remaining gap exceeds half the stroke. */
function touches(a: Point, b: Point, r: Rect, margin = 6): boolean {
  let low = 0, high = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, r.left - margin, r.right + margin], [a.y, b.y - a.y, r.top - margin, r.bottom + margin]]) {
    if (!delta) { if (start < min || start > max) return false; }
    else {
      const t1 = (min - start) / delta, t2 = (max - start) / delta;
      low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2));
      if (low > high) return false;
    }
  }
  return true;
}

export function cloudContours(groups: readonly CloudGroup[], nodes: readonly CloudNode[]): CloudContour[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const prepared = groups.map(group => {
    const members = [...new Set(group.members)].sort().flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const ids = new Set(members.map(n => n.id));
    const foreign = nodes.filter(n => !ids.has(n.id)).sort((a, b) => a.id.localeCompare(b.id)).flatMap(n => n.obstacles);
    const edges = members.length > 1 ? skeleton(members).flatMap(([a, b]) => route(a, b, foreign)) : [];
    return { ...group, members, ids, edges, foreign, field: (p: Point) => {
      let closest = Infinity;
      for (const [a, b] of edges) closest = Math.min(closest, segmentDistance(p, a, b));
      return closest - padding;
    } };
  }).filter(group => group.members.length > 1).sort((a, b) => a.id.localeCompare(b.id));
  return prepared.map(group => {
    const { foreign } = group;
    const independent = prepared.filter(other => other !== group && !other.members.some(n => group.ids.has(n.id)));
    const field = (p: Point) => {
      const own = group.field(p);
      let value = own;
      for (const obstacle of foreign) value = Math.max(value, clearance - rectDistance(p, obstacle));
      for (const other of independent) value = Math.max(value, (own - other.field(p) + clearance) / 2);
      return value;
    };
    const margin = padding + 16;
    const points = group.edges.flat();
    let loops = trace({
      left: Math.min(...points.map(n => n.x)) - margin, right: Math.max(...points.map(n => n.x)) + margin,
      top: Math.min(...points.map(n => n.y)) - margin, bottom: Math.max(...points.map(n => n.y)) + margin,
    }, field);
    // Crowded/infeasible geometry must not turn into a misleading partial group.
    // Related rooms remain available even when no honest envelope can be drawn.
    if (!group.members.every(p => contains(loops, p)) || foreign.some(r => contains(loops, { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 })) || loops.some(loop => loop.some((a, i) =>
      foreign.some(r => touches(a, loop[(i + 1) % loop.length], r))))) loops = [];
    const path = loops.map(loop => loop.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + ' Z').join(' ');
    return { id: group.id, path, loops };
  });
}
