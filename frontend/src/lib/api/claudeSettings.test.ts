import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

import type { ClaudeConfigSettings } from "./types";

// `claudeSettings.ts` only ever touches the network through `./client`.
// Stubbing it keeps both calls importable outside the browser and records what
// each one puts on the wire.
const CLIENT_STUB = "stub:api-client";

const clientStubSource = `
/** Every request the client issued, in call order; shared with the test. */
export const calls = [];

const record = (method, path, body) => {
  calls.push({ method, path, body });
  return Promise.resolve(null);
};

export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === CLIENT_STUB) {
      return { format: "module", shortCircuit: true, source: clientStubSource };
    }
    return nextLoad(url, context);
  },
});

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
  body: unknown;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const claudeSettingsModule: string = "./claudeSettings.ts";
const claudeSettings = (await import(claudeSettingsModule)) as typeof import("./claudeSettings");
const { claudeSettingsApi, claudeSettingsKeys } = claudeSettings;

/** A settings block wide enough that a re-built body would show up. */
const SETTINGS: ClaudeConfigSettings = {
  model: "opus",
  effortLevel: "high",
  env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192" },
  permissionMode: "acceptEdits",
};

/** The body as the client would actually serialise it. */
const wire = (): string => JSON.stringify(calls.at(-1)?.body);

beforeEach(() => {
  calls.length = 0;
});

describe("claudeSettingsApi", () => {
  it("reads the config from /admin/claude/config", async () => {
    await claudeSettingsApi.get();
    assert.deepEqual(calls, [{ method: "GET", path: "/admin/claude/config", body: undefined }]);
  });

  it("writes through the separate /config/store path", async () => {
    await claudeSettingsApi.store({ settings: SETTINGS, sha256: "abc123" });
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/admin/claude/config/store",
        body: { settings: SETTINGS, sha256: "abc123" },
      },
    ]);
  });

  it("forwards the caller's payload verbatim", async () => {
    const payload = { settings: SETTINGS, sha256: "abc123" };
    await claudeSettingsApi.store(payload);

    // Not a rebuilt object: the editor's settings block reaches the server with
    // every key it put there, including ones the typed shape does not name.
    assert.equal(calls.at(-1)?.body, payload);
  });

  it("posts the sha256 the stale-overwrite guard depends on", async () => {
    // `ClaudeFleetSettings.svelte` re-reads the config right before saving and
    // hands the sha it saw straight back; if the field stopped reaching the
    // wire the server would have nothing to compare and a stale editor could
    // clobber a newer model or reasoning-effort selection.
    await claudeSettingsApi.store({ settings: SETTINGS, sha256: "abc123" });
    assert.equal(wire(), JSON.stringify({ settings: SETTINGS, sha256: "abc123" }));

    // With nothing stored yet the save path sends an explicit null rather than
    // dropping the key, so the guard reads "I expect no prior config" instead
    // of "I have no expectation".
    await claudeSettingsApi.store({ settings: SETTINGS, sha256: null });
    assert.equal(wire(), JSON.stringify({ settings: SETTINGS, sha256: null }));
  });
});

describe("claudeSettingsKeys", () => {
  it("roots the config key at the shared prefix", () => {
    assert.deepEqual(claudeSettingsKeys.all, ["claude-settings"]);
    assert.deepEqual(claudeSettingsKeys.config(), ["claude-settings", "config"]);
  });

  it("keeps config() under all, so the save's invalidation still reaches it", () => {
    assert.deepEqual(claudeSettingsKeys.config().slice(0, claudeSettingsKeys.all.length), [
      ...claudeSettingsKeys.all,
    ]);
  });
});

describe("module surface", () => {
  it("exports exactly the documented surface", () => {
    assert.deepEqual(Object.keys(claudeSettings).sort(), [
      "claudeSettingsApi",
      "claudeSettingsKeys",
    ]);
  });
});
