/**
 * API client for the admin online manual.
 *
 *   GET /admin/manual/manifest      → ManualManifest
 *   GET /admin/manual/article/{slug} → {slug, meta, body}
 *
 * Both routes go through the standard `{status: "ok", data: {...}}` envelope,
 * which `apiFetch` unwraps into the payload above.
 *
 * The server also exposes `GET /admin/manual/search?q=…` for server-side
 * full-text hits, but the article-list filter on the client only needs a
 * substring match against manifest fields, so it works off the manifest
 * instead of making a second request.
 */

import { apiFetch } from "./client";
import type { ManualManifest } from "./types";

export const manualEndpoints = {
  manifest: "/admin/manual/manifest",
  article: (slug: string) => `/admin/manual/article/${encodeURIComponent(slug)}`,
} as const;

export interface ManualArticleResponse {
  slug: string;
  meta: Record<string, string>;
  body: string;
}

/** Fetch the manifest (article list, titles, sections, tags). */
export function fetchManifest(): Promise<ManualManifest> {
  return apiFetch<ManualManifest>(manualEndpoints.manifest);
}

/** Fetch the rendered article body and meta for a slug. */
export function fetchArticle(slug: string): Promise<ManualArticleResponse> {
  return apiFetch<ManualArticleResponse>(manualEndpoints.article(slug));
}
