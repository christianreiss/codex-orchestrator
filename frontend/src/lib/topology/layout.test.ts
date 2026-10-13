import assert from "node:assert/strict";
import { describe, it } from "node:test";

const layoutModule: string = "./layout.ts";
const { radialLayout, traversalOrder, polar, SERVER_ID } = (await import(layoutModule)) as typeof import("./layout");

const comms = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));
const agents = (spec: Record<string, number>) =>
  Object.entries(spec).flatMap(([parent, count]) => Array.from({ length: count }, (_, i) => ({ id: `${parent}-a${i}`, parent })));

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("radial layout", () => {
  it("puts the server at the origin and nothing else there", () => {
    const layout = radialLayout(comms(3), agents({ c0: 2, c1: 1 }));
    assert.deepEqual([layout.nodes.get(SERVER_ID)!.x, layout.nodes.get(SERVER_ID)!.y], [0, 0]);
    for (const node of layout.nodes.values()) {
      if (node.id !== SERVER_ID) assert.ok(Math.hypot(node.x, node.y) > 100, `${node.id} too close to the centre`);
    }
  });

  it("is deterministic: the same input yields the same coordinates", () => {
    const a = radialLayout(comms(4), agents({ c0: 5, c2: 3 }));
    const b = radialLayout(comms(4), agents({ c0: 5, c2: 3 }));
    assert.deepEqual([...a.nodes.entries()], [...b.nodes.entries()]);
  });

  it("keeps each agent inside the sector of its own communicator", () => {
    const layout = radialLayout(comms(3), agents({ c0: 6, c1: 2, c2: 9 }));
    for (const sector of layout.sectors) {
      for (const node of layout.nodes.values()) {
        if (node.kind !== "agent" || node.parent !== sector.id) continue;
        assert.ok(node.angle >= sector.start - 1e-9 && node.angle <= sector.end + 1e-9, `${node.id} left its sector`);
      }
    }
  });

  it("gives busier communicators wider sectors but never less than the minimum", () => {
    const layout = radialLayout(comms(3), agents({ c0: 30, c1: 1 }));
    const width = (id: string) => {
      const s = layout.sectors.find((x) => x.id === id)!;
      return s.end - s.start;
    };
    assert.ok(width("c0") > width("c1"));
    assert.ok(width("c2") > 0.3, "an empty communicator still needs room to be a target");
    assert.ok(Math.abs(layout.sectors.reduce((sum, s) => sum + (s.end - s.start), 0) - Math.PI * 2) < 1e-9);
  });

  it("never overlaps two communicators, even with many of them", () => {
    const layout = radialLayout(comms(40), []);
    const ring = [...layout.nodes.values()].filter((n) => n.kind === "communicator");
    let closest = Infinity;
    for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) closest = Math.min(closest, dist(ring[i]!, ring[j]!));
    assert.ok(closest >= 90, `communicators ${closest.toFixed(1)} apart`);
  });

  it("never overlaps two agents, spilling into more rows when a sector is crowded", () => {
    const layout = radialLayout(comms(2), agents({ c0: 80, c1: 3 }));
    const all = [...layout.nodes.values()].filter((n) => n.kind === "agent");
    let closest = Infinity;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) closest = Math.min(closest, dist(all[i]!, all[j]!));
    assert.ok(closest >= 30, `agents ${closest.toFixed(1)} apart`);
    assert.ok(Math.max(...all.map((n) => n.ring)) > 2, "a crowded sector uses further rows");
    assert.ok(layout.extent > Math.max(...all.map((n) => n.radius)));
  });

  it("hangs sessions without a communicator off the server in a sector of their own", () => {
    const layout = radialLayout(comms(2), agents({ c0: 2, [SERVER_ID]: 4 }));
    const direct = [...layout.nodes.values()].filter((n) => n.kind === "agent" && n.parent === SERVER_ID);
    assert.equal(direct.length, 4);
    const sector = layout.sectors.find((s) => s.id === SERVER_ID)!;
    assert.ok(sector);
    for (const node of direct) assert.ok(node.angle >= sector.start && node.angle <= sector.end);
    assert.equal(layout.nodes.has(`${SERVER_ID}x`), false);
  });

  it("treats an agent whose communicator is unknown as direct", () => {
    const layout = radialLayout(comms(1), [{ id: "orphan", parent: "missing" }]);
    assert.equal(layout.nodes.get("orphan")!.parent, SERVER_ID);
  });

  it("copes with nothing at all and with agents alone", () => {
    assert.equal(radialLayout([], []).nodes.size, 1);
    const alone = radialLayout([], agents({ [SERVER_ID]: 3 }));
    assert.equal(alone.nodes.size, 4);
    assert.equal(alone.rings.length > 0, true);
  });

  it("keeps the clockwise order of the survivors when an agent leaves", () => {
    const before = radialLayout(comms(3), agents({ c0: 3, c1: 3, c2: 3 }));
    const after = radialLayout(comms(3), agents({ c0: 3, c1: 3, c2: 3 }).filter((a) => a.id !== "c2-a2"));
    // Sectors narrow when a child leaves, so exact positions may shift, but the
    // order around the ring never changes.
    const order = (layout: typeof before) => traversalOrder(layout).filter((id) => id !== "c2-a2");
    assert.deepEqual(order(after), order(before));
  });

  it("walks communicators and their agents in clockwise sector order", () => {
    const layout = radialLayout(comms(2), agents({ c0: 2, c1: 1 }));
    assert.deepEqual(traversalOrder(layout), ["c0", "c0-a0", "c0-a1", "c1", "c1-a0"]);
  });

  it("converts polar coordinates with twelve o'clock at zero, clockwise", () => {
    const top = polar(10, 0);
    assert.ok(Math.abs(top.x) < 1e-9 && Math.abs(top.y + 10) < 1e-9);
    const right = polar(10, Math.PI / 2);
    assert.ok(Math.abs(right.x - 10) < 1e-9 && Math.abs(right.y) < 1e-9);
  });
});
