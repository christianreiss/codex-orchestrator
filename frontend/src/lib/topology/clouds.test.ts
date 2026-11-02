import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Point, CloudNode, CloudContour } from './clouds';
const module: string = './clouds.ts';
const { cloudContours } = (await import(module)) as typeof import('./clouds');
const node = (id: string, x: number, y: number): CloudNode => ({ id, x, y, obstacles: [{ left: x - 22, right: x + 22, top: y - 22, bottom: y + 22 }] });
const group = (id: string, ...members: string[]) => ({ id, members });
function contains(contour: CloudContour, p: Point): boolean {
  let inside = false;
  for (const loop of contour.loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
it('omits empty, singleton, duplicate-only and missing memberships', () => {
  assert.deepEqual(cloudContours([group('empty'), group('single', 'a'), group('duplicate', 'a', 'a'), group('missing', 'a', 'gone')], [node('a', 0, 0)]), []);
});
it('keeps two real members, including coincident positions, without moving nodes', () => {
  for (const nodes of [[node('a', 0, 0), node('b', 0, 0)], [node('a', -100, 0), node('b', 100, 0)]]) {
    const before = JSON.stringify(nodes);
    const [cloud] = cloudContours([group('g', 'a', 'b')], nodes);
    assert.match(cloud.path, /^M .* Z$/);
    assert.doesNotMatch(cloud.path, /NaN|Infinity/);
    for (const n of nodes) assert.ok(contains(cloud, n));
    assert.equal(JSON.stringify(nodes), before);
    assert.deepEqual([cloud], cloudContours([group('g', 'b', 'a')], [...nodes].reverse()));
  }
});
it('leaves clearance around an unrelated node and its protruding label inside a group', () => {
  const foreign = node('foreign', 0, 0);
  foreign.obstacles.push({ left: -65, right: 65, top: -45, bottom: -27 });
  const nodes = [node('a', -100, 0), node('b', 100, 0), foreign];
  const [cloud] = cloudContours([group('g', 'a', 'b')], nodes);
  assert.ok(contains(cloud, nodes[0]) && contains(cloud, nodes[1]));
  assert.ok(cloud.loops.some(loop => contains({ ...cloud, loops: [loop] }, nodes[0]) && contains({ ...cloud, loops: [loop] }, nodes[1])), 'routes one connected outline around the obstacle');
  for (let x = -72; x <= 72; x += 2) for (let y = -52; y <= 29; y += 2) {
    const nearLabel = y <= -20;
    const nearNode = Math.abs(x) <= 29 && Math.abs(y) <= 29;
    if (nearLabel || nearNode) assert.equal(contains(cloud, { x, y }), false, `foreign footprint ${x},${y}`);
  }
});
it('keeps disjoint multi-agent clouds apart, but permits genuinely shared membership', () => {
  const nodes = [node('a', -50, -30), node('b', 50, -30), node('c', -50, 30), node('d', 50, 30)];
  const groups = [group('one', 'a', 'b'), group('two', 'c', 'd')];
  const clouds = cloudContours(groups, nodes);
  for (const c of clouds) for (const loop of c.loops) for (const p of loop) {
    const other = clouds.find(other => other.id !== c.id)!;
    assert.equal(contains(other, p), false);
    for (const boundary of other.loops) for (let i = 0; i < boundary.length; i++) {
      const a = boundary[i], b = boundary[(i + 1) % boundary.length], dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
      assert.ok(Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) > 8, 'disjoint outlines retain clearance beyond their strokes');
    }
  }
  for (let x = -70; x <= 70; x += 2) assert.ok(!clouds.some(c => contains(c, { x, y: 0 })));
  assert.deepEqual(clouds, cloudContours([...groups].reverse(), [...nodes].reverse()));
  const shared = cloudContours([group('project', 'a', 'b'), group('host', 'a', 'c')], nodes);
  assert.ok(shared.every(c => contains(c, nodes[0])));
});
it('suppresses infeasible or oversized envelopes rather than drawing a partial group', () => {
  const crowded = [node('a', 0, 0), node('b', 100, 0), node('foreign', 0, 0)];
  assert.equal(cloudContours([group('g', 'a', 'b')], crowded)[0].path, '');
  const large = [node('a', -10_000, -10_000), node('b', 10_000, 10_000)];
  assert.equal(cloudContours([group('g', 'a', 'b')], large)[0].path, '');
});
