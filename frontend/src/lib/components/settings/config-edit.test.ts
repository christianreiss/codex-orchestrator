import assert from "node:assert/strict";
import { describe, it } from "node:test";
const modulePath = "./config-edit.ts";
const { parseNativeSettings, mergeNativeSettings, mergeFormSettings, hasAdvancedHooks, sameSettings } = await import(modulePath) as typeof import("./config-edit");

describe("native settings editing", () => {
  it("requires a JSON object without treating parse failures as an empty reset", () => {
    for (const text of ["[]", "null", "42", '"text"', '{"key":']) assert.throws(() => parseNativeSettings(text));
    assert.deepEqual(parseNativeSettings('{"features":{"enabled":false},"zero":0}'), { features: { enabled: false }, zero: 0 });
  });
  it("preserves independently updated models, effort and structured settings", () => {
    const base = { native_settings: { language: "en" }, model: "old" };
    const latest = { ...base, model: "current", effortLevel: "high", permissions: { deny: ["Read(secret)"] } };
    assert.deepEqual(mergeNativeSettings(base, latest, { language: "de" }), { ...latest, native_settings: { language: "de" } });
  });
  it("protects concurrent edits to native settings including missing-config creation", () => {
    assert.throws(() => mergeNativeSettings({}, { native_settings: { language: "fr" } }, { language: "de" }), /changed elsewhere/);
    assert.throws(() => mergeNativeSettings({ native_settings: { language: "en" } }, { native_settings: {} }, { language: "de" }), /changed elsewhere/);
    assert.deepEqual(mergeNativeSettings({}, { native_settings: { language: "de" }, model: "new" }, { language: "de" }), { native_settings: { language: "de" }, model: "new" });
  });
  it("supports explicit removal and ignores JSON key order", () => {
    assert.deepEqual(mergeNativeSettings({ native_settings: { language: "en" } }, { native_settings: { language: "en" } }, {}), { native_settings: {} });
    assert.ok(sameSettings({ b: 2, a: { y: false, x: 1 } }, { a: { x: 1, y: false }, b: 2 }));
  });
});
describe("Claude form three-way saves", () => {
  it("preserves native settings, arbitrary structured siblings, rich hooks and newer model defaults", () => {
    const hooks = { Stop: [{ hooks: [{ type: "http", url: "https://example.test/hook" }] }] };
    const base = { env: { OLD: "1" }, native_settings: { theme: "dark" }, hooks, permissionMode: "default", permissions: { allow: ["Read(*)"], additionalDirectories: ["/src"] } };
    const initial = { env: { OLD: "1" }, hooks: { Stop: [] }, permissionMode: "default", permissions: { allow: ["Read(*)"] } };
    const latest = { ...base, model: "current", effortLevel: "high", native_settings: { theme: "light" } };
    const saved = mergeFormSettings(base, latest, initial, { ...initial, env: { NEW: "2" }, permissions: {} });
    assert.deepEqual(saved, { ...latest, env: { NEW: "2" }, permissions: { additionalDirectories: ["/src"] } });
  });
  it("preserves a concurrently added env key when deleting the previously last key", () => {
    assert.deepEqual(mergeFormSettings({ env: { A: "1" } }, { env: { A: "1", B: "2" } }, { env: { A: "1" } }, {}), { env: { B: "2" } });
  });
  it("rejects conflicting field edits while permitting unrelated fields in the same object", () => {
    const base = { env: { A: "1", B: "2" } };
    assert.deepEqual(mergeFormSettings(base, { env: { A: "1", B: "new" } }, base, { env: { A: "edit", B: "2" } }), { env: { A: "edit", B: "new" } });
    assert.throws(() => mergeFormSettings(base, { env: { A: "new", B: "2" } }, base, { env: { A: "edit", B: "2" } }), /env.A changed elsewhere/);
  });
  it("removes intentionally cleared form-owned blocks", () => {
    const base = { advisorModel: "opus", env: { A: "1" }, model: "current" };
    assert.deepEqual(mergeFormSettings(base, base, { advisorModel: "opus", env: { A: "1" } }, {}), { model: "current" });
  });
  it("does not flatten hooks with non-command types, timeouts or richer metadata", () => {
    for (const hooks of [
      { Stop: [{ hooks: [{ type: "http", url: "https://example.test" }] }] },
      { Stop: [{ hooks: [{ type: "command", command: "true", timeout: 20 }] }] },
      { Stop: [{ matcher: "*", once: true, hooks: [] }] },
    ]) assert.equal(hasAdvancedHooks(hooks), true);
    assert.equal(hasAdvancedHooks({ Stop: [{ hooks: [{ type: "command", command: "true" }] }] }), false);
    assert.equal(hasAdvancedHooks({ Stop: [{ commands: ["true"] }] }), false);
  });
});
