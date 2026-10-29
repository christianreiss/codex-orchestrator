import assert from "node:assert/strict";
import { describe, it } from "node:test";

// `node --test` resolves specifiers verbatim, so the runtime import needs ".ts".
const modulePath: string = "./room-annotations.ts";
const { highlightSegments, searchPath, toggledReactions, reactionLabel, QUICK_REACTIONS } = (await import(
  modulePath
)) as typeof import("./room-annotations");

describe("search highlights", () => {
  it("splits a snippet into marked and plain runs", () => {
    assert.deepEqual(highlightSegments("…ship the Release now", [{ start: 10, length: 7 }]), [
      { text: "…ship the ", mark: false },
      { text: "Release", mark: true },
      { text: " now", mark: false },
    ]);
  });
  it("tolerates unsorted, overlapping and out-of-range offsets", () => {
    const runs = highlightSegments("abcdef", [
      { start: 4, length: 10 },
      { start: 0, length: 2 },
      { start: 1, length: 2 },
    ]);
    assert.equal(runs.map((r) => r.text).join(""), "abcdef");
    assert.deepEqual(
      runs.filter((r) => r.mark).map((r) => r.text),
      ["ab", "c", "ef"],
    );
    assert.deepEqual(highlightSegments("", [{ start: 3, length: 2 }]), []);
  });
});

describe("search path", () => {
  it("encodes the query and optional room and cursor", () => {
    assert.equal(
      searchPath({ q: "  a&b ", scope: "rooms", roomId: "r1", cursor: "c/1", limit: 20 }),
      "/admin/agent-messaging/search?q=a%26b&scope=rooms&room_id=r1&cursor=c%2F1&limit=20",
    );
    assert.equal(searchPath({ q: "deploy", scope: "all" }), "/admin/agent-messaging/search?q=deploy&scope=all");
  });
});

describe("reaction toggles", () => {
  it("adds, joins and removes the operator's own reaction", () => {
    const added = toggledReactions([], "👍", true);
    assert.deepEqual(added, [{ emoji: "👍", count: 1, mine: true }]);
    assert.deepEqual(toggledReactions(added, "👍", true), added);
    const joined = toggledReactions([{ emoji: "🎉", count: 2, mine: false }], "🎉", true);
    assert.deepEqual(joined, [{ emoji: "🎉", count: 3, mine: true }]);
    assert.deepEqual(toggledReactions(added, "👍", false), []);
    assert.deepEqual(toggledReactions([{ emoji: "🎉", count: 2, mine: false }], "🎉", false), [
      { emoji: "🎉", count: 2, mine: false },
    ]);
  });
  it("names the action for assistive technology", () => {
    assert.equal(reactionLabel({ emoji: "👍", count: 2, mine: true }), "👍 2 reactions, including yours. Remove yours");
    assert.equal(reactionLabel({ emoji: "👀", count: 1, mine: false }), "👀 1 reaction. Add yours");
    assert.ok(QUICK_REACTIONS.length >= 6);
  });
});
