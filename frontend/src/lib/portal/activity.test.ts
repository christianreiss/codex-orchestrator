import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === "./activity" ? "./activity.ts" : specifier,
      context,
    );
  },
});
const activityModule: string = "./activity.ts";
const presenceModule: string = "./presence.ts";
const { liveActivity } = (await import(
  activityModule
)) as typeof import("./activity");
const { presenceView, groupFor } = (await import(
  presenceModule
)) as typeof import("./presence");
import type { Agent } from "./types";
const now = Date.parse("2026-10-11T12:00:00Z");
const agent = {
  presence: "listening",
  heartbeat_at: new Date(now).toISOString(),
  relay_ready: true,
  ended_at: null,
  activity: {
    state: "working",
    wait_reason: null,
    source: "codex-thread",
    changed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 45000).toISOString(),
  },
} as Agent;
describe("native chat activity", () => {
  it("keeps connection-bound activity current without fabricating an expiry", () => {
    const connected = { ...agent, presence_source: "connection" as const, activity: { ...agent.activity!, expires_at: null } };
    assert.equal(liveActivity(connected, now + 3600_000), "working");
    assert.equal(liveActivity({ ...connected, presence: "offline" }, now), "unknown");
    assert.equal(liveActivity({ ...connected, presence: "ended" }, now), "unknown");
    assert.equal(liveActivity({ ...agent, activity: { ...agent.activity!, expires_at: null } }, now), "unknown");
  });
  it("shows native work without a portal-owned turn and keeps sending independent", () => {
    assert.equal(presenceView(agent, now).label, "Working");
    assert.equal(groupFor(agent, now), "working");
    assert.equal(
      presenceView(
        { ...agent, activity: { ...agent.activity!, state: "idle" } },
        now,
      ).canSend,
      true,
    );
    assert.equal(
      presenceView({ ...agent, relay_ready: false }, now).canSend,
      false,
    );
  });
  it("ages out activity and retains lifecycle labels", () => {
    assert.equal(liveActivity(agent, now + 45000), "unknown");
    assert.equal(
      presenceView({ ...agent, presence: "ended" }, now).label,
      "Ended",
    );
    assert.equal(
      presenceView({ ...agent, presence: "offline" }, now).label,
      "Offline",
    );
  });
  it("preserves older servers and explicit portal questions", () => {
    assert.equal(liveActivity({ ...agent, activity: undefined }, now), null);
    assert.equal(
      presenceView({ ...agent, activity: undefined }, now).label,
      "Listening",
    );
    assert.equal(
      liveActivity(
        {
          ...agent,
          pending_prompt: { id: "question" } as Agent["pending_prompt"],
          activity: {
            ...agent.activity!,
            state: "waiting",
            source: "portal-question",
            expires_at: null,
          },
        },
        now,
      ),
      "waiting",
    );
  });
});
