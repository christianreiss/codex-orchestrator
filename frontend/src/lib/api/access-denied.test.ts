import assert from "node:assert/strict";
import { describe, it } from "node:test";

const path: string = "./access-denied.ts";
const { accessDenied, accessDeniedText, errorText, loadFailure } = await import(path) as typeof import("./access-denied");

class FakeApiError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, body?: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

describe("accessDenied", () => {
  it("names the capability a 403 envelope carries", () => {
    const err = new FakeApiError(403, { status: "error", code: "admin_role_required", required_capability: "workflows.read" });
    assert.deepEqual(accessDenied(err), { capability: "workflows.read" });
  });

  it("still classifies a 403 without a capability", () => {
    assert.deepEqual(accessDenied(new FakeApiError(403, { status: "error", message: "Forbidden" })), { capability: null });
    assert.deepEqual(accessDenied(new FakeApiError(403)), { capability: null });
  });

  it("ignores every other failure", () => {
    assert.equal(accessDenied(new FakeApiError(401)), null);
    assert.equal(accessDenied(new FakeApiError(500, { required_capability: "x" })), null);
    assert.equal(accessDenied(new Error("boom")), null);
    assert.equal(accessDenied("Forbidden"), null);
    assert.equal(accessDenied(null), null);
    assert.equal(accessDenied(undefined), null);
  });
});

describe("accessDeniedText", () => {
  it("says what is missing and who can grant it", () => {
    assert.equal(accessDeniedText("secrets.read"), "You need the secrets.read capability. An owner or admin can grant it.");
    assert.match(accessDeniedText(null), /An owner or admin can grant it\.$/);
  });
});

describe("errorText", () => {
  it("passes strings through and reads Error messages", () => {
    assert.equal(errorText("Could not load"), "Could not load");
    assert.equal(errorText(new Error("boom")), "boom");
    assert.equal(errorText(null), null);
    assert.equal(errorText(undefined), null);
    assert.equal(errorText(""), null);
  });
});

describe("loadFailure", () => {
  it("keeps a denial intact so the table can classify it", () => {
    const err = new FakeApiError(403, { required_capability: "secrets.read" });
    assert.equal(loadFailure(err, "Could not load secrets"), err);
  });

  it("prefixes any other failure with the resource", () => {
    assert.equal(loadFailure(new FakeApiError(500), "Could not load secrets"), "Could not load secrets: HTTP 500");
    assert.equal(loadFailure(new Error("boom")), "boom");
    assert.equal(loadFailure(null, "Could not load secrets"), null);
  });
});
