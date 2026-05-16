import type { ArticleBody, ManualStore } from './manual-articles.js';

/**
 * Naive in-process search across the manual articles.
 *
 * Algorithm: lowercase substring match on title (weight 10), category (weight
 * 3), and body (weight 1). Title matches always win. Returns at most 20 hits;
 * each hit ships a short snippet of body context around the first match.
 */

export interface SearchHit {
  slug: string;
  title: string;
  category: string;
  score: number;
  snippet: string;
}

const MAX_RESULTS = 20;
const SNIPPET_RADIUS = 80;

export function searchManual(store: ManualStore, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const articles = store.list();
  const hits: SearchHit[] = [];
  for (const article of articles) {
    const score = scoreArticle(article, q);
    if (score === 0) continue;
    hits.push({
      slug: article.slug,
      title: article.meta.title,
      category: article.meta.category,
      score,
      snippet: snippetFor(article.body, q),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, MAX_RESULTS);
}

function scoreArticle(article: ArticleBody, q: string): number {
  let score = 0;
  const title = article.meta.title.toLowerCase();
  const category = article.meta.category.toLowerCase();
  const body = article.body.toLowerCase();
  if (title === q) score += 100;
  else if (title.includes(q)) score += 10;
  if (category.includes(q)) score += 3;
  let bodyMatches = 0;
  let from = 0;
  while (from < body.length) {
    const idx = body.indexOf(q, from);
    if (idx === -1) break;
    bodyMatches += 1;
    from = idx + q.length;
    if (bodyMatches > 10) break;
  }
  score += bodyMatches;
  return score;
}

function snippetFor(body: string, q: string): string {
  if (!body) return '';
  const idx = body.toLowerCase().indexOf(q);
  if (idx === -1) {
    // Fall back to leading slice
    return body.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, ' ').trim();
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(body.length, idx + q.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}
