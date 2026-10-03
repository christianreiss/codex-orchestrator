import assert from "node:assert/strict";
import { describe, it } from "node:test";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const fleetStateModule: string = "./fleet-state.ts";
const { fleetEngineView, fleetDisabledTitle } = (await import(
  fleetStateModule
)) as typeof import("./fleet-state");

const row = (engine: string, enabled: boolean) => ({
  engine,
  label: engine,
  enabled,
  updated_at: null,
  updated_by: null,
  assigned_hosts: 0,
});

describe("fleetEngineView", () => {
  it("reads every engine as enabled until the server answers", () => {
    // Loading, an error, a viewer without settings.read, and a stub that
    // answers a bare envelope must all leave every control usable.
    for (const data of [undefined, null, {}, { status: "ok" }, { engines: "nope" }, { engines: [] }]) {
      const view = fleetEngineView(data);
      assert.equal(view.known, false);
      assert.deepEqual(view.enabled, ["codex", "claude", "grok"]);
      assert.deepEqual(view.disabled, []);
      assert.equal(view.isEnabled("grok"), true);
      assert.equal(view.row("grok"), null);
    }
  });

  it("splits the engines by their switch, in canonical order", () => {
    const view = fleetEngineView({ engines: [row("grok", false), row("codex", true), row("claude", false)] });
    assert.equal(view.known, true);
    assert.deepEqual(view.enabled, ["codex"]);
    assert.deepEqual(view.disabled, ["claude", "grok"]);
    assert.equal(view.isEnabled("codex"), true);
    assert.equal(view.isEnabled("claude"), false);
    assert.equal(view.row("claude")?.enabled, false);
  });

  it("treats an unknown engine id as enabled and ignores malformed rows", () => {
    const view = fleetEngineView({ engines: [row("gemini", false), { engine: "codex" }, row("grok", false)] });
    assert.deepEqual(view.disabled, ["grok"]);
    assert.equal(view.isEnabled("gemini"), true);
    assert.equal(view.rows.length, 1);
  });

  it("allows every engine to be off at once", () => {
    const view = fleetEngineView({ engines: [row("codex", false), row("claude", false), row("grok", false)] });
    assert.deepEqual(view.enabled, []);
    assert.deepEqual(view.disabled, ["codex", "claude", "grok"]);
  });
});

describe("fleetDisabledTitle", () => {
  it("names the engine and where to turn it back on", () => {
    assert.equal(fleetDisabledTitle("Claude"), "Claude is disabled fleet-wide. Turn it back on under Engines.");
  });
});
