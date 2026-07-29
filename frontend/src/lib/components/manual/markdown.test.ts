import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

// DOMPurify needs a DOM, so its default export has no `sanitize` under
// `node --test`; a pass-through stub keeps the renderer's own output — the
// heading ids, TOC and link attributes pinned below — visible unchanged.
const PURIFY_STUB = "stub:dompurify";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "dompurify") return { url: PURIFY_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === PURIFY_STUB) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default { sanitize: (html) => html };",
      };
    }
    return nextLoad(url, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// import needs the ".ts" extension that TypeScript rejects on a static import;
// hiding it behind a variable keeps both happy. Types come from the cast.
const markdownModule: string = "./markdown.ts";
const { renderMarkdown } = (await import(markdownModule)) as typeof import("./markdown");

/** The `id="…"` of every heading in the rendered HTML, in document order. */
function headingIds(html: string): string[] {
  return [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]);
}

describe("renderMarkdown heading ids", () => {
  it("slugifies a plain title", () => {
    const { html } = renderMarkdown("## Request routing\n");
    assert.deepEqual(headingIds(html), ["request-routing"]);
  });

  it("strips punctuation and accents", () => {
    // `&` reaches the renderer as marked's escaped `&amp;`, and slugify keeps
    // the surviving letters of the entity — hence the "amp" segment.
    const { html } = renderMarkdown("## Créer un rôle: quotas & limits!\n");
    assert.deepEqual(headingIds(html), ["creer-un-role-quotas-amp-limits"]);
  });

  it("falls back to 'section' for a title slugify empties", () => {
    assert.deepEqual(headingIds(renderMarkdown("## !!!\n").html), ["section"]);
    assert.deepEqual(headingIds(renderMarkdown("## ***\n").html), ["section"]);
  });

  it("suffixes repeated titles so every id stays unique", () => {
    const { html } = renderMarkdown("## Setup\n\n## Setup\n\n### Setup\n");
    assert.deepEqual(headingIds(html), ["setup", "setup-2", "setup-3"]);
  });

  it("suffixes the empty base, not the fallback, on a repeated empty title", () => {
    // Quirk worth knowing about: de-duplication appends to `base`, which is ""
    // here, so the second symbol-only heading is `-2` rather than `section-2`.
    // Still unique — but `#-2` is not a valid CSS selector.
    const { html } = renderMarkdown("## !!!\n\n## ???\n");
    assert.deepEqual(headingIds(html), ["section", "-2"]);
  });
});

describe("renderMarkdown toc", () => {
  it("keeps only depth 2 and 3, in document order", () => {
    const { toc } = renderMarkdown("# One\n\n## Two\n\n### Three\n\n#### Four\n\n## Five\n");
    assert.deepEqual(toc, [
      { id: "two", text: "Two", level: 2 },
      { id: "three", text: "Three", level: 3 },
      { id: "five", text: "Five", level: 2 },
    ]);
  });

  it("is empty for an article with no h2/h3", () => {
    assert.deepEqual(renderMarkdown("# Title\n\nBody text.\n").toc, []);
  });

  it("carries the same id the heading element got", () => {
    const { html, toc } = renderMarkdown("## Setup\n\n## Setup\n");
    assert.deepEqual(
      toc.map((entry) => entry.id),
      headingIds(html),
    );
  });

  it("reports the plain text of a heading with inline markup", () => {
    const { toc } = renderMarkdown("## Hello **World**\n");
    assert.deepEqual(toc, [{ id: "hello-world", text: "Hello World", level: 2 }]);
  });
});

describe("renderMarkdown heading anchors", () => {
  it("emits an anchor whose href points at the heading id", () => {
    const { html } = renderMarkdown("## Request routing\n");
    assert.match(
      html,
      /<h2 id="request-routing"><a class="anchor" href="#request-routing" aria-label="Link to Request routing"><\/a>Request routing<\/h2>/,
    );
  });

  it("escapes double quotes out of the aria-label", () => {
    // A link token hands the renderer raw quotes (unlike a text token, which
    // marked has already escaped), so this is the case the escape must cover.
    const { html, toc } = renderMarkdown('## See [the "docs"](https://x.io)\n');
    assert.ok(html.includes('aria-label="Link to See the &quot;docs&quot;"'));
    assert.ok(!html.includes('aria-label="Link to See the "'));
    assert.equal(toc[0].text, 'See the "docs"');
  });

  it("keeps the anchor href in step with a de-duplicated id", () => {
    const { html } = renderMarkdown("## Setup\n\n## Setup\n");
    assert.ok(html.includes('<a class="anchor" href="#setup" '));
    assert.ok(html.includes('<a class="anchor" href="#setup-2" '));
  });
});

describe("renderMarkdown links", () => {
  it("opens an absolute http(s) link in a new tab", () => {
    assert.ok(
      renderMarkdown("[a](https://example.com)\n").html.includes(
        '<a href="https://example.com" target="_blank" rel="noopener noreferrer">a</a>',
      ),
    );
    // The scheme test is case-insensitive.
    assert.ok(
      renderMarkdown("[a](HTTP://example.com)\n").html.includes(
        'target="_blank" rel="noopener noreferrer"',
      ),
    );
  });

  it("leaves an in-app link to navigate in place", () => {
    for (const href of ["/manual/routing", "./sibling", "#anchor", "mailto:ops@example.com"]) {
      const { html } = renderMarkdown(`[a](${href})\n`);
      assert.ok(html.includes(`<a href="${href}">a</a>`), href);
      assert.ok(!html.includes("target="), href);
      assert.ok(!html.includes("rel="), href);
    }
  });

  it("escapes a double quote in the link title", () => {
    const { html } = renderMarkdown("[t](/manual/x 'He said \"hi\"')\n");
    assert.ok(html.includes('<a href="/manual/x" title="He said &quot;hi&quot;">t</a>'));
  });

  it("escapes a double quote in the href", () => {
    assert.ok(renderMarkdown('[q](/a"b)\n').html.includes('<a href="/a&quot;b">q</a>'));
  });

  it("omits the title attribute when the link has none", () => {
    assert.ok(!renderMarkdown("[a](/manual/x)\n").html.includes("title="));
  });
});
