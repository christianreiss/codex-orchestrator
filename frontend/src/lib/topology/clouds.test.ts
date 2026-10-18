import assert from 'node:assert/strict';
import { it } from 'node:test';
const path: string = './clouds.ts';
const { cloudPath } = (await import(path)) as typeof import('./clouds');
it('handles empty, singleton and coincident memberships without invalid SVG', () => {
  assert.equal(cloudPath([]), '');
  for (const points of [[{x:0,y:0}], [{x:10,y:20},{x:10,y:20}], [{x:-200,y:0},{x:200,y:0}]]) {
    const result = cloudPath(points);
    assert.match(result, /^M .* Q .* Z$/);
    assert.doesNotMatch(result, /NaN|Infinity/);
    assert.equal(result, cloudPath([...points].reverse()));
  }
});
it('does not move nodes while constructing overlapping group envelopes', () => {
  const shared = { x: 30, y: 30 };
  const project = [shared, { x: -100, y: 0 }];
  const host = [shared, { x: 100, y: 0 }];
  const before = JSON.stringify([project, host]);
  assert.notEqual(cloudPath(project), cloudPath(host));
  assert.equal(JSON.stringify([project, host]), before);
});
