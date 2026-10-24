import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminAuditLogRow } from "../../api/types";

const modulePath: string = "./event-model.ts";
const model = (await import(modulePath)) as typeof import("./event-model");

const NOW = Date.parse("2026-10-17T12:00:00Z");
const change = (id: number, action: string, host_id: number | null, minutesAgo = 1, details: unknown = {}): AdminAuditLogRow => ({
  id, action, host_id, details, created_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
});
const label = (row: AdminAuditLogRow) => (row.host_id === null ? "System" : `host-${row.host_id}.example`);
const base = { q: "", host: "all", window: "all" as const, action: "" };

describe("url parsing", () => {
  it("falls back to safe defaults", () => {
    assert.equal(model.parseWindow("bogus"), "all");
    assert.equal(model.parseWindow("7d"), "7d");
    assert.equal(model.parseHost("12"), "12");
    assert.equal(model.parseHost("system"), "system");
    assert.equal(model.parseHost("abc"), "all");
  });
});

describe("action groups", () => {
  it("groups by first segment, most frequent first", () => {
    assert.equal(model.actionGroup("host.pruned"), "host");
    assert.equal(model.actionGroup("project_card_move", /[._:/]/), "project");
    const groups = model.actionGroups(["host.pruned", "host.registered", "chatgpt.usage", ""]);
    assert.deepEqual(groups, [{ value: "host", count: 2 }, { value: "chatgpt", count: 1 }]);
  });
});

describe("filterChanges", () => {
  const rows = [change(1, "host.pruned", 7, 2), change(2, "chatgpt.usage", null, 90, { ok: true }), change(3, "host.registered", 8, 3 * 24 * 60)];

  it("filters by host, system and action prefix", () => {
    assert.deepEqual(model.filterChanges(rows, { ...base, host: "7" }, label, NOW).map((r) => r.id), [1]);
    assert.deepEqual(model.filterChanges(rows, { ...base, host: "system" }, label, NOW).map((r) => r.id), [2]);
    assert.deepEqual(model.filterChanges(rows, { ...base, action: "host" }, label, NOW).map((r) => r.id), [1, 3]);
  });

  it("applies the time window and free-text search over action, host and details", () => {
    assert.deepEqual(model.filterChanges(rows, { ...base, window: "24h" }, label, NOW).map((r) => r.id), [1, 2]);
    assert.deepEqual(model.filterChanges(rows, { ...base, q: "host-8" }, label, NOW).map((r) => r.id), [3]);
    assert.deepEqual(model.filterChanges(rows, { ...base, q: '"ok":true' }, label, NOW).map((r) => r.id), [2]);
  });
});

describe("paging", () => {
  it("clamps the page and counts at least one", () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    assert.equal(model.pageCountFor(0), 1);
    assert.equal(model.pageCountFor(120), 3);
    assert.equal(model.paginate(items, 3).length, 20);
    assert.equal(model.paginate(items, 99).length, 20);
    assert.equal(model.paginate(items, 0).length, 50);
  });

  it("stringifies and truncates details", () => {
    assert.equal(model.detailsToString('{"a":1}'), '{"a":1}');
    assert.equal(model.detailsToString(null), "");
    assert.equal(model.truncate("abcdef", 4), "abc…");
  });
});
