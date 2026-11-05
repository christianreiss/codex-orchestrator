import assert from "node:assert/strict";
import { describe, it } from "node:test";

// See format.test.ts: the ".ts" specifier is hidden from TypeScript.
const urlFiltersModule: string = "./url-filters.ts";
const { readFilters, writeFilters, filtersActive, filtersKey } = (await import(urlFiltersModule)) as typeof import("./url-filters");

const DEFAULTS = { q: "", status: "all" };

describe("readFilters", () => {
  it("takes owned parameters and defaults the rest", () => {
    const params = new URLSearchParams("q=web01&id=7&extra=1");
    assert.deepEqual(readFilters(params, DEFAULTS), { q: "web01", status: "all" });
  });

  it("keeps an explicitly empty parameter", () => {
    assert.deepEqual(readFilters(new URLSearchParams("status="), DEFAULTS), { q: "", status: "" });
  });
});

describe("writeFilters", () => {
  it("sets changed filters and leaves foreign parameters alone", () => {
    const url = new URL("https://x.test/admin/transfers?id=7&tab=audit");
    const next = writeFilters(url, { q: "log file", status: "open" }, DEFAULTS);
    assert.equal(next.searchParams.get("q"), "log file");
    assert.equal(next.searchParams.get("status"), "open");
    assert.equal(next.searchParams.get("id"), "7");
    assert.equal(next.searchParams.get("tab"), "audit");
    assert.equal(url.search, "?id=7&tab=audit", "input URL is not mutated");
  });

  it("drops filters back at their default", () => {
    const url = new URL("https://x.test/list?q=old&status=open&id=3");
    assert.equal(writeFilters(url, { q: "", status: "all" }, DEFAULTS).search, "?id=3");
  });

  it("round-trips through readFilters", () => {
    const values = { q: "a&b=c", status: "closed" };
    const url = writeFilters(new URL("https://x.test/"), values, DEFAULTS);
    assert.deepEqual(readFilters(url.searchParams, DEFAULTS), values);
  });
});

describe("filtersActive / filtersKey", () => {
  it("ignores whitespace-only search", () => {
    assert.equal(filtersActive({ q: "  ", status: "all" }, DEFAULTS), false);
    assert.equal(filtersActive({ q: "x", status: "all" }, DEFAULTS), true);
    assert.equal(filtersActive({ q: "", status: "open" }, DEFAULTS), true);
  });

  it("compares only owned keys, in default order", () => {
    assert.equal(filtersKey({ status: "all", q: "x", other: "y" }, DEFAULTS), filtersKey({ q: "x", status: "all" }, DEFAULTS));
    assert.notEqual(filtersKey({ q: "x", status: "all" }, DEFAULTS), filtersKey({ q: "y", status: "all" }, DEFAULTS));
  });
});
