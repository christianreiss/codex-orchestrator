import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

import type { MemoryGraphParams, MemoryScope } from "./memories";

// `memories.ts` builds every request by hand and hands the finished path to the
// real API client. Stubbing `./client` keeps the module importable outside the
// browser and records what each call would have put on the wire.
const CLIENT_STUB = "stub:api-client";

const clientStubSource = `
/** Every request the module issued, in call order; shared with the test. */
export const calls = [];

const record = (via, method, path, body) => {
  calls.push({ via, method, path, body });
  return Promise.resolve(null);
};

export const api = {
  get: (path) => record("api", "GET", path, undefined),
  post: (path, body) => record("api", "POST", path, body),
  patch: (path, body) => record("api", "PATCH", path, body),
  delete: (path) => record("api", "DELETE", path, undefined),
};

export const apiFetch = (path, init) => record("apiFetch", init.method, path, init.body);
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
  /** `apiFetch` marks the calls that deliberately bypass the `api` helpers. */
  via: "api" | "apiFetch";
  method: string;
  path: string;
  body: unknown;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const memoriesModule: string = "./memories.ts";
const { memoriesApi, memoriesKeys } = (await import(
  memoriesModule
)) as typeof import("./memories");

function lastCall(): RecordedCall {
  const call = calls.at(-1);
  assert.ok(call, "expected a request to have been issued");
  return call;
}

/** Issues `graph(params)` and hands back the path the client was asked for. */
async function graphPath(params: MemoryGraphParams): Promise<string> {
  await memoriesApi.graph(params);
  return lastCall().path;
}

/** The documented order of the graph filters, as `graphSearch` emits them. */
const GRAPH_PARAM_NAMES = [
  "scopes",
  "q",
  "tags",
  "host_id",
  "project_slug",
  "engine",
  "limit",
  "cursor",
];

describe("memoriesApi.graph", () => {
  it("asks for the bare path when nothing is filtered", async () => {
    assert.equal(await graphPath({}), "/admin/memories/graph");
    assert.equal(lastCall().via, "api");
    assert.equal(lastCall().method, "GET");
  });

  it("drops a blank or whitespace-only search term", async () => {
    assert.equal(await graphPath({ q: "" }), "/admin/memories/graph");
    assert.equal(await graphPath({ q: "   " }), "/admin/memories/graph");
    assert.equal(await graphPath({ q: "\t\n" }), "/admin/memories/graph");
  });

  it("drops empty scope and tag lists", async () => {
    assert.equal(await graphPath({ scopes: [], tags: [] }), "/admin/memories/graph");
  });

  it("drops a host filter that carries no id", async () => {
    assert.equal(await graphPath({ host_id: null }), "/admin/memories/graph");
    assert.equal(await graphPath({ host_id: undefined }), "/admin/memories/graph");
    assert.equal(await graphPath({ host_id: "" }), "/admin/memories/graph");
  });

  it("keeps host id 0, which is falsy but still a filter", async () => {
    assert.equal(await graphPath({ host_id: 0 }), "/admin/memories/graph?host_id=0");
  });

  it("drops an empty project, engine, limit and cursor", async () => {
    assert.equal(await graphPath({ project_slug: null }), "/admin/memories/graph");
    assert.equal(await graphPath({ project_slug: "" }), "/admin/memories/graph");
    assert.equal(await graphPath({ engine: null }), "/admin/memories/graph");
    assert.equal(await graphPath({ engine: "" }), "/admin/memories/graph");
    assert.equal(await graphPath({ limit: 0 }), "/admin/memories/graph");
    assert.equal(await graphPath({ cursor: null }), "/admin/memories/graph");
    assert.equal(await graphPath({ cursor: "" }), "/admin/memories/graph");
  });

  it("emits every filter under the name the catalog parses", async () => {
    const path = await graphPath({
      scopes: ["host", "project", "shared"],
      q: "  needle  ",
      tags: ["alpha", "beta"],
      host_id: 7,
      project_slug: "atlas",
      engine: "codex",
      limit: 25,
      cursor: "cursor-1",
    });

    assert.equal(
      path,
      "/admin/memories/graph?scopes=host%2Cproject%2Cshared&q=needle&tags=alpha%2Cbeta" +
        "&host_id=7&project_slug=atlas&engine=codex&limit=25&cursor=cursor-1",
    );

    const search = new URLSearchParams(path.split("?")[1]);
    assert.deepEqual([...search.keys()], GRAPH_PARAM_NAMES);
    assert.equal(search.get("scopes"), "host,project,shared");
    assert.equal(search.get("tags"), "alpha,beta");
    assert.equal(search.get("q"), "needle", "the term is trimmed before it is sent");
  });

  it("stringifies a host id handed over as a string", async () => {
    assert.equal(await graphPath({ host_id: "12" }), "/admin/memories/graph?host_id=12");
  });
});

describe("memoriesApi record paths", () => {
  it("reads one record", async () => {
    await memoriesApi.detail("shared", 42);
    assert.deepEqual(lastCall(), {
      via: "api",
      method: "GET",
      path: "/admin/memories/shared/42",
      body: undefined,
    });
  });

  it("posts a new record to the scope root, without a record id", async () => {
    const payload = { id: "atlas-note", content: "body" };
    await memoriesApi.create("host", payload);
    assert.deepEqual(lastCall(), {
      via: "api",
      method: "POST",
      path: "/admin/memories/host",
      body: payload,
    });
  });

  it("patches one record", async () => {
    const payload = { expected_etag: "etag-1", content: "next" };
    await memoriesApi.update("project", "7", payload);
    assert.deepEqual(lastCall(), {
      via: "api",
      method: "PATCH",
      path: "/admin/memories/project/7",
      body: payload,
    });
  });

  it("percent-encodes a scope or record id carrying a slash", async () => {
    const scope = "host/../shared" as MemoryScope;
    await memoriesApi.create(scope, { id: "x", content: "y" });
    assert.equal(lastCall().path, "/admin/memories/host%2F..%2Fshared");

    await memoriesApi.detail("shared", "a/b");
    assert.equal(lastCall().path, "/admin/memories/shared/a%2Fb");

    await memoriesApi.update(scope, "a/b", { expected_etag: "etag-1" });
    assert.equal(lastCall().path, "/admin/memories/host%2F..%2Fshared/a%2Fb");
  });
});

describe("memoriesApi.delete", () => {
  it("goes through apiFetch so the etag can ride along in the body", async () => {
    await memoriesApi.delete("shared", 9, "etag-1");
    assert.deepEqual(lastCall(), {
      via: "apiFetch",
      method: "DELETE",
      path: "/admin/memories/shared/9",
      body: { expected_etag: "etag-1" },
    });
  });

  it("encodes the record id like the other verbs do", async () => {
    await memoriesApi.delete("shared", "a/b", "etag-1");
    assert.equal(lastCall().path, "/admin/memories/shared/a%2Fb");
  });
});

describe("memoriesApi.append", () => {
  it("posts the content to the shared append path", async () => {
    await memoriesApi.append(3, "more text");
    assert.deepEqual(lastCall(), {
      via: "api",
      method: "POST",
      path: "/admin/memories/shared/3/append",
      body: { content: "more text" },
    });
  });

  it("encodes the record id", async () => {
    await memoriesApi.append("a/b", "more text");
    assert.equal(lastCall().path, "/admin/memories/shared/a%2Fb/append");
  });
});

describe("memoriesApi.audit", () => {
  it("sends the node id with the default page size", async () => {
    await memoriesApi.audit("mem:shared:3");
    assert.deepEqual(lastCall(), {
      via: "api",
      method: "GET",
      path: "/admin/memories/audit?node_id=mem%3Ashared%3A3&limit=50",
      body: undefined,
    });
  });

  it("appends a cursor when there is one", async () => {
    await memoriesApi.audit("node-1", 10, "cursor-1");
    assert.equal(
      lastCall().path,
      "/admin/memories/audit?node_id=node-1&limit=10&cursor=cursor-1",
    );
  });

  it("omits the cursor when it is null or blank", async () => {
    await memoriesApi.audit("node-1", 10, null);
    assert.equal(lastCall().path, "/admin/memories/audit?node_id=node-1&limit=10");

    await memoriesApi.audit("node-1", 10, "");
    assert.equal(lastCall().path, "/admin/memories/audit?node_id=node-1&limit=10");
  });
});

describe("memoriesKeys", () => {
  it("roots every key at the tuple WebSocket invalidation targets", () => {
    assert.deepEqual(memoriesKeys.all, ["memories"]);
    assert.equal(memoriesKeys.graph({}).at(0), "memories");
    assert.equal(memoriesKeys.detail("shared", 1).at(0), "memories");
    assert.equal(memoriesKeys.audit("node-1").at(0), "memories");
  });

  it("carries the graph params through by reference", () => {
    const params: MemoryGraphParams = { scopes: ["shared"], q: "needle" };
    assert.deepEqual(memoriesKeys.graph(params), ["memories", "graph", params]);
  });

  it("stringifies the record id so 1 and \"1\" key the same detail", () => {
    assert.deepEqual(memoriesKeys.detail("shared", 1), ["memories", "detail", "shared", "1"]);
    assert.deepEqual(memoriesKeys.detail("shared", "1"), ["memories", "detail", "shared", "1"]);
  });

  it("falls back to the first page when no audit cursor is given", () => {
    assert.deepEqual(memoriesKeys.audit("node-1"), ["memories", "audit", "node-1", "first"]);
    assert.deepEqual(memoriesKeys.audit("node-1", null), ["memories", "audit", "node-1", "first"]);
    assert.deepEqual(memoriesKeys.audit("node-1", "cursor-1"), [
      "memories",
      "audit",
      "node-1",
      "cursor-1",
    ]);
  });
});
