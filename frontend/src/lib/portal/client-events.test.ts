import assert from "node:assert/strict";
import { describe, it } from "node:test";
const modulePath: string = "./client-events.ts";
const { watchClientEvents } = await import(modulePath) as typeof import("./client-events");
class Feed extends EventTarget { closed = false; close() { this.closed = true; } }
const delay = () => new Promise((resolve) => setTimeout(resolve, 15));
describe("client event recovery", () => {
  it("coalesces selected events even when an unrelated frame arrives first", async () => {
    const feed = new Feed(); const refreshes: boolean[] = []; let url = "";
    const stop = watchClientEvents({ sessionId: "selected", create: (value) => { url = value; return feed; }, status: () => {}, refresh: (timeline) => refreshes.push(timeline), debounceMs: 1 });
    feed.dispatchEvent(new MessageEvent("agent", { data: JSON.stringify({ session_id: "other" }) }));
    feed.dispatchEvent(new MessageEvent("agent", { data: JSON.stringify({ session_id: "selected" }) }));
    await delay();
    assert.deepEqual(refreshes, [true]);
    assert.equal(url, "/admin/agent-sessions/events?session_id=selected");
    stop();
  });
  it("refreshes on every open and exposes reconnect failures without dropping snapshots", async () => {
    const feed = new Feed(); const statuses: string[] = []; const refreshes: boolean[] = [];
    const stop = watchClientEvents({ sessionId: "selected", create: () => feed, status: (s) => statuses.push(s), refresh: (t) => refreshes.push(t), debounceMs: 1 });
    feed.dispatchEvent(new Event("open")); feed.dispatchEvent(new Event("error")); feed.dispatchEvent(new Event("open"));
    assert.deepEqual(statuses, ["connecting", "live", "reconnecting", "live"]);
    assert.deepEqual(refreshes, [true, true]);
    feed.dispatchEvent(new MessageEvent("agent", { data: "malformed" }));
    stop(); await delay();
    assert.equal(feed.closed, true); assert.deepEqual(refreshes, [true, true]);
  });
});

describe("silent stream recovery", () => {
  it("recreates a silent OPEN stream after45s and cleans up every timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const feeds: Feed[] = []; const statuses: string[] = []; let refreshes = 0;
    const stop = watchClientEvents({ sessionId: "selected", create: () => { const feed = new Feed(); feeds.push(feed); return feed; }, status: (s) => statuses.push(s), refresh: () => { refreshes++; } });
    feeds[0].dispatchEvent(new Event("open"));
    t.mock.timers.tick(30_000);
    feeds[0].dispatchEvent(new Event("heartbeat"));
    t.mock.timers.tick(44_999);
    assert.equal(feeds.length, 1); assert.equal(feeds[0].closed, false);
    t.mock.timers.tick(1);
    assert.equal(feeds[0].closed, true); assert.equal(statuses.at(-1), "reconnecting");
    t.mock.timers.tick(1000);
    assert.equal(feeds.length, 2);
    feeds[1].dispatchEvent(new Event("open"));
    assert.equal(refreshes, 2);
    stop(); t.mock.timers.tick(100_000);
    assert.equal(feeds.length, 2); assert.equal(feeds[1].closed, true);
  });

  it("backs off constructor failures instead of retrying in a tight loop", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const stop = watchClientEvents({ sessionId: "selected", create: () => { calls++; throw new Error("offline"); }, status: () => {}, refresh: () => {} });
    assert.equal(calls, 1);
    t.mock.timers.tick(999); assert.equal(calls, 1);
    t.mock.timers.tick(1); assert.equal(calls, 2);
    t.mock.timers.tick(1999); assert.equal(calls, 2);
    t.mock.timers.tick(1); assert.equal(calls, 3);
    stop(); t.mock.timers.tick(100_000); assert.equal(calls, 3);
  });
});
