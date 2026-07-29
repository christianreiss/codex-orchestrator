import assert from "node:assert/strict";
import { describe, it } from "node:test";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const artifactModule: string = "./artifact.ts";
const { asString, asStringArray } = (await import(artifactModule)) as typeof import("./artifact");

describe("asString", () => {
  it("passes a string through untouched", () => {
    assert.equal(asString("code-review"), "code-review");
    assert.equal(asString(""), "");
  });

  it("stringifies numbers and booleans", () => {
    assert.equal(asString(42), "42");
    assert.equal(asString(0), "0");
    assert.equal(asString(true), "true");
    assert.equal(asString(false), "false");
  });

  it("returns an empty string for anything else", () => {
    assert.equal(asString(null), "");
    assert.equal(asString(undefined), "");
    assert.equal(asString({ name: "code-review" }), "");
    assert.equal(asString(["code-review"]), "");
  });
});

describe("asStringArray", () => {
  it("keeps an array of strings", () => {
    assert.deepEqual(asStringArray(["read", "write"]), ["read", "write"]);
    assert.deepEqual(asStringArray([]), []);
  });

  it("coerces array members and drops the ones that stringify to nothing", () => {
    assert.deepEqual(asStringArray(["read", 7, true, null, {}, ""]), ["read", "7", "true"]);
  });

  it("splits a string on commas and trims each entry", () => {
    assert.deepEqual(asStringArray("read, write ,  exec"), ["read", "write", "exec"]);
    assert.deepEqual(asStringArray("read"), ["read"]);
    assert.deepEqual(asStringArray("read,,write"), ["read", "write"]);
  });

  it("returns an empty array for a blank string or a non-string, non-array value", () => {
    assert.deepEqual(asStringArray(""), []);
    assert.deepEqual(asStringArray("   "), []);
    assert.deepEqual(asStringArray(","), []);
    assert.deepEqual(asStringArray(null), []);
    assert.deepEqual(asStringArray(undefined), []);
    assert.deepEqual(asStringArray(7), []);
    assert.deepEqual(asStringArray({ tools: "read" }), []);
  });
});
