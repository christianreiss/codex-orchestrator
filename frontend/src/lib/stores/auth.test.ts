import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { get } from "svelte/store";

// `auth.ts` imports the SvelteKit virtual module `$app/environment` and the
// real API client, neither of which node can resolve on its own; answering
// both with stubs keeps `browser` false (so the module-scope hydration never
// fires) and lets each test decide what `/admin/auth/status` returns.
const ENV_STUB = "stub:app-environment";
const CLIENT_STUB = "stub:api-client";

const clientStubSource = `
export class ApiError extends Error {
  constructor(opts) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
  }
}
/** Swapped per test; the store and the test share this module instance. */
export const stub = { get: async () => ({}) };
export const api = { get: (path) => stub.get(path) };
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "$app/environment") return { url: ENV_STUB, shortCircuit: true };
    if (specifier === "../api/client") return { url: CLIENT_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === ENV_STUB) {
      return { format: "module", shortCircuit: true, source: "export const browser = false;" };
    }
    if (url === CLIENT_STUB) {
      return { format: "module", shortCircuit: true, source: clientStubSource };
    }
    return nextLoad(url, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { ApiError, stub } = (await import(clientModule)) as {
  ApiError: new (opts: { status: number; message: string }) => Error;
  stub: { get: (path: string) => Promise<unknown> };
};

const authModule: string = "./auth.ts";
const { authActions, authStore } = (await import(authModule)) as typeof import("./auth");

describe("refresh", () => {
  it("maps a 401 to an enforced, unauthenticated state", async () => {
    stub.get = async () => {
      throw new ApiError({ status: 401, message: "unauthorized" });
    };
    const state = await authActions.refresh();
    assert.deepEqual(state, {
      authenticated: false,
      enforced: true,
      user: null,
      roles: [],
      loading: false,
      unreachable: null,
    });
    assert.deepEqual(get(authStore), state);
  });

  it("maps a 403 the same way", async () => {
    stub.get = async () => {
      throw new ApiError({ status: 403, message: "forbidden" });
    };
    const state = await authActions.refresh();
    assert.deepEqual(state, {
      authenticated: false,
      enforced: true,
      user: null,
      roles: [],
      loading: false,
      unreachable: null,
    });
  });

  it("rethrows any other failure but clears the loading flag", async () => {
    stub.get = async () => {
      throw new ApiError({ status: 500, message: "boom" });
    };
    await assert.rejects(authActions.refresh(), /boom/);
    assert.equal(get(authStore).loading, false);
    assert.equal(get(authStore).unreachable, "boom");
  });

  it("prefers the roles the status payload carries itself", async () => {
    stub.get = async () => ({
      authenticated: true,
      enforced: true,
      user: { id: 1, username: "root", role: "user" },
      roles: ["admin"],
    });
    const state = await authActions.refresh();
    assert.deepEqual(state.roles, ["admin"]);
    assert.equal(state.authenticated, true);
    assert.equal(state.loading, false);
  });

  it("falls back to user.roles when the payload omits them", async () => {
    stub.get = async () => ({
      authenticated: true,
      enforced: true,
      user: { id: 1, username: "root", roles: ["fleet_operator", "user"] },
    });
    const state = await authActions.refresh();
    assert.deepEqual(state.roles, ["fleet_operator", "user"]);
  });

  it("falls back to the singular user.role", async () => {
    stub.get = async () => ({
      authenticated: true,
      enforced: true,
      user: { id: 1, username: "root", role: "admin" },
    });
    const state = await authActions.refresh();
    assert.deepEqual(state.roles, ["admin"]);
  });

  it("has no roles when the payload has no user", async () => {
    stub.get = async () => ({ authenticated: false, enforced: false, user: null });
    const state = await authActions.refresh();
    assert.deepEqual(state.roles, []);
    assert.equal(state.user, null);
  });
});
