import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

const CLIENT_STUB = "stub:api-client";

const clientStubSource = `
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

const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const sourceModule: string = "./skillSources.ts";
const skillSources = (await import(sourceModule)) as typeof import("./skillSources");
const {
  canManageMattPocockSkillsSource,
  mattPocockSkillsApi,
  mattPocockSkillsKeys,
} = skillSources;

beforeEach(() => {
  calls.length = 0;
});

describe("mattPocockSkillsApi", () => {
  it("reads the source state", async () => {
    await mattPocockSkillsApi.get();
    assert.deepEqual(calls, [
      {
        method: "GET",
        path: "/admin/skill-sources/mattpocock",
        body: undefined,
      },
    ]);
  });

  it("forwards partial source controls without inventing defaults", async () => {
    const payload = { enabled: true };
    await mattPocockSkillsApi.update(payload);
    assert.equal(calls[0]?.body, payload);
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/admin/skill-sources/mattpocock",
        body: { enabled: true },
      },
    ]);

    calls.length = 0;
    await mattPocockSkillsApi.update({ auto_update: false });
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/admin/skill-sources/mattpocock",
        body: { auto_update: false },
      },
    ]);
  });

  it("refreshes through the dedicated side-effecting endpoint", async () => {
    await mattPocockSkillsApi.refresh();
    assert.deepEqual(calls, [
      {
        method: "POST",
        path: "/admin/skill-sources/mattpocock/refresh",
        body: undefined,
      },
    ]);
  });
});

describe("mattPocockSkillsKeys", () => {
  it("keeps source state under the existing skills invalidation root", () => {
    assert.deepEqual(mattPocockSkillsKeys.all, ["skills"]);
    assert.deepEqual(mattPocockSkillsKeys.source(), ["skills", "source", "mattpocock"]);
  });
});

describe("canManageMattPocockSkillsSource", () => {
  it("allows owner/admin roles from either auth-status representation", () => {
    assert.equal(canManageMattPocockSkillsSource(["owner"]), true);
    assert.equal(canManageMattPocockSkillsSource(["ADMIN"]), true);
    assert.equal(canManageMattPocockSkillsSource([], "owner"), true);
    assert.equal(canManageMattPocockSkillsSource(["viewer"], " admin "), true);
  });

  it("keeps every read-only and legacy role read-only", () => {
    assert.equal(canManageMattPocockSkillsSource([], null), false);
    assert.equal(canManageMattPocockSkillsSource(["viewer"]), false);
    assert.equal(canManageMattPocockSkillsSource(["fleet_operator"], "trusted_user"), false);
    assert.equal(canManageMattPocockSkillsSource(["user"], "viewer"), false);
  });
});

describe("module surface", () => {
  it("exports only the source contract, client, keys, and trusted repository", () => {
    assert.deepEqual(Object.keys(skillSources).sort(), [
      "MATTPOCOCK_REPOSITORY",
      "canManageMattPocockSkillsSource",
      "mattPocockSkillsApi",
      "mattPocockSkillsKeys",
    ]);
  });
});
