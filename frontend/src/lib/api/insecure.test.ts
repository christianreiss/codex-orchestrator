import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

import type { QueryClient } from "@tanstack/svelte-query";

// `insecure.ts` only ever touches the network through `./client`, and takes the
// invalidation handle from its caller. Stubbing `./client` and svelte-query
// (whose entry point re-exports `.svelte` files node cannot load) keeps every
// builder importable outside the browser and records what each one puts on the
// wire; the recording QueryClient below captures which keys it invalidates.
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
  refetchInterval?: number;
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

const insecureModule: string = "./insecure.ts";
const insecure = (await import(insecureModule)) as typeof import("./insecure");

const hostsModule: string = "./hosts.ts";
const { hostsKeys } = (await import(hostsModule)) as typeof import("./hosts");

/** Every key handed to invalidateQueries, in call order. */
const invalidations: unknown[][] = [];

/** Stands in for the QueryClient the caller owns; records key order only. */
const queryClient = {
  invalidateQueries: (filters: { queryKey: unknown[] }) => {
    invalidations.push(filters.queryKey);
  },
} as unknown as QueryClient;

const asQuery = (built: unknown): BuiltQuery => built as unknown as BuiltQuery;
const asMutation = (built: unknown): BuiltMutation => built as unknown as BuiltMutation;

/**
 * The keys the module reaches for, written once so a query case and the
 * mutations that refresh it cannot drift apart in the tables below.
 */
const KEYS = {
  hosts: ["hosts"],
  summary: ["hosts", "insecure"],
  approvals: ["insecure-approvals"],
  /** The hand-rolled tuple the per-host mutations duplicate from `hostsKeys`. */
  detail: (id: number | string) => ["hosts", "detail", String(id)],
} as const;

interface QueryCase {
  /** The exported builder, as the guard test matches it. */
  name: string;
  build: () => BuiltQuery;
  queryKey: readonly unknown[];
  path: string;
  refetchInterval: number;
}

const QUERY_CASES: QueryCase[] = [
  {
    name: "insecureSummaryQuery",
    build: () => asQuery(insecure.insecureSummaryQuery()),
    queryKey: KEYS.summary,
    path: "/admin/hosts/insecure",
    refetchInterval: 15_000,
  },
  {
    name: "insecureApprovalsQuery",
    build: () => asQuery(insecure.insecureApprovalsQuery()),
    queryKey: KEYS.approvals,
    path: "/admin/insecure-approvals/pending",
    refetchInterval: 30_000,
  },
];

interface MutationCase {
  /** The exported builder, as the guard test matches it. */
  name: string;
  label?: string;
  build: (qc: QueryClient) => BuiltMutation;
  variables: unknown;
  request: RecordedCall;
  /** The keys `onSuccess` must invalidate, in order. */
  invalidates: readonly (readonly unknown[])[];
}

const MUTATION_CASES: MutationCase[] = [
  {
    name: "createEnableInsecureMutation",
    label: "createEnableInsecureMutation with a duration",
    build: (qc) => asMutation(insecure.createEnableInsecureMutation(qc)),
    variables: { id: 7, duration_minutes: 30 },
    request: {
      method: "POST",
      path: "/admin/hosts/7/insecure/enable",
      body: { duration_minutes: 30 },
    },
    invalidates: [KEYS.hosts, KEYS.summary, KEYS.detail(7)],
  },
  {
    name: "createEnableInsecureMutation",
    label: "createEnableInsecureMutation without a duration",
    build: (qc) => asMutation(insecure.createEnableInsecureMutation(qc)),
    variables: { id: "host-7" },
    request: {
      method: "POST",
      path: "/admin/hosts/host-7/insecure/enable",
      // The key is still on the object; `JSON.stringify` is what drops it.
      body: { duration_minutes: undefined },
    },
    invalidates: [KEYS.hosts, KEYS.summary, KEYS.detail("host-7")],
  },
  {
    name: "createDisableInsecureMutation",
    build: (qc) => asMutation(insecure.createDisableInsecureMutation(qc)),
    variables: { id: 7 },
    request: {
      method: "POST",
      path: "/admin/hosts/7/insecure/disable",
      body: undefined,
    },
    invalidates: [KEYS.hosts, KEYS.summary, KEYS.detail(7)],
  },
  {
    name: "createExtendAllInsecureMutation",
    build: (qc) => asMutation(insecure.createExtendAllInsecureMutation(qc)),
    variables: undefined,
    request: { method: "POST", path: "/admin/hosts/insecure/extend", body: undefined },
    // Bulk actions carry no id, so no host-detail key rides along.
    invalidates: [KEYS.hosts, KEYS.summary],
  },
  {
    name: "createOpenFleetWindowMutation",
    label: "createOpenFleetWindowMutation with a duration",
    build: (qc) => asMutation(insecure.createOpenFleetWindowMutation(qc)),
    variables: { duration_minutes: 480 },
    request: {
      method: "POST",
      path: "/admin/hosts/insecure/window",
      body: { duration_minutes: 480 },
    },
    // Opening resolves the pending queue too, so the approvals key rides along.
    invalidates: [KEYS.hosts, KEYS.summary, KEYS.approvals],
  },
  {
    name: "createOpenFleetWindowMutation",
    label: "createOpenFleetWindowMutation without a duration",
    build: (qc) => asMutation(insecure.createOpenFleetWindowMutation(qc)),
    variables: {},
    request: {
      method: "POST",
      path: "/admin/hosts/insecure/window",
      body: { duration_minutes: undefined },
    },
    invalidates: [KEYS.hosts, KEYS.summary, KEYS.approvals],
  },
  {
    name: "createCloseFleetWindowMutation",
    build: (qc) => asMutation(insecure.createCloseFleetWindowMutation(qc)),
    variables: undefined,
    request: { method: "POST", path: "/admin/hosts/insecure/window/close", body: undefined },
    invalidates: [KEYS.hosts, KEYS.summary, KEYS.approvals],
  },
  {
    name: "createDisableAllInsecureMutation",
    build: (qc) => asMutation(insecure.createDisableAllInsecureMutation(qc)),
    variables: undefined,
    request: { method: "POST", path: "/admin/hosts/insecure/disable-all", body: undefined },
    invalidates: [KEYS.hosts, KEYS.summary],
  },
  {
    name: "createApproveInsecureMutation",
    label: "createApproveInsecureMutation with a duration",
    build: (qc) => asMutation(insecure.createApproveInsecureMutation(qc)),
    variables: { id: 12, duration_minutes: 45 },
    request: {
      method: "POST",
      path: "/admin/insecure-approvals/12/approve",
      body: { duration_minutes: 45 },
    },
    // Approving opens a window on some host, but the approval carries no host
    // id, so the whole `hosts` tree is refreshed instead of one detail entry.
    invalidates: [KEYS.approvals, KEYS.summary, KEYS.hosts],
  },
  {
    name: "createApproveInsecureMutation",
    label: "createApproveInsecureMutation without a duration",
    build: (qc) => asMutation(insecure.createApproveInsecureMutation(qc)),
    variables: { id: "12" },
    request: {
      method: "POST",
      path: "/admin/insecure-approvals/12/approve",
      body: { duration_minutes: undefined },
    },
    invalidates: [KEYS.approvals, KEYS.summary, KEYS.hosts],
  },
  {
    name: "createDenyInsecureMutation",
    build: (qc) => asMutation(insecure.createDenyInsecureMutation(qc)),
    variables: { id: 12 },
    request: {
      method: "POST",
      path: "/admin/insecure-approvals/12/deny",
      body: undefined,
    },
    // A denial opens nothing, so only the pending list moves.
    invalidates: [KEYS.approvals],
  },
  {
    name: "createAllowDomainMutation",
    label: "createAllowDomainMutation with a duration",
    build: (qc) => asMutation(insecure.createAllowDomainMutation(qc)),
    variables: { id: 12, domain: "example.com", duration_minutes: 60 },
    request: {
      method: "POST",
      path: "/admin/insecure-approvals/12/allow-domain",
      body: { domain: "example.com", duration_minutes: 60 },
    },
    invalidates: [KEYS.approvals, KEYS.summary],
  },
  {
    name: "createAllowDomainMutation",
    label: "createAllowDomainMutation without a duration",
    build: (qc) => asMutation(insecure.createAllowDomainMutation(qc)),
    variables: { id: 12, domain: "example.com" },
    request: {
      method: "POST",
      path: "/admin/insecure-approvals/12/allow-domain",
      body: { domain: "example.com", duration_minutes: undefined },
    },
    invalidates: [KEYS.approvals, KEYS.summary],
  },
  {
    name: "createRevokeDomainMutation",
    build: (qc) => asMutation(insecure.createRevokeDomainMutation(qc)),
    variables: { id: 5 },
    request: {
      method: "POST",
      path: "/admin/insecure-domain-allows/5/revoke",
      body: undefined,
    },
    // The allow-list only shows up in the summary; the pending list is untouched.
    invalidates: [KEYS.summary],
  },
];

/** The body as the client would actually serialise it. */
const wire = (): string => JSON.stringify(calls.at(-1)?.body);

beforeEach(() => {
  calls.length = 0;
  invalidations.length = 0;
});

describe("query builders", () => {
  for (const queryCase of QUERY_CASES) {
    it(`${queryCase.name} keys and reads ${queryCase.path}`, async () => {
      const built = queryCase.build();
      assert.deepEqual(built.queryKey, queryCase.queryKey);
      assert.equal(built.refetchInterval, queryCase.refetchInterval);

      await built.queryFn();
      assert.deepEqual(calls, [{ method: "GET", path: queryCase.path, body: undefined }]);
    });
  }

  it("keys the summary the way the hosts feature keys it", () => {
    assert.deepEqual(insecure.insecureKeys.summary(), hostsKeys.insecure());
  });
});

describe("mutation builders", () => {
  for (const mutationCase of MUTATION_CASES) {
    const label = mutationCase.label ?? mutationCase.name;

    it(`${label} writes ${mutationCase.request.path}`, async () => {
      const built = mutationCase.build(queryClient);
      await built.mutationFn(mutationCase.variables);
      assert.deepEqual(calls, [mutationCase.request]);
    });

    it(`${label} invalidates its keys in order`, () => {
      const built = mutationCase.build(queryClient);
      built.onSuccess?.(null, mutationCase.variables, undefined);
      assert.deepEqual(invalidations, mutationCase.invalidates);
    });
  }
});

describe("duration_minutes payloads", () => {
  it("drops the key from the enable body when no duration is given", async () => {
    const built = asMutation(insecure.createEnableInsecureMutation(queryClient));

    await built.mutationFn({ id: 7 });
    assert.equal(wire(), "{}");

    // `?? undefined` catches an explicit null too, so a cleared input in the
    // dialog still means "use the server default" rather than "no window".
    await built.mutationFn({ id: 7, duration_minutes: null });
    assert.equal(wire(), "{}");

    await built.mutationFn({ id: 7, duration_minutes: 30 });
    assert.equal(wire(), '{"duration_minutes":30}');
  });

  it("drops the key from the approve body the same way", async () => {
    const built = asMutation(insecure.createApproveInsecureMutation(queryClient));

    await built.mutationFn({ id: 12 });
    assert.equal(wire(), "{}");

    await built.mutationFn({ id: 12, duration_minutes: null });
    assert.equal(wire(), "{}");

    await built.mutationFn({ id: 12, duration_minutes: 45 });
    assert.equal(wire(), '{"duration_minutes":45}');
  });

  it("forwards the allow-domain duration raw, null included", async () => {
    const built = asMutation(insecure.createAllowDomainMutation(queryClient));

    await built.mutationFn({ id: 12, domain: "example.com" });
    assert.equal(wire(), '{"domain":"example.com"}');

    // Unlike enable/approve, no `?? undefined` sits in the way, so a null
    // reaches the backend as an explicit null.
    await built.mutationFn({ id: 12, domain: "example.com", duration_minutes: null });
    assert.equal(wire(), '{"domain":"example.com","duration_minutes":null}');

    await built.mutationFn({ id: 12, duration_minutes: 60 });
    assert.equal(wire(), '{"duration_minutes":60}');
  });
});

describe("per-host invalidation", () => {
  /** The builders that refresh one host's detail entry, and their variables. */
  const PER_HOST = [
    { name: "createEnableInsecureMutation", build: insecure.createEnableInsecureMutation },
    { name: "createDisableInsecureMutation", build: insecure.createDisableInsecureMutation },
  ];

  for (const perHost of PER_HOST) {
    for (const id of [7, "7", "host-7"]) {
      it(`${perHost.name} refreshes hostsKeys.detail(${JSON.stringify(id)})`, () => {
        const built = asMutation(perHost.build(queryClient));
        built.onSuccess?.(null, { id }, undefined);

        // The module writes the tuple by hand; it has to stay byte-identical to
        // the key `hostDetailQuery` registers or the refresh lands nowhere.
        assert.deepEqual(invalidations.at(-1), hostsKeys.detail(id));
      });
    }
  }
});

describe("module surface", () => {
  /** Every runtime export, so a new builder cannot slip past the tables above. */
  const EXPECTED_EXPORTS = [
    "createAllowDomainMutation",
    "createApproveInsecureMutation",
    "createCloseFleetWindowMutation",
    "createDenyInsecureMutation",
    "createDisableAllInsecureMutation",
    "createDisableInsecureMutation",
    "createEnableInsecureMutation",
    "createExtendAllInsecureMutation",
    "createOpenFleetWindowMutation",
    "createRevokeDomainMutation",
    "insecureApprovalsQuery",
    "insecureKeys",
    "insecureSummaryQuery",
  ];

  it("exports exactly the documented surface", () => {
    assert.deepEqual(Object.keys(insecure).sort(), EXPECTED_EXPORTS);
  });

  it("drives every exported query and mutation builder", () => {
    const driven = new Set([...QUERY_CASES, ...MUTATION_CASES].map((testCase) => testCase.name));
    const exported = Object.keys(insecure).filter(
      (name) => name.endsWith("Query") || name.endsWith("Mutation"),
    );

    assert.deepEqual(
      exported.filter((name) => !driven.has(name)),
      [],
      "every builder needs a case in QUERY_CASES or MUTATION_CASES",
    );
    assert.deepEqual(
      [...driven].filter((name) => !exported.includes(name)),
      [],
      "every case must name a builder the module still exports",
    );
  });
});
