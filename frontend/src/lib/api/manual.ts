/**
 * API client for the admin online manual.
 *
 *   GET /admin/manual/manifest      → ManualManifest (raw JSON, no envelope)
 *   GET /admin/manual/search        → ManualSearchIndex (raw JSON, no envelope)
 *   GET /admin/manual/article/{slug} → raw markdown text
 */

import { apiFetch } from "./client";
import type { ManualManifest, ManualSearchIndex } from "./types";

export const manualEndpoints = {
  manifest: "/admin/manual/manifest",
  search: "/admin/manual/search",
  article: (slug: string) => `/admin/manual/article/${encodeURIComponent(slug)}`,
} as const;

/** Fetch the manifest (article list, titles, sections, tags). */
export function fetchManifest(): Promise<ManualManifest> {
  return apiFetch<ManualManifest>(manualEndpoints.manifest, { raw: true });
}

/** Fetch the search index (per-article anchors, summaries, optional bodies). */
export function fetchSearchIndex(): Promise<ManualSearchIndex> {
  return apiFetch<ManualSearchIndex>(manualEndpoints.search, { raw: true });
}

/** Fetch the raw markdown body for an article slug. */
export function fetchArticle(slug: string): Promise<string> {
  return apiFetch<string>(manualEndpoints.article(slug), { raw: true });
}

/**
 * Strip front-matter and return {meta, body}. The manual articles include
 * a YAML-ish header delimited by `---`; we surface the body for rendering
 * and provide a lightweight meta map so callers can show "verified" dates.
 */
export function splitFrontMatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body };
}
