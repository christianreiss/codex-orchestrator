import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ManualArticleSummary } from "$lib/api/types";

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const filterModule: string = "./filter.ts";
const { filterArticles } = (await import(filterModule)) as typeof import("./filter");

const routing: ManualArticleSummary = {
  slug: "routing",
  title: "Request routing",
  section: "Gateway",
  summary: "How the proxy picks an upstream provider.",
  tags: ["proxy", "upstream"],
};

const quotas: ManualArticleSummary = {
  slug: "quotas",
  title: "Quota windows",
  section: "Billing",
  summary: "Rolling five-hour and weekly budgets.",
  tags: ["limits"],
};

/** No `tags` key at all, the shape the manifest emits for untagged articles. */
const untagged: ManualArticleSummary = {
  slug: "changelog",
  title: "Changelog",
  section: "Reference",
  summary: "Release notes per version.",
};

const articles = [routing, quotas, untagged];

describe("filterArticles", () => {
  it("returns the input array for an empty query", () => {
    assert.equal(filterArticles(articles, ""), articles);
  });

  it("returns the input array for a whitespace-only query", () => {
    assert.equal(filterArticles(articles, "  \t "), articles);
  });

  it("requires every token to match, across all searched fields", () => {
    // title + section, title + summary, title + tag.
    assert.deepEqual(filterArticles(articles, "routing gateway"), [routing]);
    assert.deepEqual(filterArticles(articles, "quota weekly"), [quotas]);
    assert.deepEqual(filterArticles(articles, "routing upstream"), [routing]);
  });

  it("matches on section, summary and tags without the title", () => {
    assert.deepEqual(filterArticles(articles, "billing"), [quotas]);
    assert.deepEqual(filterArticles(articles, "release notes"), [untagged]);
    assert.deepEqual(filterArticles(articles, "proxy"), [routing]);
  });

  it("ignores case in both the query and the article", () => {
    assert.deepEqual(filterArticles(articles, "QUOTA BILLING"), [quotas]);
    assert.deepEqual(filterArticles(articles, "gAtEwAy"), [routing]);
  });

  it("drops every article when one token matches nothing", () => {
    assert.deepEqual(filterArticles(articles, "routing webhooks"), []);
    assert.deepEqual(filterArticles(articles, "webhooks"), []);
  });

  it("handles articles without tags", () => {
    assert.deepEqual(filterArticles([untagged], "changelog"), [untagged]);
    assert.deepEqual(filterArticles([untagged], "limits"), []);
  });

  it("does not match a token spanning two fields", () => {
    // "Changelog" + "Reference" are adjacent in the haystack but not one word.
    assert.deepEqual(filterArticles(articles, "changelog reference"), [untagged]);
    assert.deepEqual(filterArticles(articles, "changelogreference"), []);
  });
});
