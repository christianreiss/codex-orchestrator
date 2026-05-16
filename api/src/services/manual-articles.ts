import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Walks `<STATIC_ROOT>/manual/articles/` and builds the manifest in memory.
 *
 * Each article is a `.md` file whose basename is the slug. Optional YAML
 * frontmatter (delimited by `---` lines) supplies `title:` and `category:`;
 * any other keys are exposed verbatim under `meta`. The manifest is cached
 * and invalidated when the articles directory's mtime advances.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ArticleMeta {
  slug: string;
  title: string;
  category: string;
  section?: string;
  summary?: string;
  tags?: string[];
  verified?: string;
  [key: string]: unknown;
}

export interface Manifest {
  version: string;
  articles: ArticleMeta[];
}

export interface ArticleBody {
  slug: string;
  meta: ArticleMeta;
  body: string; // markdown without frontmatter
  raw: string; // full file contents including frontmatter
}

export class ManualStore {
  private cache: { dirMtimeMs: number; manifest: Manifest; articles: Map<string, ArticleBody> } | null = null;

  constructor(private readonly root: string) {}

  /** The articles directory we look in. */
  private articlesDir(): string {
    return resolve(this.root, 'manual', 'articles');
  }

  manifest(): Manifest {
    return this.refreshIfStale().manifest;
  }

  article(slug: string): ArticleBody | null {
    if (!SLUG_RE.test(slug)) return null;
    const { articles } = this.refreshIfStale();
    return articles.get(slug) ?? null;
  }

  list(): ArticleBody[] {
    const { articles } = this.refreshIfStale();
    return Array.from(articles.values());
  }

  /** Force a reload on the next read. Exposed for tests. */
  invalidate(): void {
    this.cache = null;
  }

  private refreshIfStale(): NonNullable<ManualStore['cache']> {
    const dir = this.articlesDir();
    if (!existsSync(dir)) {
      const empty = { dirMtimeMs: 0, manifest: { version: '0', articles: [] }, articles: new Map() };
      this.cache = empty;
      return empty;
    }
    const mtimeMs = safeMtime(dir);
    if (this.cache && this.cache.dirMtimeMs === mtimeMs) return this.cache;

    const articles = new Map<string, ArticleBody>();
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      files = [];
    }
    for (const filename of files) {
      if (!filename.endsWith('.md')) continue;
      const slug = filename.slice(0, -3);
      if (!SLUG_RE.test(slug)) continue;
      const full = join(dir, filename);
      let raw: string;
      try {
        raw = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const { frontmatter, body } = splitFrontmatter(raw);
      const meta: ArticleMeta = {
        slug,
        title: frontmatter.title ? String(frontmatter.title) : slug,
        category: frontmatter.category ? String(frontmatter.category) : '',
        ...frontmatter,
      };
      // Promote `section` (used by the legacy manual) when no category given
      if (!meta.category && meta.section) meta.category = String(meta.section);
      articles.set(slug, { slug, meta, body, raw });
    }

    const manifest: Manifest = {
      version: new Date(mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      articles: Array.from(articles.values())
        .map((a) => a.meta)
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    };

    this.cache = { dirMtimeMs: mtimeMs, manifest, articles };
    return this.cache;
  }
}

function safeMtime(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

interface FrontmatterRecord {
  [k: string]: unknown;
}

/**
 * Tiny YAML-frontmatter reader. Supports key:value pairs and bracketed
 * inline arrays (`tags: [a, b, c]`). Anything more complex falls through to
 * a string. Robust enough for the existing manual content.
 */
export function splitFrontmatter(raw: string): { frontmatter: FrontmatterRecord; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
  const rest = raw.slice(3);
  // Find the closing delimiter on its own line
  const closeIdx = rest.search(/\r?\n---\s*(\r?\n|$)/);
  if (closeIdx === -1) return { frontmatter: {}, body: raw };
  const fmText = rest.slice(0, closeIdx);
  // body starts after the closing delimiter + its newline
  const afterClose = rest.slice(closeIdx).replace(/^\r?\n---\s*\r?\n?/, '');
  return { frontmatter: parseFrontmatter(fmText), body: afterClose };
}

export function parseFrontmatter(text: string): FrontmatterRecord {
  const out: FrontmatterRecord = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;
    out[key] = parseScalar(value);
  }
  return out;
}

function parseScalar(value: string): unknown {
  if (value === '') return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}
