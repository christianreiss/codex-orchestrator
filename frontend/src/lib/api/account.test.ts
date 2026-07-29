import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

import type { Passkey } from "./types";

// `account.ts` only ever touches the network through `./client`. Stubbing it
// keeps the module importable outside the browser, records what each helper
// puts on the wire and lets a case decide what the client resolves with.
// `../ws/events.ts` comes along for the query-key check and reaches for the
// real sonner toaster, which needs a browser, so that import is stubbed too.
const CLIENT_STUB = "stub:api-client";
const TOAST_STUB = "stub:svelte-sonner";

const clientStubSource = `
/** Every request the helpers issued, in call order; shared with the test. */
export const calls = [];

/** The body every stubbed request resolves with; the tests set it per case. */
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
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    if (specifier === "svelte-sonner") return { url: TOAST_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
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
  method: "GET" | "POST" | "DELETE";
  path: string;
  body: unknown;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls, response } = (await import(clientModule)) as {
  calls: RecordedCall[];
  response: { body: unknown };
};

const accountModule: string = "./account.ts";
const account = (await import(accountModule)) as typeof import("./account");

const eventsModule: string = "../ws/events.ts";
const { DEFAULT_INVALIDATIONS } = (await import(eventsModule)) as typeof import("../ws/events");

/** An id carrying each character class the path segment has to escape. */
const AWKWARD_ID = "a/b c";
const AWKWARD_ENCODED = "a%2Fb%20c";

/** The numeric id the id-bearing paths are exercised with. */
const ID = 7;

const PASSKEY: Passkey = { id: ID, name: "yubikey" };

interface HelperCase {
  /** The exported helper, as the surface test matches it. */
  name: string;
  label?: string;
  call: () => Promise<unknown>;
  method: RecordedCall["method"];
  path: string;
  body: unknown;
}

const HELPER_CASES: HelperCase[] = [
  {
    name: "getTheme",
    call: () => account.getTheme(),
    method: "GET",
    path: "/admin/theme",
    body: undefined,
  },
  {
    name: "setTheme",
    label: "setTheme('dark-pink')",
    call: () => account.setTheme("dark-pink"),
    method: "POST",
    path: "/admin/theme",
    body: { theme: "dark-pink" },
  },
  {
    name: "changePassword",
    call: () =>
      account.changePassword({
        current_password: "old",
        new_password: "new",
        confirm_password: "new",
      }),
    method: "POST",
    path: "/admin/auth/password/change",
    body: { current_password: "old", new_password: "new", confirm_password: "new" },
  },
  {
    name: "requestPasswordReset",
    call: () => account.requestPasswordReset({ username: "admin" }),
    method: "POST",
    path: "/admin/auth/password/request",
    body: { username: "admin" },
  },
  {
    name: "resetPassword",
    call: () =>
      account.resetPassword({ token: "t-1", new_password: "new", confirm_password: "new" }),
    method: "POST",
    path: "/admin/auth/password/reset",
    body: { token: "t-1", new_password: "new", confirm_password: "new" },
  },
  {
    name: "listPasskeys",
    call: () => account.listPasskeys(),
    method: "GET",
    // The list hangs off `/admin/passkeys`, not the `/admin/auth/passkey/*`
    // prefix the registration flow uses.
    path: "/admin/passkeys",
    body: undefined,
  },
  {
    name: "passkeyRegisterOptions",
    call: () => account.passkeyRegisterOptions(),
    method: "POST",
    path: "/admin/auth/passkey/register/options",
    // The challenge request carries no payload at all, not even an empty object.
    body: undefined,
  },
  {
    name: "passkeyRegister",
    call: () => account.passkeyRegister({ response: { id: "cred-1" } }),
    method: "POST",
    path: "/admin/auth/passkey/register",
    body: { response: { id: "cred-1" } },
  },
  {
    name: "renamePasskey",
    call: () => account.renamePasskey(ID, "yubikey"),
    method: "POST",
    path: `/admin/passkeys/${ID}/name`,
    body: { name: "yubikey" },
  },
  {
    name: "deletePasskey",
    call: () => account.deletePasskey(ID),
    method: "DELETE",
    path: `/admin/passkeys/${ID}`,
    body: undefined,
  },
];

beforeEach(() => {
  calls.length = 0;
  response.body = { passkeys: [PASSKEY] };
});

describe("request helpers", () => {
  for (const helperCase of HELPER_CASES) {
    const label = helperCase.label ?? helperCase.name;

    it(`${label} issues ${helperCase.method} ${helperCase.path}`, async () => {
      await helperCase.call();
      assert.deepEqual(calls, [
        { method: helperCase.method, path: helperCase.path, body: helperCase.body },
      ]);
    });
  }
});

describe("passkey id encoding", () => {
  it("leaves a numeric id as its plain decimal segment", async () => {
    await account.renamePasskey(ID, "yubikey");
    await account.deletePasskey(ID);
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/admin/passkeys/7/name", "/admin/passkeys/7"],
    );
  });

  it("percent-encodes an id carrying a slash and a space", async () => {
    await account.renamePasskey(AWKWARD_ID, "yubikey");
    await account.deletePasskey(AWKWARD_ID);

    for (const { path } of calls) {
      // ["", "admin", "passkeys", "<id>", ...] -- an unescaped "/" in the id
      // would split into an extra segment and shift everything after it.
      const segments = path.split("/");
      assert.equal(segments[3], AWKWARD_ENCODED);
      assert.equal(decodeURIComponent(segments[3]), AWKWARD_ID);
      assert.ok(!path.includes(" "), "the space must be escaped");
    }

    assert.deepEqual(
      calls.map((call) => call.path),
      [`/admin/passkeys/${AWKWARD_ENCODED}/name`, `/admin/passkeys/${AWKWARD_ENCODED}`],
    );
  });
});

describe("listPasskeys envelope", () => {
  it("passes the array through unchanged", async () => {
    const passkeys = [PASSKEY, { id: 8, name: "phone" }];
    response.body = { passkeys };
    assert.deepEqual(await account.listPasskeys(), passkeys);
  });

  it("answers with an empty list when the body carries no passkeys key", async () => {
    response.body = {};
    assert.deepEqual(await account.listPasskeys(), []);
  });

  it("answers with an empty list when the key is there but null", async () => {
    response.body = { passkeys: null };
    assert.deepEqual(await account.listPasskeys(), []);
  });
});

describe("accountKeys", () => {
  it("keys the theme under the settings prefix", () => {
    assert.deepEqual(account.accountKeys.theme, ["settings", "theme"]);
  });

  for (const event of ["passkey.registered", "passkey.deleted"] as const) {
    it(`carries the key ${event} invalidates`, () => {
      // The module docstring promises these match; a rename on either side
      // would otherwise leave the list stale after a registration.
      assert.deepEqual(DEFAULT_INVALIDATIONS[event], [account.accountKeys.passkeys]);
    });
  }
});

describe("module surface", () => {
  /** Every runtime export, so a new helper cannot slip past the table above. */
  const EXPECTED_EXPORTS = [
    "accountKeys",
    "changePassword",
    "deletePasskey",
    "getTheme",
    "listPasskeys",
    "passkeyRegister",
    "passkeyRegisterOptions",
    "renamePasskey",
    "requestPasswordReset",
    "resetPassword",
    "setTheme",
  ];

  it("exports exactly the documented surface", () => {
    assert.deepEqual(Object.keys(account).sort(), EXPECTED_EXPORTS);
  });

  it("drives every exported helper", () => {
    const driven = new Set(HELPER_CASES.map((helperCase) => helperCase.name));
    const exported = Object.entries(account)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);

    assert.deepEqual(
      exported.filter((name) => !driven.has(name)),
      [],
      "every helper needs a case in HELPER_CASES",
    );
    assert.deepEqual(
      [...driven].filter((name) => !exported.includes(name)),
      [],
      "every case must name a helper the module still exports",
    );
  });
});
