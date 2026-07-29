import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/OVERVIEW.md` is the entry point a new contributor reads, and its "Key
 * components (code map)" section hands out concrete files — `api/src/server.ts`,
 * the services behind `/auth` and the wrapper bakery, `api/src/ws/publisher.ts`,
 * `api/src/db/schema.ts`, the hand-written DDL under `api/src/db/migrations/`.
 * Nothing checked them, so a rename left the map pointing at files that no
 * longer exist with a fully green gate — the same hole
 * `manual-source-references.test.ts` closed for the shipped manual.
 *
 * This scan reads every backticked path in the doc that starts with one of the
 * repo's top-level source directories and fails when it does not resolve on
 * disk. Only path liveness is checked: the prose around a citation is not
 * compared against anything, and backticked endpoints (`/auth`), file names
 * without a directory (`config.toml`) and host-side paths
 * (`~/.claude/settings.json`) are none of its business.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const OVERVIEW_DOC = resolve(ROOT, 'docs/OVERVIEW.md');

/**
 * Citations that name no file in a checkout on purpose: a glob standing for a
 * whole tree, or a directory only created at runtime. The stale check below
 * drops the excuse once the doc does.
 */
const ALLOWED: Record<string, string> = {
  'api/src/routes/*': 'glob standing for the whole route tree, not a single file',
};

interface Citation {
  /** Line in `docs/OVERVIEW.md`. */
  line: number;
  /** Repo-relative path as written, minus the backticks. */
  path: string;
}

const CODE_SPAN = /`([^`\n]+)`/g;
/** The top-level directories a repo-relative citation can start with. */
const REPO_PATH = /^(?:api|frontend|wrappers|runner|public|docs)\//;

/**
 * Most citations are a code span of their own, but a span may also list two of
 * them (`a.ts, b.ts`) or trail a note, so every whitespace/comma-separated token
 * is offered to the prefix test rather than just the span.
 */
function collectCitations(doc: string): Citation[] {
  const citations: Citation[] = [];
  for (const [index, line] of doc.split('\n').entries()) {
    for (const span of line.matchAll(CODE_SPAN)) {
      for (const token of span[1]!.split(/[\s,]+/)) {
        if (REPO_PATH.test(token)) citations.push({ line: index + 1, path: token });
      }
    }
  }
  return citations;
}

/** Directory citations are written with a trailing `/`. */
function resolves(citation: Citation): boolean {
  return existsSync(resolve(ROOT, citation.path.replace(/\/$/, '')));
}

const citations = collectCitations(readFileSync(OVERVIEW_DOC, 'utf8'));

describe('overview code map', () => {
  it('extracts the citations it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertion below.
    expect(citations.length).toBeGreaterThan(20);
    const cited = new Set(citations.map((citation) => citation.path));
    for (const path of [
      'api/src/server.ts',
      'api/src/services/host-auth.ts',
      'api/src/ws/publisher.ts',
      'api/src/db/schema.ts',
      'api/src/db/migrations/',
      'wrappers/cxx/',
      'docs/USAGE.md',
    ]) {
      expect(cited.has(path), `code map no longer cites ${path}`).toBe(true);
    }
    // Endpoints, bare file names and host-side paths are not repo paths.
    const sample = collectCitations(
      ['`/auth` and `config.toml`', '- `api/src/env.ts` `~/.codex/auth.json`'].join('\n'),
    );
    expect(sample).toEqual([{ line: 2, path: 'api/src/env.ts' }]);
  });

  it('resolves every cited path on disk', () => {
    const missing = citations
      .filter((citation) => !(citation.path in ALLOWED) && !resolves(citation))
      .map((citation) => `docs/OVERVIEW.md:${citation.line} cites ${citation.path}`);
    expect(
      missing,
      'fix the citation in the overview, or record it in ALLOWED here with a reason',
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
