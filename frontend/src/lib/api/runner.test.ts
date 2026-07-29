import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

// `runner.ts` only ever touches the network through `./client`, and takes its
// cache handle from svelte-query (whose entry point re-exports `.svelte` files
// node cannot load). Stubbing both keeps the builders importable outside the
// browser and records what each one puts on the wire; the query stub's
// `useQueryClient` records which keys the run mutations refresh. The sonner
// stub is only here because the polling guard below imports `../ws/events.ts`,
// which reaches for the real Toaster.
const QUERY_STUB = "stub:svelte-query";
const CLIENT_STUB = "stub:api-client";
const TOAST_STUB = "stub:svelte-sonner";

const queryStubSource = `
/** Every key handed to invalidateQueries, in call order; shared with the test. */
export const invalidations = [];

export function createQuery(options) {
  return options;
}
export function createMutation(options) {
  return options;
}
export function useQueryClient() {
  return {
    invalidateQueries(filters) {
      invalidations.push(filters.queryKey);
    },
  };
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

const toastStubSource = `
export const toast = {
  success: () => {},
  warning: () => {},
  error: () => {},
  info: () => {},
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tanstack/svelte-query") return { url: QUERY_STUB, shortCircuit: true };
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    if (specifier === "svelte-sonner") return { url: TOAST_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === QUERY_STUB) {
      return { format: "module", shortCircuit: true, source: queryStubSource };
    }
    if (url === CLIENT_STUB) {
      return { format: "module", shortCircuit: true, source: clientStubSource };
    }
    if (url === TOAST_STUB) {
      return { format: "module", shortCircuit: true, source: toastStubSource };
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

const queryModule: string = QUERY_STUB;
const { invalidations } = (await import(queryModule)) as { invalidations: unknown[][] };

const runnerModule: string = "./runner.ts";
const runner = (await import(runnerModule)) as typeof import("./runner");

const eventsModule: string = "../ws/events.ts";
const { DEFAULT_INVALIDATIONS } = (await import(eventsModule)) as typeof import("../ws/events");

const asQuery = (built: unknown): BuiltQuery => built as unknown as BuiltQuery;
const asMutation = (built: unknown): BuiltMutation => built as unknown as BuiltMutation;

interface MutationCase {
  /** The exported builder. */
  name: string;
  build: () => BuiltMutation;
  path: string;
}

const MUTATION_CASES: MutationCase[] = [
  {
    name: "createRunCodexRunnerMutation",
    build: () => asMutation(runner.createRunCodexRunnerMutation()),
    path: "/admin/runner/run",
  },
  {
    name: "createRunClaudeRunnerMutation",
    build: () => asMutation(runner.createRunClaudeRunnerMutation()),
    path: "/admin/runner/run-claude",
  },
];

beforeEach(() => {
  calls.length = 0;
  invalidations.length = 0;
});

describe("createRunnerStateQuery", () => {
  it("keys and reads /admin/runner", async () => {
    const built = asQuery(runner.createRunnerStateQuery());

    assert.deepEqual(built.queryKey, ["runner", "state"]);
    assert.deepEqual(built.queryKey, runner.runnerKeys.state());

    await built.queryFn();
    assert.deepEqual(calls, [{ method: "GET", path: "/admin/runner", body: undefined }]);
  });

  it("polls every 15 s", () => {
    assert.equal(asQuery(runner.createRunnerStateQuery()).refetchInterval, 15_000);
  });
});

describe("run mutations", () => {
  for (const mutationCase of MUTATION_CASES) {
    it(`${mutationCase.name} posts ${mutationCase.path}`, async () => {
      const built = mutationCase.build();
      await built.mutationFn(undefined);

      // The routes take no parameters, but the client still has to send a body
      // the API's JSON parser accepts.
      assert.deepEqual(calls, [{ method: "POST", path: mutationCase.path, body: {} }]);
      assert.equal(JSON.stringify(calls[0].body), "{}");
    });

    it(`${mutationCase.name} refreshes the state card`, () => {
      const built = mutationCase.build();
      built.onSuccess?.(null, undefined, undefined);

      assert.deepEqual(invalidations, [runner.runnerKeys.state()]);
    });
  }
});

describe("polling is the only refresh trigger", () => {
  it("has no runner WebSocket event to invalidate the state key", () => {
    // The card's 15 s poll (and the docstring saying so) only holds while the
    // backend publishes nothing under `runner.`; the day an event lands here it
    // should invalidate `runnerKeys.state()` instead of being ignored.
    assert.deepEqual(
      Object.keys(DEFAULT_INVALIDATIONS).filter((type) => type.startsWith("runner.")),
      [],
      "a runner.* WS event exists — wire it to runnerKeys.state() and drop the polling claim",
    );
  });
});
