import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every shipped manual article closes with a `## Source references` section
 * pointing operators at the files that back its claims — some 200 repo-relative
 * paths across the sixteen articles. Nothing checked them, so a rename or
 * deletion anywhere in `api/src`, `frontend/src`, `wrappers/` or `runner/` left
 * the in-product manual citing files that no longer exist, with a fully green
 * gate.
 *
 * This scan reads the leading token of each citation bullet and fails when it
 * does not resolve on disk. Only path liveness is checked — the parenthetical
 * or em-dashed note after the path is not compared against anything.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const ARTICLES = resolve(REPO, 'public/admin/manual/articles');

/** Citations that name no single file on purpose. */
const ALLOWED: Record<string, string> = {
  'api/src/routes/admin/**/*.ts': 'glob standing for the whole admin route tree',
};

interface Citation {
  /** Article file the bullet was read from. */
  file: string;
  /** Line in the article. */
  line: number;
  /** Repo-relative path as written, minus backticks and list comma. */
  path: string;
}

const HEADING = /^##\s/;
const SOURCE_REFERENCES = /^##\s+Source references\s*$/;
/** A citation bullet; continuation lines of a wrapped bullet are indented. */
const BULLET = /^-\s+(\S+)/;

/**
 * `- api/src/env.ts (defaults)`, `` - `api/src/services/agents.ts` `` and
 * `- api/src/http/plugins/auth-mtls.ts, api/src/security/mtls.ts (…)` all cite
 * their first path in the leading token: strip the backticks the two quoted
 * articles wrap it in, and the comma that separates it from a second path.
 */
function citedPath(token: string): string {
  return token.replace(/,$/, '').replace(/^`/, '').replace(/`$/, '');
}

function collectCitations(file: string, article: string): Citation[] {
  const citations: Citation[] = [];
  let inSection = false;
  for (const [index, line] of article.split('\n').entries()) {
    if (HEADING.test(line)) inSection = SOURCE_REFERENCES.test(line);
    if (!inSection) continue;
    const bullet = BULLET.exec(line);
    if (bullet) {
      citations.push({ file, line: index + 1, path: citedPath(bullet[1]!) });
    }
  }
  return citations;
}

const articleFiles = readdirSync(ARTICLES)
  .filter((file) => file.endsWith('.md'))
  .sort();
const articles = articleFiles.map((file) => ({
  file,
  text: readFileSync(resolve(ARTICLES, file), 'utf8'),
}));
const citations = articles.flatMap(({ file, text }) => collectCitations(file, text));

/** Directory citations may be written with a trailing `/`. */
function resolves(citation: Citation): boolean {
  return existsSync(resolve(REPO, citation.path.replace(/\/$/, '')));
}

describe('manual article source references', () => {
  it('extracts the citations it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertion below.
    expect(citations.length).toBeGreaterThan(100);
    for (const { file, text } of articles) {
      if (!text.split('\n').some((line) => SOURCE_REFERENCES.test(line))) continue;
      expect(
        citations.some((citation) => citation.file === file),
        `${file} has a Source references section but no citations`,
      ).toBe(true);
    }
    const cited = new Set(citations.map((citation) => citation.path));
    expect(cited.has('api/src/server.ts')).toBe(true);
    // Backticks and the separating comma come off; the note after does not join.
    expect(cited.has('api/src/routes/admin/hosts/index.ts')).toBe(true);
    expect(cited.has('api/src/http/plugins/auth-mtls.ts')).toBe(true);
    // Prose above the section, and wrapped continuation lines, stay out.
    const sample = collectCitations(
      'sample.md',
      ['- ignored.ts', '## Source references', '- `wrappers/clx` — Go module', '  wrapped'].join(
        '\n',
      ),
    );
    expect(sample.map((citation) => citation.path)).toEqual(['wrappers/clx']);
  });

  it('resolves every cited path on disk', () => {
    const missing = citations
      .filter((citation) => !(citation.path in ALLOWED) && !resolves(citation))
      .map((citation) => `${citation.file}:${citation.line} cites ${citation.path}`);
    expect(
      missing,
      'fix the citation in the article, or record it in ALLOWED here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(ALLOWED).filter(
      (path) =>
        !citations.some((citation) => citation.path === path) ||
        citations.some((citation) => citation.path === path && resolves(citation)),
    );
    expect(stale).toEqual([]);
    for (const reason of Object.values(ALLOWED)) {
      expect(reason.trim()).not.toBe('');
    }
  });
});
