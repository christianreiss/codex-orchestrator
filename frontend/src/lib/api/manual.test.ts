import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, describe, it } from "node:test";

import type { ManualManifest } from "./types";

// `manual.ts` reaches the network through `./client`, whose extensionless
// specifier `node --test` cannot resolve on its own. Pointing it at the real
// file keeps the envelope handling in play — what the responses come from is a
// stubbed global `fetch`, not a stubbed client.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./client") return nextResolve("./client.ts", context);
    return nextResolve(specifier, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const manualModule: string = "./manual.ts";
const { fetchArticle, fetchManifest } = (await import(
  manualModule
)) as typeof import("./manual");

const realFetch = globalThis.fetch;

/** Every URL `fetch` was asked for, in call order. */
const urls: string[] = [];

/** Answer every request in the current test with `body` as JSON. */
function stubFetch(body: unknown): void {
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * The envelope `standard.success` puts on the wire: the payload under `data`
 * and, for the still-installed bash wrappers, spread across the root as well.
 */
function enveloped<T extends object>(payload: T): unknown {
  return { status: "ok", data: payload, ...payload };
}

const MANIFEST: ManualManifest = {
  version: "2026-07-29",
  articles: [
    { slug: "runner-ops", title: "Runner ops", section: "ops", summary: "how runners boot" },
  ],
};

const ARTICLE = {
  slug: "runner-ops",
  meta: { title: "Runner ops", category: "ops" },
  body: "<h1>Runner ops</h1>",
};

/** A slug carrying each character class the path segment has to escape. */
const AWKWARD_SLUG = "runner ops/boot";
const AWKWARD_ENCODED = "runner%20ops%2Fboot";

afterEach(() => {
  globalThis.fetch = realFetch;
  urls.length = 0;
});

describe("fetchManifest", () => {
  it("asks for the manifest endpoint", async () => {
    stubFetch(enveloped(MANIFEST));
    await fetchManifest();
    assert.deepEqual(urls, ["/admin/manual/manifest"]);
  });

  it("unwraps the standard envelope into the manifest", async () => {
    stubFetch(enveloped(MANIFEST));
    const manifest = await fetchManifest();

    assert.deepEqual(manifest, MANIFEST);
    // The root-level `status` would still be there had the fetcher opted out
    // of unwrapping and leaned on the duplicated keys instead.
    assert.equal("status" in manifest, false);
  });
});

describe("fetchArticle", () => {
  it("asks for the article endpoint of the requested slug", async () => {
    stubFetch(enveloped(ARTICLE));
    await fetchArticle("runner-ops");
    assert.deepEqual(urls, ["/admin/manual/article/runner-ops"]);
  });

  it("percent-encodes a slug carrying a slash and a space", async () => {
    stubFetch(enveloped(ARTICLE));
    await fetchArticle(AWKWARD_SLUG);

    // ["", "admin", "manual", "article", "<slug>"] -- an unescaped "/" in the
    // slug would split into an extra segment and reach a different route.
    const segments = urls[0].split("/");
    assert.equal(segments[4], AWKWARD_ENCODED);
    assert.equal(decodeURIComponent(segments[4]), AWKWARD_SLUG);
    assert.ok(!urls[0].includes(" "), "the space must be escaped");
    assert.deepEqual(urls, [`/admin/manual/article/${AWKWARD_ENCODED}`]);
  });

  it("unwraps the standard envelope into the article", async () => {
    stubFetch(enveloped(ARTICLE));
    const article = await fetchArticle("runner-ops");

    assert.deepEqual(article, ARTICLE);
    assert.equal("status" in article, false);
  });
});
