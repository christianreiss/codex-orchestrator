import assert from "node:assert/strict";
import { it } from "node:test";
const modulePath = "./codex-compaction.ts";
const { codexAsyncCompactionEnabled: enabled, setCodexAsyncCompaction: set } = await import(modulePath) as typeof import("./codex-compaction");

it("shows the fleet default and respects explicit boolean, object and legacy settings", () => {
  assert.equal(enabled({}), true);
  for (const value of [false, { enabled: false }, { model_async_compact_threshold_percent: 71 }]) {
    assert.equal(enabled({ native_settings: { features: { async_compaction: value } } }), false);
  }
  assert.equal(enabled({ native_settings: { features: { async_compaction: true } }, features: { async_compaction: false } }), false);
  assert.equal(enabled({ native_settings: { features: { async_compaction: { enabled: false } } }, features: { async_compaction: { model_async_compact_threshold_percent: 71 } } }), false);
});
it("toggles only compaction while preserving tuning, siblings and unrelated latest settings", () => {
  const before = { model: "newer", profiles: [{ name: "local" }], features: { hooks: false, async_compaction: { enabled: true, model_async_compact_threshold_percent: 71 } },
    native_settings: { history: { persistence: "none" }, features: { memories: false, async_compaction: { model_async_compact_threshold_percent: 65 } } } };
  const original = structuredClone(before);
  const result = set(before, false);
  assert.deepEqual(result, { ...before, features: { hooks: false }, native_settings: { ...before.native_settings,
    features: { memories: false, async_compaction: { enabled: false, model_async_compact_threshold_percent: 71 } } } });
  assert.equal(enabled(result), false);
  assert.equal(enabled(set(result, true)), true);
  assert.deepEqual(before, original);
});
