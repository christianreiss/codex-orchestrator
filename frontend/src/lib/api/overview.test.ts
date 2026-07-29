import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

// `overview.ts` only ever touches the network through `./client`. Stubbing it
// and svelte-query (whose entry point re-exports `.svelte` files node cannot
// load) keeps every builder importable outside the browser and records what
// each one puts on the wire.
const QUERY_STUB = "stub:svelte-query";
const CLIENT_STUB = "stub:api-client";

const queryStubSource = `
export function createQuery(options) {
  return options;
}
export function createMutation(options) {
  return options;
}
`;

const clientStubSource = `
/** Every request the builders issued, in call order; shared with the test. */
export const calls = [];

const record = (method, path, body) => {
  calls.push({ method, path, body });
  return Promise.resolve(null);
};

export class ApiError extends Error {}

export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tanstack/svelte-query") return { url: QUERY_STUB, shortCircuit: true };
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === QUERY_STUB) {
      return { format: "module", shortCircuit: true, source: queryStubSource };
    }
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

/** What the stubbed `createQuery` hands back in place of a store. */
interface BuiltQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  retry?: number;
}

/** What the stubbed `createMutation` hands back in place of a store. */
interface BuiltMutation {
  mutationFn: (variables: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, variables: unknown, context: unknown) => void;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const overviewModule: string = "./overview.ts";
const overview = (await import(overviewModule)) as typeof import("./overview");

const asQuery = (built: unknown): BuiltQuery => built as unknown as BuiltQuery;
const asMutation = (built: unknown): BuiltMutation => built as unknown as BuiltMutation;

interface QueryCase {
  /** The exported builder, as the surface test matches it. */
  name: string;
  build: () => BuiltQuery;
  queryKey: readonly unknown[];
  path: string;
  /** `undefined` where the builder leaves svelte-query's default in place. */
  retry: number | undefined;
}

const QUERY_CASES: QueryCase[] = [
  {
    name: "overviewQuery",
    build: () => asQuery(overview.overviewQuery()),
    queryKey: ["overview"],
    path: "/admin/overview",
    retry: undefined,
  },
  {
    name: "insecureApprovalsPendingQuery",
    build: () => asQuery(overview.insecureApprovalsPendingQuery()),
    queryKey: ["overview", "insecure-approvals"],
    path: "/admin/insecure-approvals/pending",
    // The probe 404s on a backend with insecure approvals switched off, so the
    // dashboard takes the first answer rather than retrying into a delay.
    retry: 0,
  },
];

beforeEach(() => {
  calls.length = 0;
});

describe("query builders", () => {
  for (const queryCase of QUERY_CASES) {
    it(`${queryCase.name} keys and reads ${queryCase.path}`, async () => {
      const built = queryCase.build();
      assert.deepEqual(built.queryKey, queryCase.queryKey);
      assert.equal(built.retry, queryCase.retry);

      await built.queryFn();
      assert.deepEqual(calls, [{ method: "GET", path: queryCase.path, body: undefined }]);
    });
  }

  it("keys both queries off the shared overviewKeys tuples", () => {
    assert.deepEqual(asQuery(overview.overviewQuery()).queryKey, overview.overviewKeys.root);
    assert.deepEqual(
      asQuery(overview.insecureApprovalsPendingQuery()).queryKey,
      overview.overviewKeys.insecure,
    );
  });
});

describe("versionsCheckMutation", () => {
  it("posts /admin/versions/check with no body", async () => {
    const built = asMutation(overview.versionsCheckMutation());
    await built.mutationFn(undefined);

    // The probe carries no payload at all, not even an empty object.
    assert.deepEqual(calls, [{ method: "POST", path: "/admin/versions/check", body: undefined }]);
  });

  it("refreshes nothing on success", () => {
    // The dashboard reads the fresh versions off the mutation's own `data`, so
    // the builder takes no QueryClient and invalidates nothing.
    assert.equal(asMutation(overview.versionsCheckMutation()).onSuccess, undefined);
  });
});

describe("overviewKeys", () => {
  it("namespaces all three keys under the overview root", () => {
    assert.deepEqual(overview.overviewKeys, {
      root: ["overview"],
      insecure: ["overview", "insecure-approvals"],
      versionsCheck: ["overview", "versions-check"],
    });
  });
});

describe("module surface", () => {
  /** Every runtime export, so a new builder cannot slip past the cases above. */
  const EXPECTED_EXPORTS = [
    "insecureApprovalsPendingQuery",
    "overviewKeys",
    "overviewQuery",
    "versionsCheckMutation",
  ];

  it("exports exactly the documented surface", () => {
    assert.deepEqual(Object.keys(overview).sort(), EXPECTED_EXPORTS);
  });

  it("drives every exported query and mutation builder", () => {
    const driven = new Set([
      ...QUERY_CASES.map((queryCase) => queryCase.name),
      "versionsCheckMutation",
    ]);
    const exported = Object.keys(overview).filter(
      (name) => name.endsWith("Query") || name.endsWith("Mutation"),
    );

    assert.deepEqual(
      exported.filter((name) => !driven.has(name)),
      [],
      "every builder needs a case in QUERY_CASES or a describe block of its own",
    );
    assert.deepEqual(
      [...driven].filter((name) => !exported.includes(name)),
      [],
      "every case must name a builder the module still exports",
    );
  });
});
