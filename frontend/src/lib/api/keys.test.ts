import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

import type { AdminApiKey, ApiKeyEngine, CreateApiKeyPayload } from "./types";

// `keys.ts` only ever touches the network through `./client`, so stubbing that
// one specifier makes the whole engine-scoped surface importable outside the
// browser and records exactly what each member puts on the wire. The `PREFIX`
// table is the only thing standing between a Claude action and the OpenAI
// routes, and nothing but the recorded path can catch a swap.
const CLIENT_STUB = "stub:api-client";

const clientStubSource = `
/** Every request the members issued, in call order; shared with the test. */
export const calls = [];

const record = (method, path, body) => {
  calls.push({ method, path, body });
  return Promise.resolve(null);
};

export class ApiError extends Error {}

export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
  delete: (path) => record("DELETE", path, undefined),
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
  method: "GET" | "POST" | "DELETE";
  path: string;
  body: unknown;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const keysModule: string = "./keys.ts";
const { engineLabel, isActive, keyQueryKeys, keysApi } = (await import(
  keysModule
)) as typeof import("./keys");

interface EngineCase {
  engine: ApiKeyEngine;
  /** The route family the engine must land on, and only that one. */
  prefix: string;
  label: string;
}

const ENGINES: EngineCase[] = [
  { engine: "openai", prefix: "/admin/openai", label: "OpenAI" },
  { engine: "claude", prefix: "/admin/claude", label: "Claude" },
];

const CREATE_PAYLOAD: CreateApiKeyPayload = {
  name: "ci-runner",
  expires_at: null,
};

/** The key id the per-key routes interpolate. */
const KEY_ID = 42;

interface CallCase {
  /** The `keysApi` member, as the surface guard matches it. */
  name: keyof typeof keysApi;
  invoke: (engine: ApiKeyEngine) => Promise<unknown>;
  request: (prefix: string) => RecordedCall;
}

const CALL_CASES: CallCase[] = [
  {
    name: "list",
    invoke: (engine) => keysApi.list(engine),
    request: (prefix) => ({ method: "GET", path: `${prefix}/keys`, body: undefined }),
  },
  {
    name: "create",
    invoke: (engine) => keysApi.create(engine, CREATE_PAYLOAD),
    request: (prefix) => ({ method: "POST", path: `${prefix}/keys`, body: CREATE_PAYLOAD }),
  },
  {
    name: "toggle",
    invoke: (engine) => keysApi.toggle(engine, KEY_ID, true),
    request: (prefix) => ({
      method: "POST",
      path: `${prefix}/keys/${KEY_ID}/toggle`,
      body: { active: true },
    }),
  },
  {
    name: "remove",
    invoke: (engine) => keysApi.remove(engine, KEY_ID),
    request: (prefix) => ({
      method: "DELETE",
      path: `${prefix}/keys/${KEY_ID}`,
      body: undefined,
    }),
  },
  {
    name: "getState",
    invoke: (engine) => keysApi.getState(engine),
    request: (prefix) => ({ method: "GET", path: `${prefix}/state`, body: undefined }),
  },
  {
    name: "setState",
    invoke: (engine) => keysApi.setState(engine, true),
    request: (prefix) => ({ method: "POST", path: `${prefix}/state`, body: { disabled: true } }),
  },
];

beforeEach(() => {
  calls.length = 0;
});

describe("keysApi routing", () => {
  for (const { engine, prefix } of ENGINES) {
    for (const callCase of CALL_CASES) {
      const request = callCase.request(prefix);

      it(`${callCase.name}(${engine}) issues ${request.method} ${request.path}`, async () => {
        await callCase.invoke(engine);
        assert.deepEqual(calls, [request]);
      });
    }
  }
});

describe("engine isolation", () => {
  for (const { engine, prefix } of ENGINES) {
    const foreign = ENGINES.find((other) => other.engine !== engine)!;

    it(`keeps every ${engine} call off ${foreign.prefix}/`, async () => {
      for (const callCase of CALL_CASES) {
        await callCase.invoke(engine);
      }

      assert.equal(calls.length, CALL_CASES.length);
      for (const call of calls) {
        assert.ok(
          call.path.startsWith(`${prefix}/`),
          `${call.method} ${call.path} left the ${engine} route family`,
        );
        assert.ok(
          !call.path.includes(`${foreign.prefix}/`),
          `${call.method} ${call.path} reached the ${foreign.engine} routes`,
        );
      }
    });
  }

  it("drives every keysApi member", () => {
    const driven = new Set<string>(CALL_CASES.map((callCase) => callCase.name));
    assert.deepEqual(
      Object.keys(keysApi).filter((name) => !driven.has(name)),
      [],
      "every member needs a case in CALL_CASES",
    );
  });
});

describe("boolean bodies", () => {
  for (const { engine, prefix } of ENGINES) {
    it(`toggle(${engine}) carries the active flag either way`, async () => {
      await keysApi.toggle(engine, KEY_ID, true);
      await keysApi.toggle(engine, KEY_ID, false);

      assert.deepEqual(calls, [
        { method: "POST", path: `${prefix}/keys/${KEY_ID}/toggle`, body: { active: true } },
        { method: "POST", path: `${prefix}/keys/${KEY_ID}/toggle`, body: { active: false } },
      ]);
    });

    it(`setState(${engine}) carries the kill switch either way`, async () => {
      await keysApi.setState(engine, true);
      await keysApi.setState(engine, false);

      assert.deepEqual(calls, [
        { method: "POST", path: `${prefix}/state`, body: { disabled: true } },
        { method: "POST", path: `${prefix}/state`, body: { disabled: false } },
      ]);
    });
  }
});

describe("keyQueryKeys", () => {
  for (const { engine } of ENGINES) {
    it(`keys the ${engine} list and state entries`, () => {
      assert.deepEqual(keyQueryKeys.list(engine), ["keys", engine, "list"]);
      assert.deepEqual(keyQueryKeys.state(engine), ["keys", engine, "state"]);
    });
  }
});

describe("engineLabel", () => {
  for (const { engine, label } of ENGINES) {
    it(`labels ${engine} as ${label}`, () => {
      assert.equal(engineLabel(engine), label);
    });
  }
});

describe("isActive", () => {
  const RECORD: AdminApiKey = {
    id: KEY_ID,
    name: "ci-runner",
    key_prefix: "sk-orch-abc",
    is_active: true,
    use_count: 0,
  };

  /** A row as it arrives with whatever the backend put in the column. */
  const withActive = (value: unknown): AdminApiKey =>
    ({ ...RECORD, is_active: value }) as AdminApiKey;

  // The API emits a real boolean today, but older payloads served the tinyint
  // straight out of the column, so both shapes have to keep decoding.
  const CASES: { label: string; record: AdminApiKey; expected: boolean }[] = [
    { label: "the boolean true", record: withActive(true), expected: true },
    { label: "the boolean false", record: withActive(false), expected: false },
    { label: "the tinyint 1", record: withActive(1), expected: true },
    { label: "the tinyint 0", record: withActive(0), expected: false },
    { label: "an undefined column", record: withActive(undefined), expected: false },
  ];

  for (const { label, record, expected } of CASES) {
    it(`reads ${label} as ${expected}`, () => {
      assert.equal(isActive(record), expected);
    });
  }

  it("falls back to false when the column is missing entirely", () => {
    const { is_active, ...withoutColumn } = RECORD;
    assert.equal(is_active, true);
    assert.equal("is_active" in withoutColumn, false);
    assert.equal(isActive(withoutColumn as AdminApiKey), false);
  });
});
