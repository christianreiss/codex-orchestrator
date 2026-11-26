import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderKey } from "../../api/types";

const mod: string = "./provider-key-model.ts";
const { errorField, failoverOrder, isUsable, keyErrorText, moveIds, removalConsequence, validateKeyValue, VERIFICATION, SOURCE_LABEL } =
  (await import(mod)) as typeof import("./provider-key-model");

const key = (id: number, sort_order: number, patch: Partial<ProviderKey> = {}): ProviderKey => ({
  id, provider: "openai", label: `Key ${id}`, key_hint: "sk-proj-…abcd", base_url: null, effective_base_url: "https://api.openai.com/v1",
  sort_order, state: "active", verification_state: "valid", verification_reason: null, verification_checked_at: null,
  last_used_at: null, last_error_at: null, last_error_status: null, last_error_reason: null, created_by_admin_user_id: 1,
  created_at: "2026-11-26T10:00:00Z", updated_at: "2026-11-26T10:00:00Z", ...patch,
});
const openai = { label: "OpenAI", base_path: "/v1", source: "upstream" as const };

describe("provider key model", () => {
  it("names both sources and every verification state in sentence case", () => {
    assert.deepEqual(SOURCE_LABEL, { emulated: "Subscription", upstream: "API key" });
    assert.deepEqual(Object.values(VERIFICATION).map((v) => v.label), ["Verified", "Rejected", "Unchecked", "Check failed"]);
  });

  it("treats only active, unrejected keys as failover candidates", () => {
    assert.equal(isUsable(key(1, 0)), true);
    assert.equal(isUsable(key(1, 0, { verification_state: "unverified" })), true);
    assert.equal(isUsable(key(1, 0, { verification_state: "error" })), true);
    assert.equal(isUsable(key(1, 0, { verification_state: "invalid" })), false);
    assert.equal(isUsable(key(1, 0, { state: "paused" })), false);
  });

  it("orders by sort order, then id, like the forward", () => {
    assert.deepEqual(failoverOrder([key(3, 1), key(2, 0), key(1, 1)]).map((k) => k.id), [2, 1, 3]);
  });

  it("moves one id up or down and refuses the ends", () => {
    assert.deepEqual(moveIds([1, 2, 3], 1, -1), [2, 1, 3]);
    assert.deepEqual(moveIds([1, 2, 3], 1, 1), [1, 3, 2]);
    assert.equal(moveIds([1, 2, 3], 0, -1), null);
    assert.equal(moveIds([1, 2, 3], 2, 1), null);
  });

  it("says the next key takes over only while another usable key exists", () => {
    const keys = [key(1, 0), key(2, 1), key(3, 2, { state: "paused" })];
    assert.match(removalConsequence(keys[0]!, keys, openai).text, /next key, Key 2, takes over/);
    assert.match(removalConsequence(keys[1]!, keys, openai).text, /still go to Key 1 first/);
    assert.match(removalConsequence(keys[2]!, keys, openai).text, /not in the failover order/);
    const last = removalConsequence(keys[0]!, [keys[0]!, keys[2]!], openai);
    assert.equal(last.lastUsable, true);
    assert.match(last.text, /\/v1 answers with API key, so its requests fail \(503\)/);
    const subscription = removalConsequence(keys[0]!, [keys[0]!], { ...openai, source: "emulated" });
    assert.match(subscription.text, /only gateway keys pinned to API key are affected/);
  });

  it("places server rejections beside the field they belong to", () => {
    assert.equal(errorField({ code: "gateway_key_not_allowed" }), "key");
    assert.equal(errorField({ code: "provider_key_duplicate" }), "key");
    assert.equal(errorField({ code: "invalid_base_url" }), "base_url");
    assert.equal(errorField({ code: "invalid_request", message: "label is required" }), "label");
    assert.equal(errorField({ code: "invalid_request", message: "key must be 16-1024 characters" }), "key");
    assert.equal(errorField({ code: "engine_disabled" }), null);
    assert.equal(errorField(null), null);
  });

  it("explains every documented failure with a next step", () => {
    for (const code of ["gateway_key_not_allowed", "provider_key_duplicate", "invalid_base_url", "provider_key_not_found", "provider_key_order_mismatch", "engine_disabled", "provider_key_missing"]) {
      const text = keyErrorText({ code, message: "server text" }, "OpenAI", "Codex");
      assert.ok(text.length > 20, code);
      assert.doesNotMatch(text, /^server text$/, code);
    }
    assert.match(keyErrorText({ code: "engine_disabled" }, "xAI", "Grok"), /^Grok is switched off fleet-wide/);
    assert.equal(keyErrorText({ code: "other", message: "Plain failure" }), "Plain failure");
  });

  it("checks the key shape at submission without echoing it", () => {
    assert.equal(validateKeyValue(""), "Paste the API key.");
    assert.match(validateKeyValue("short") ?? "", /16 to 1,024/);
    assert.match(validateKeyValue("sk-proj-0123456789 abcdef") ?? "", /spaces/);
    assert.equal(validateKeyValue("  sk-proj-0123456789abcdef  "), null);
  });
});
