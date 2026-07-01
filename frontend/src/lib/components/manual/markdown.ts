/**
 * Render manual markdown → sanitized HTML, returning the HTML plus a
 * lightweight table-of-contents extracted from the headings.
 */

import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

export interface RenderedArticle {
  html: string;
  toc: TocEntry[];
}

const COMBINING_MARKS = /[̀-ͯ]/g;

function slugify(text: string, used: Set<string>): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  let id = base || "section";
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n++}`;
  }
  used.add(id);
  return id;
}

export function renderMarkdown(source: string): RenderedArticle {
  const toc: TocEntry[] = [];
  const used = new Set<string>();

  const renderer = new Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const plain = tokens
      .map((t) =>
        "text" in t && typeof (t as { text?: unknown }).text === "string"
          ? ((t as { text: string }).text)
          : "",
      )
      .join("");
    const id = slugify(plain, used);
    if (depth >= 2 && depth <= 3) {
      toc.push({ id, text: plain, level: depth });
    }
    const safePlain = plain.replace(/"/g, "&quot;");
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to ${safePlain}"></a>${text}</h${depth}>\n`;
  };

  // Open external links in a new tab; internal links navigate in-app.
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const safe = href ?? "";
    const safeHref = safe.replace(/"/g, "&quot;");
    const titleAttr = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
    const external = /^https?:\/\//i.test(safe);
    const target = external ? ` target="_blank" rel="noopener noreferrer"` : "";
    return `<a href="${safeHref}"${titleAttr}${target}>${text}</a>`;
  };

  const rawHtml = marked.parse(source, {
    async: false,
    renderer,
    gfm: true,
    breaks: false,
  }) as string;

  const html = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ["target", "rel", "id"],
    USE_PROFILES: { html: true },
  });

  return { html, toc };
}
