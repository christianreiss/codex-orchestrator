import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

import type { ArtifactStorePayload } from "./types";

// `claudeArtifacts.ts` builds every path from the `kind` it was handed and then
// defers to the real API client. Stubbing `./client` keeps the module importable
// outside the browser and records what each call would have put on the wire.
// `events.ts` reaches for the real sonner Toaster, which needs a browser, so its
// toast import is answered with an inert stub.
const CLIENT_STUB = "stub:api-client";
const TOAST_STUB = "stub:svelte-sonner";

const clientStubSource = `
/** Every request the factory issued, in call order; shared with the test. */
export const calls = [];

const record = (method, path, body) => {
  calls.push({ method, path, body });
  return Promise.resolve(null);
};

export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
  delete: (path) => record("DELETE", path, undefined),
};
`;

const toastStubSource = `
const noop = () => {};
export const toast = { success: noop, warning: noop, error: noop, info: noop };
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
  method: string;
  path: string;
  body: unknown;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const artifactsModule: string = "./claudeArtifacts.ts";
const { createClaudeArtifactApi, createArtifactKeys } = (await import(
  artifactsModule
)) as typeof import("./claudeArtifacts");

const eventsModule: string = "../ws/events.ts";
const { DEFAULT_INVALIDATIONS } = (await import(eventsModule)) as typeof import("../ws/events");

function lastCall(): RecordedCall {
  const call = calls.at(-1);
  assert.ok(call, "expected a request to have been issued");
  return call;
}

/** The three kinds the API serves under /admin/claude. */
const KINDS = ["subagents", "commands", "output-styles"];

// A slug the server would accept but that must never reach the path raw: the
// slash would forge a path segment, the space would break the request line and
// the non-ASCII character is not URL-safe at all.
const HOSTILE_SLUG = "deep/dir name-ü";
const HOSTILE_ENCODED = "deep%2Fdir%20name-%C3%BC";

describe("createClaudeArtifactApi request shaping", () => {
  for (const kind of KINDS) {
    const base = `/admin/claude/${kind}`;

    describe(kind, () => {
      const artifacts = createClaudeArtifactApi(kind);

      it("lists from the collection root", async () => {
        await artifacts.list();
        assert.deepEqual(lastCall(), { method: "GET", path: base, body: undefined });
      });

      it("reads one artifact by slug", async () => {
        await artifacts.get("planner");
        assert.deepEqual(lastCall(), {
          method: "GET",
          path: `${base}/planner`,
          body: undefined,
        });
      });

      it("deletes one artifact by slug", async () => {
        await artifacts.delete("planner");
        assert.deepEqual(lastCall(), {
          method: "DELETE",
          path: `${base}/planner`,
          body: undefined,
        });
      });

      it("percent-encodes a slug carrying a slash, a space or a non-ASCII character", async () => {
        await artifacts.get(HOSTILE_SLUG);
        assert.equal(lastCall().path, `${base}/${HOSTILE_ENCODED}`);

        await artifacts.delete(HOSTILE_SLUG);
        assert.equal(lastCall().path, `${base}/${HOSTILE_ENCODED}`);
      });

      it("posts a store to the fixed /store path, never to the slug", async () => {
        const payload: ArtifactStorePayload = { slug: HOSTILE_SLUG, body: "text" };
        await artifacts.store(payload);

        const call = lastCall();
        assert.equal(call.method, "POST");
        assert.equal(call.path, `${base}/store`);
        assert.equal(call.body, payload, "the payload is forwarded verbatim");
        assert.ok(
          !call.path.includes(HOSTILE_SLUG) && !call.path.includes(HOSTILE_ENCODED),
          "the slug travels in the body, not the path",
        );
      });
    });
  }
});

describe("createArtifactKeys", () => {
  for (const kind of KINDS) {
    it(`roots every ${kind} key at the bare kind`, () => {
      const keys = createArtifactKeys(kind);
      assert.deepEqual(keys.all, [kind]);
      assert.deepEqual(keys.list(), [kind, "list"]);
      assert.deepEqual(keys.detail("planner"), [kind, "detail", "planner"]);
    });

    it(`keys the ${kind} detail on the raw, unencoded slug`, () => {
      assert.deepEqual(createArtifactKeys(kind).detail(HOSTILE_SLUG), [
        kind,
        "detail",
        HOSTILE_SLUG,
      ]);
    });
  }

  it("matches the roots the claude_artifact.* events invalidate", () => {
    const roots = KINDS.map((kind) => createArtifactKeys(kind).all);
    const events = Object.keys(DEFAULT_INVALIDATIONS).filter((type) =>
      type.startsWith("claude_artifact."),
    );

    assert.ok(events.length > 0, "expected claude_artifact.* entries in the invalidation map");
    for (const type of events) {
      assert.deepEqual(DEFAULT_INVALIDATIONS[type], roots, type);
    }
  });
});
