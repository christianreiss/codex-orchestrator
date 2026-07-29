import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

import type { QueryClient } from "@tanstack/svelte-query";
import type { AuthEngine } from "./auth";

// `auth.ts` only ever touches the network through `./client`, and takes the
// invalidation handle from its caller. Stubbing `./client` and svelte-query
// (whose entry point re-exports `.svelte` files node cannot load) keeps both
// builders importable outside the browser and records what each one puts on
// the wire; the recording QueryClient below captures which keys it invalidates.
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
    // `auth.ts` imports `./hosts` the way the bundler resolves it, without the
    // extension node insists on.
    if (specifier.startsWith("./") && !specifier.endsWith(".ts")) {
      return nextResolve(`${specifier}.ts`, context);
    }
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

const authModule: string = "./auth.ts";
const auth = (await import(authModule)) as typeof import("./auth");

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

const asMutation = (built: unknown): BuiltMutation => built as unknown as BuiltMutation;

/** Both engines the operator dialogs can repair, driven through every builder. */
const ENGINES: AuthEngine[] = ["codex", "claude"];

/** A canonical Codex auth blob, as the upload dialog hands it over: raw text. */
const PAYLOAD = '{"tokens":{"access_token":"a.b.c"}}';

/** The body as the client would actually serialise it. */
const wire = (): string => JSON.stringify(calls.at(-1)?.body);

beforeEach(() => {
  calls.length = 0;
  invalidations.length = 0;
});

describe("createSeedCommandMutation", () => {
  for (const engine of ENGINES) {
    it(`posts /admin/auth/seed-command for ${engine}`, async () => {
      const built = asMutation(auth.createSeedCommandMutation());
      await built.mutationFn({ engine });

      assert.deepEqual(calls, [
        { method: "POST", path: "/admin/auth/seed-command", body: { engine } },
      ]);
      assert.equal(wire(), `{"engine":"${engine}"}`);
    });
  }

  it("refreshes nothing on success", () => {
    // Minting a one-liner changes no server state -- the credentials only land
    // once the operator runs it -- so the builder takes no QueryClient at all.
    assert.equal(asMutation(auth.createSeedCommandMutation()).onSuccess, undefined);
  });
});

describe("createUploadAuthMutation", () => {
  for (const engine of ENGINES) {
    it(`posts /admin/auth/upload for ${engine}`, async () => {
      const built = asMutation(auth.createUploadAuthMutation(queryClient));
      await built.mutationFn({ engine, payload: PAYLOAD });

      assert.deepEqual(calls, [
        { method: "POST", path: "/admin/auth/upload", body: { engine, payload: PAYLOAD } },
      ]);
    });
  }

  it("forwards the payload as the opaque string it was given", async () => {
    const built = asMutation(auth.createUploadAuthMutation(queryClient));
    await built.mutationFn({ engine: "codex", payload: PAYLOAD });

    // The canonical auth blob rides up as text; re-parsing it here would let a
    // backend that expects a string silently receive an object.
    assert.equal(wire(), JSON.stringify({ engine: "codex", payload: PAYLOAD }));
  });

  it("invalidates exactly hostsKeys.all() on success", () => {
    const built = asMutation(auth.createUploadAuthMutation(queryClient));
    built.onSuccess?.(null, { engine: "codex", payload: PAYLOAD }, undefined);

    // A repair can heal any host in the fleet, so the whole `hosts` tree is
    // refreshed -- and nothing else; the key has to stay the one the host list
    // registers or the drift banner keeps showing the pre-upload state.
    assert.deepEqual(invalidations, [hostsKeys.all()]);
    assert.deepEqual(invalidations, [["hosts"]]);
  });
});

describe("module surface", () => {
  /** Every runtime export, so a new builder cannot slip past the cases above. */
  const EXPECTED_EXPORTS = ["createSeedCommandMutation", "createUploadAuthMutation"];

  it("exports exactly the documented surface", () => {
    assert.deepEqual(Object.keys(auth).sort(), EXPECTED_EXPORTS);
  });
});
