import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const formatModule: string = "./format.ts";
const { relativeTime, formatBytes } = (await import(formatModule)) as typeof import("./format");

/** The clock every relativeTime expectation below is measured against. */
const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: NOW });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("suffixes a past Date with 'ago' and a future one with 'in'", () => {
    assert.equal(relativeTime(new Date(NOW - 5 * MINUTE)), "5 minutes ago");
    assert.equal(relativeTime(new Date(NOW + 2 * HOUR)), "in 2 hours");
    assert.equal(relativeTime(new Date(NOW)), "0 seconds ago");
  });

  it("parses an ISO string", () => {
    assert.equal(relativeTime(new Date(NOW - 3 * DAY).toISOString()), "3 days ago");
  });

  it("reads a number below 1e12 as seconds and one at or above it as milliseconds", () => {
    assert.equal(relativeTime((NOW - HOUR) / 1000), "1 hour ago");
    assert.equal(relativeTime(NOW - HOUR), "1 hour ago");
  });

  it("switches units exactly at the 1e12 heuristic boundary", () => {
    // 1e12 ms is 2001-09-09; one less, read as seconds, lands ~31653 years out.
    assert.equal(relativeTime(1e12), "25 years ago");
    assert.equal(relativeTime(1e12 - 1), "in 31653 years");
  });

  it("returns an empty string for a missing or unparseable date", () => {
    assert.equal(relativeTime(null), "");
    assert.equal(relativeTime(undefined), "");
    assert.equal(relativeTime(""), "");
    assert.equal(relativeTime("not-a-date"), "");
    assert.equal(relativeTime(new Date("not-a-date")), "");
    assert.equal(relativeTime(Number.NaN), "");
  });
});

describe("formatBytes", () => {
  it("keeps whole bytes below 1024", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1023), "1023 B");
  });

  it("switches to KB at 1024 and to MB at 1024 * 1024, with one decimal", () => {
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1024 * 1024 - 1), "1024.0 KB");
    assert.equal(formatBytes(1024 * 1024), "1.0 MB");
    assert.equal(formatBytes(1024 * 1024 * 1024 - 1), "1024.0 MB");
  });

  it("switches to GB at 1024 ** 3, with two decimals", () => {
    assert.equal(formatBytes(1024 ** 3), "1.00 GB");
    assert.equal(formatBytes(5 * 1024 ** 3), "5.00 GB");
  });

  it("picks the unit from the magnitude of a negative value", () => {
    assert.equal(formatBytes(-512), "-512 B");
    assert.equal(formatBytes(-2048), "-2.0 KB");
  });

  it("falls back to '0 B' for a missing or NaN size", () => {
    assert.equal(formatBytes(null), "0 B");
    assert.equal(formatBytes(undefined), "0 B");
    assert.equal(formatBytes(Number.NaN), "0 B");
  });
});
