import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

import type { AdminUser, AdminUserPayload } from "./types";

// `users.ts` only ever touches the network through `./client`, and takes its
// cache handle from svelte-query (whose entry point re-exports `.svelte` files
// node cannot load). Stubbing both keeps every builder importable outside the
// browser and records what each one puts on the wire; the query stub below also
// keeps a real cache entry so the optimistic writes and their rollbacks are
// observable.
const QUERY_STUB = "stub:svelte-query";
const CLIENT_STUB = "stub:api-client";

const queryStubSource = `
/** Every key handed to invalidateQueries / cancelQueries, in call order. */
export const invalidations = [];
export const cancellations = [];

/** The cache the optimistic handlers read and write, keyed by the JSON key. */
export const cache = new Map();

export function createQuery(options) {
  return options;
}
export function createMutation(options) {
  return options;
}
export function useQueryClient() {
  return {
    cancelQueries(filters) {
      cancellations.push(filters.queryKey);
      return Promise.resolve();
    },
    getQueryData(key) {
      return cache.get(JSON.stringify(key));
    },
    setQueryData(key, data) {
      cache.set(JSON.stringify(key), data);
    },
    invalidateQueries(filters) {
      invalidations.push(filters.queryKey);
    },
  };
}
`;

const clientStubSource = `
/** Every request the builders issued, in call order; shared with the test. */
export const calls = [];

/** What the next request resolves with; the readers unwrap it. */
export const response = { body: null };

const record = (method, path, body) => {
  calls.push({ method, path, body });
  return Promise.resolve(response.body);
};

export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
  delete: (path) => record("DELETE", path, undefined),
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
  method: "GET" | "POST" | "DELETE";
  path: string;
  body: unknown;
}

/** What the stubbed `createQuery` hands back in place of a store. */
interface BuiltQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
}

/** The context the optimistic handlers pass between themselves. */
interface Snapshot {
  previous?: AdminUser[];
}

/** What the stubbed `createMutation` hands back in place of a store. */
interface BuiltMutation {
  mutationFn: (variables: unknown) => Promise<unknown>;
  onMutate?: (variables: unknown) => Promise<Snapshot>;
  onError?: (error: unknown, variables: unknown, context: Snapshot | undefined) => void;
  onSuccess?: (...args: unknown[]) => void;
  onSettled?: (...args: unknown[]) => void;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls, response } = (await import(clientModule)) as {
  calls: RecordedCall[];
  response: { body: unknown };
};

const queryModule: string = QUERY_STUB;
const { invalidations, cancellations, cache } = (await import(queryModule)) as {
  invalidations: unknown[][];
  cancellations: unknown[][];
  cache: Map<string, AdminUser[]>;
};

const usersModule: string = "./users.ts";
const users = (await import(usersModule)) as typeof import("./users");

const asQuery = (built: unknown): BuiltQuery => built as unknown as BuiltQuery;
const asMutation = (built: unknown): BuiltMutation => built as unknown as BuiltMutation;

/**
 * The cached rows carry numeric ids, the way the API serialises them; the
 * variables below deliberately carry the string ids a form input produces.
 */
const ROWS: AdminUser[] = [
  {
    id: 1,
    name: "Ada",
    username: "ada",
    email: "ada@example.com",
    access_level: "admin",
    active: true,
  },
  {
    id: 2,
    name: "Grace",
    username: "grace",
    email: "grace@example.com",
    access_level: "user",
    active: true,
  },
];

const PAYLOAD: AdminUserPayload = {
  name: "Ada",
  username: "ada",
  email: "ada@example.com",
  access_level: "admin",
  active: true,
};

const CACHE_KEY = JSON.stringify(users.USERS_QUERY_KEY);
const cached = (): AdminUser[] | undefined => cache.get(CACHE_KEY);
const seed = (rows: AdminUser[]): void => {
  cache.set(CACHE_KEY, rows);
};

beforeEach(() => {
  calls.length = 0;
  invalidations.length = 0;
  cancellations.length = 0;
  cache.clear();
  response.body = null;
});

describe("readers", () => {
  it("createUsersQuery keys and reads /admin/users", async () => {
    const built = asQuery(users.createUsersQuery());
    assert.deepEqual(built.queryKey, users.USERS_QUERY_KEY);

    await built.queryFn();
    assert.deepEqual(calls, [{ method: "GET", path: "/admin/users", body: undefined }]);
  });

  it("listUsers returns the rows out of the envelope", async () => {
    response.body = { users: ROWS };
    assert.deepEqual(await users.listUsers(), ROWS);
  });

  /** Every body shape the endpoint may answer with when it carries no rows. */
  const EMPTY_BODIES: { label: string; body: unknown }[] = [
    { label: "a null body", body: null },
    { label: "an undefined body", body: undefined },
    { label: "a body with no users key", body: {} },
    { label: "a null users key", body: { users: null } },
  ];

  for (const empty of EMPTY_BODIES) {
    it(`listUsers returns [] for ${empty.label}`, async () => {
      response.body = empty.body;
      assert.deepEqual(await users.listUsers(), []);
    });
  }

  it("createUser and updateUser unwrap the user envelope", async () => {
    response.body = { user: ROWS[0] };
    assert.equal(await users.createUser(PAYLOAD), ROWS[0]);
    assert.equal(await users.updateUser(1, { active: false }), ROWS[0]);
  });
});

interface MutationCase {
  /** The exported builder, as the guard test matches it. */
  name: string;
  build: () => BuiltMutation;
  variables: unknown;
  request: RecordedCall;
  /** The hook the builder hangs its invalidation off; the optimistic pair differ. */
  hook: "onSuccess" | "onSettled";
}

const MUTATION_CASES: MutationCase[] = [
  {
    name: "createUserCreateMutation",
    build: () => asMutation(users.createUserCreateMutation()),
    variables: PAYLOAD,
    request: { method: "POST", path: "/admin/users", body: PAYLOAD },
    hook: "onSuccess",
  },
  {
    name: "createUserUpdateMutation",
    build: () => asMutation(users.createUserUpdateMutation()),
    variables: { id: 7, patch: { active: false } },
    // An update is a POST onto the row's path, not a PATCH or a PUT.
    request: { method: "POST", path: "/admin/users/7", body: { active: false } },
    hook: "onSettled",
  },
  {
    name: "createUserDeleteMutation",
    build: () => asMutation(users.createUserDeleteMutation()),
    variables: 7,
    request: { method: "DELETE", path: "/admin/users/7", body: undefined },
    hook: "onSettled",
  },
  {
    name: "createWipeUsersMutation",
    build: () => asMutation(users.createWipeUsersMutation()),
    variables: undefined,
    // The confirm token is a literal the backend checks; losing it is a 400.
    request: { method: "POST", path: "/admin/users/wipe", body: { confirm: "WIPE" } },
    hook: "onSuccess",
  },
];

describe("mutation builders", () => {
  for (const mutationCase of MUTATION_CASES) {
    it(`${mutationCase.name} writes ${mutationCase.request.method} ${mutationCase.request.path}`, async () => {
      response.body = { user: ROWS[0] };
      const built = mutationCase.build();

      await built.mutationFn(mutationCase.variables);
      assert.deepEqual(calls, [mutationCase.request]);
    });

    it(`${mutationCase.name} invalidates USERS_QUERY_KEY from ${mutationCase.hook}`, () => {
      const built = mutationCase.build();
      built[mutationCase.hook]?.(null, null, mutationCase.variables, undefined);
      assert.deepEqual(invalidations, [users.USERS_QUERY_KEY]);
    });
  }
});

interface OptimisticCase {
  /** The exported builder, as the guard test matches it. */
  name: string;
  build: () => BuiltMutation;
  /** A string id, against the numeric id the cached row carries. */
  variables: unknown;
  /** What `onMutate` has to leave in the cache. */
  expected: AdminUser[];
  verb: string;
}

const OPTIMISTIC_CASES: OptimisticCase[] = [
  {
    name: "createUserUpdateMutation",
    build: () => asMutation(users.createUserUpdateMutation()),
    variables: { id: "1", patch: { active: false } },
    expected: [{ ...ROWS[0], active: false }, ROWS[1]],
    verb: "patches",
  },
  {
    name: "createUserDeleteMutation",
    build: () => asMutation(users.createUserDeleteMutation()),
    variables: "1",
    expected: [ROWS[1]],
    verb: "removes",
  },
];

describe("optimistic cache writes", () => {
  for (const optimisticCase of OPTIMISTIC_CASES) {
    it(`${optimisticCase.name} ${optimisticCase.verb} only the row whose id matches as a string`, async () => {
      seed(ROWS);
      const built = optimisticCase.build();

      await built.onMutate?.(optimisticCase.variables);

      assert.deepEqual(cached(), optimisticCase.expected);
      assert.equal(cached()?.at(-1), ROWS[1], "the other row is left untouched");
      assert.deepEqual(cancellations, [users.USERS_QUERY_KEY], "in-flight reads are cancelled");
    });

    it(`${optimisticCase.name} returns the previous rows as its snapshot`, async () => {
      seed(ROWS);
      const built = optimisticCase.build();

      const context = await built.onMutate?.(optimisticCase.variables);
      assert.equal(context?.previous, ROWS);
    });

    it(`${optimisticCase.name} restores the snapshot verbatim on error`, async () => {
      seed(ROWS);
      const built = optimisticCase.build();

      const context = await built.onMutate?.(optimisticCase.variables);
      assert.notEqual(cached(), ROWS, "the optimistic write landed first");

      built.onError?.(new Error("boom"), optimisticCase.variables, context);
      assert.equal(cached(), ROWS);
    });

    it(`${optimisticCase.name} writes nothing when the cache is cold`, async () => {
      const built = optimisticCase.build();

      const context = await built.onMutate?.(optimisticCase.variables);
      assert.deepEqual(context, { previous: undefined });
      assert.equal(cached(), undefined);

      built.onError?.(new Error("boom"), optimisticCase.variables, context);
      assert.equal(cached(), undefined, "a cold cache is not re-seeded by the rollback");
    });
  }
});

describe("module surface", () => {
  /** Every runtime export, so a new builder cannot slip past the tables above. */
  const EXPECTED_EXPORTS = [
    "USERS_QUERY_KEY",
    "createUser",
    "createUserCreateMutation",
    "createUserDeleteMutation",
    "createUserUpdateMutation",
    "createUsersQuery",
    "createWipeUsersMutation",
    "deleteUser",
    "listUsers",
    "updateUser",
    "wipeAllUsers",
  ];

  it("exports exactly the documented surface", () => {
    assert.deepEqual(Object.keys(users).sort(), EXPECTED_EXPORTS);
  });

  it("drives every exported query and mutation builder", () => {
    const driven = new Set([
      "createUsersQuery",
      ...MUTATION_CASES.map((mutationCase) => mutationCase.name),
    ]);
    const exported = Object.keys(users).filter(
      (name) => name.endsWith("Query") || name.endsWith("Mutation"),
    );

    assert.deepEqual(
      exported.filter((name) => !driven.has(name)),
      [],
      "every builder needs a case in MUTATION_CASES",
    );
    assert.deepEqual(
      [...driven].filter((name) => !exported.includes(name)),
      [],
      "every case must name a builder the module still exports",
    );
  });
});
