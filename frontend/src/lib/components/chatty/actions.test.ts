import assert from "node:assert/strict";
import { describe, it } from "node:test";
const actionsModule: string = "./actions.ts";
const { actionPath, actionRequest, chattyAction, isExpired, samePlan } = (await import(actionsModule)) as typeof import("./actions");

const element = (overrides: Record<string, unknown> = {}) => ({
  type: "action",
  action: "host.engine.disable",
  risk: "danger",
  label: "Claude auf example.com deaktivieren",
  params: { host: 7, engine: "claude" },
  proposal: "v1.bGVnYWN5.eyJhIjoiIn0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  expires_at: "2026-10-29T12:15:00.000Z",
  ...overrides,
});

describe("Chatty action buttons", () => {
  it("renders only known actions with the console's own risk", () => {
    assert.ok(chattyAction(element()));
    assert.equal(chattyAction(element({ action: "host.delete" })), null);
    // A tampered payload cannot downgrade a mutation to a direct click.
    assert.equal(chattyAction(element({ risk: "safe" })), null);
    assert.equal(chattyAction(element({ risk: "confirm" })), null);
    assert.equal(chattyAction(element({ proposal: "" })), null);
    assert.equal(chattyAction(element({ proposal: "javascript:alert(1)" })), null);
    assert.equal(chattyAction(element({ label: "" })), null);
    assert.equal(chattyAction(element({ expires_at: "soon" })), null);
    assert.equal(chattyAction(element({ params: null })), null);
    assert.equal(chattyAction({ type: "link", label: "x", path: "/hosts" }), null);
    assert.equal(chattyAction(null), null);
  });

  it("expires proposals", () => {
    assert.equal(isExpired({ expires_at: "2026-10-29T12:15:00.000Z" }, Date.parse("2026-10-29T12:14:59Z")), false);
    assert.equal(isExpired({ expires_at: "2026-10-29T12:15:00.000Z" }, Date.parse("2026-10-29T12:15:00Z")), true);
  });

  it("builds navigation paths only from enumerated filter values", () => {
    assert.equal(actionPath({ action: "hosts.filter", params: { status: "offline", flag: "vip" } }), "/hosts?status=offline&flag=vip");
    assert.equal(actionPath({ action: "activity.host", params: { host: 7, window: "24h" } }), "/activity?host=7&window=24h");
    assert.equal(actionPath({ action: "activity.host", params: { host: 7 } }), "/activity?host=7");
    for (const params of [{ status: "https://evil.example" }, { flag: "vip&next=/x" }, {}] as Array<Record<string, string>>)
      assert.equal(actionPath({ action: "hosts.filter", params }), null, JSON.stringify(params));
    assert.equal(actionPath({ action: "activity.host", params: { host: "7" } }), null);
    assert.equal(actionPath({ action: "activity.host", params: { host: 7, window: "1y" } }), null);
    assert.equal(actionPath({ action: "host.engine.enable", params: { host: 7, engine: "claude" } }), null);
  });

  it("accepts an engine plan only as before plus or minus the named engine", () => {
    assert.deepEqual(
      actionRequest("host.engine.enable", { host_id: 7, engine: "claude", engines_before: ["codex"], engines_after: ["codex", "claude"] }),
      { kind: "host-engines", hostId: 7, engines: ["codex", "claude"] },
    );
    assert.deepEqual(
      actionRequest("host.engine.disable", { host_id: 7, engine: "claude", engines_before: ["codex", "claude"], engines_after: ["codex"] }),
      { kind: "host-engines", hostId: 7, engines: ["codex"] },
    );
    for (const [action, plan] of [
      ["host.engine.enable", { host_id: 7, engine: "claude", engines_before: ["codex"], engines_after: ["claude"] }],
      ["host.engine.enable", { host_id: 7, engine: "claude", engines_before: ["codex"], engines_after: ["codex", "claude", "grok"] }],
      ["host.engine.disable", { host_id: 7, engine: "claude", engines_before: ["claude"], engines_after: [] }],
      ["host.engine.disable", { host_id: 7, engine: "claude", engines_before: ["codex", "claude"], engines_after: ["grok"] }],
      ["host.engine.enable", { host_id: "7", engine: "claude", engines_before: ["codex"], engines_after: ["codex", "claude"] }],
      ["host.engine.enable", { host_id: 7, engine: "gemini", engines_before: ["codex"], engines_after: ["codex", "gemini"] }],
      ["host.auto_update", { host_id: 7, enabled: "true" }],
      ["host.insecure.close", { host_id: 0 }],
      ["account.verify", { account_id: -1 }],
      ["versions.check", { extra: 1 }],
      ["hosts.filter", { status: "offline", flag: null }],
    ] as const)
      assert.equal(actionRequest(action, plan), null, `${action} ${JSON.stringify(plan)}`);
    assert.deepEqual(actionRequest("host.auto_update", { host_id: 7, enabled: false }), { kind: "host-auto-update", hostId: 7, enabled: false });
    assert.deepEqual(actionRequest("host.insecure.close", { host_id: 7 }), { kind: "host-insecure-close", hostId: 7 });
    assert.deepEqual(actionRequest("account.verify", { account_id: 3 }), { kind: "account-verify", accountId: 3 });
    assert.deepEqual(actionRequest("versions.check", {}), { kind: "versions-check" });
  });

  it("compares plans independent of key order", () => {
    assert.equal(samePlan({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
    assert.equal(samePlan({ a: 1, b: [1, 2] }, { a: 1, b: [2, 1] }), false);
  });
});
