import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

import type { ClaudeArtifactApi } from "./claudeArtifacts";

// `commands.ts`, `outputStyles.ts` and `subagents.ts` hold nothing but the kind
// slug they hand to `createClaudeArtifactApi`/`createArtifactKeys`, and that
// factory reaches the network only through `./client`. Stubbing the client
// keeps the three modules importable outside the browser and records the path
// each slug produces.
const CLIENT_STUB = "stub:api-client";

const clientStubSource = `
/** Every request the collection clients issued, in call order. */
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    // The collection modules import `./claudeArtifacts` the way the bundler
    // resolves it, without the extension node insists on.
    if (specifier.startsWith("./") && !specifier.endsWith(".ts")) {
      return nextResolve(`${specifier}.ts`, context);
    }
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
  method: string;
  path: string;
  body: unknown;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const commandsModule: string = "./commands.ts";
const { commandsApi, commandsKeys } = (await import(
  commandsModule
)) as typeof import("./commands");

const outputStylesModule: string = "./outputStyles.ts";
const { outputStylesApi, outputStylesKeys } = (await import(
  outputStylesModule
)) as typeof import("./outputStyles");

const subagentsModule: string = "./subagents.ts";
const { subagentsApi, subagentsKeys } = (await import(
  subagentsModule
)) as typeof import("./subagents");

interface KindCase {
  /** The collection module, named as the exports are prefixed. */
  name: string;
  /** The literal that becomes the `:kind` path segment and the key root. */
  slug: string;
  api: ClaudeArtifactApi;
  keys: { all: readonly string[] };
}

const KIND_CASES: KindCase[] = [
  { name: "commands", slug: "commands", api: commandsApi, keys: commandsKeys },
  {
    name: "outputStyles",
    // Hyphenated on the wire, camel-cased in the module name.
    slug: "output-styles",
    api: outputStylesApi,
    keys: outputStylesKeys,
  },
  { name: "subagents", slug: "subagents", api: subagentsApi, keys: subagentsKeys },
];

beforeEach(() => {
  calls.length = 0;
});

describe("claude artifact collection clients", () => {
  for (const kindCase of KIND_CASES) {
    it(`${kindCase.name}Api reads /admin/claude/${kindCase.slug}`, async () => {
      await kindCase.api.list();
      assert.deepEqual(calls, [
        { method: "GET", path: `/admin/claude/${kindCase.slug}`, body: undefined },
      ]);
    });

    it(`${kindCase.name}Keys roots at the same ${kindCase.slug} slug`, () => {
      assert.deepEqual(kindCase.keys.all, [kindCase.slug]);
    });
  }

  it("gives each collection its own slug", () => {
    const slugs = KIND_CASES.map((kindCase) => kindCase.keys.all[0]);
    assert.equal(
      new Set(slugs).size,
      KIND_CASES.length,
      "a module copied from its neighbour without editing the kind would collide here",
    );
  });
});
