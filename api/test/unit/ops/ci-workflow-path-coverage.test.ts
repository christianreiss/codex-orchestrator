import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import yaml from 'js-yaml';

/**
 * `.github/workflows/api.yml` fired on `api/**` and itself, but the api suite
 * is not confined to `api/`: the doc-truth scans open the markdown under
 * `docs/`, the wrapper contracts parse `wrappers/cdx/cmd/cdx/main.go` and its
 * clx twin, the invalidation coverage reads `frontend/src/lib/ws/events.ts`,
 * the manual routes read the articles under `public/`,
 * `runner-request-contract` reads `runner/app.py` and `boot-migrations` greps
 * `scripts/deploy.sh`. A commit that edited only docs, a wrapper or the
 * frontend therefore ran no api job at all — and the wrappers and frontend
 * workflows do not run these suites either — so the drift they exist to catch
 * shipped unseen. Only the local gate, which always runs everything, saw it.
 *
 * So the filters are held against the suite itself: every quoted path literal
 * under `api/test` that resolves outside `api/` has to have its top-level
 * segment listed by both the `push` and the `pull_request` filter. The scan is
 * deliberately literal — a path spelled in code counts, even where it is only
 * an allowlist value naming a consumer — because an extra segment costs one
 * cheap CI job and a missing one costs the guarantee the test was written for.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const API = resolve(ROOT, 'api');
const TESTS = resolve(API, 'test');
const WORKFLOW = '.github/workflows/api.yml';

/**
 * Top-level segments a path literal names without the suite depending on the
 * tree. Empty today — every segment the scan finds is something an api test
 * opens or points at. An entry belongs here only for a literal that is not a
 * repo path at all, and has to name why.
 */
const ALLOWED: Record<string, string> = {};

/**
 * A quoted literal that spells a path: `'../../../../runner/app.py'`, or the
 * root-relative `'docs/API.md'` these suites hand to `resolve(ROOT, …)`. A
 * bare filename is not one — `'README.md'` in a fixture names a document, not
 * a tree — and excluding `$` keeps interpolated templates out.
 */
const PATH_LITERAL = /(['"`])((?:\.{1,2}\/|[\w@.-]+\/)[\w@./-]*)\1/g;

/**
 * Comments only, so that prose about a file is never mistaken for a read; a
 * block comment keeps its newlines so the line numbers below stay true. The
 * `[^:'"`]` guard keeps a `://` inside a URL from eating its own line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

/** Every `*.test.ts` under `api/test`, named from the repo root. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.ts')) found.push(relative(ROOT, path).replace(/\\/g, '/'));
    }
  };
  walk(TESTS);
  return found.sort();
}

interface Reference {
  /** The repo-root-relative top-level segment, e.g. `docs`. */
  segment: string;
  /** `api/test/unit/ops/x.test.ts:12 docs/API.md` */
  where: string;
}

/**
 * A literal written relative resolves against its own file; anything else
 * resolves against the repo root, which is how these suites spell it once they
 * hold a `ROOT`. A resolution that does not exist is not a repo path — an
 * allowlist key like `'src/routes/cli-auth/index.ts'` is api-relative prose —
 * so it drops out.
 */
function referencesOutsideApi(files: string[]): Reference[] {
  const found: Reference[] = [];
  for (const file of files) {
    const path = resolve(ROOT, file);
    stripComments(readFileSync(path, 'utf8'))
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(PATH_LITERAL)) {
          const literal = match[2];
          if (!literal) continue;
          const absolute = literal.startsWith('.') ? resolve(dirname(path), literal) : resolve(ROOT, literal);
          if (!relative(API, absolute).startsWith('..')) continue;
          const fromRoot = relative(ROOT, absolute);
          if (!fromRoot || fromRoot.startsWith('..')) continue;
          if (!existsSync(absolute)) continue;
          const segment = fromRoot.split(sep)[0];
          if (!segment) continue;
          found.push({ segment, where: `${file}:${index + 1} ${literal}` });
        }
      });
  }
  return found;
}

interface Filter {
  paths?: string[];
}

interface Workflow {
  on: { push?: Filter; pull_request?: Filter };
}

/** `docs/**` and `docker-compose.yml` alike admit their first segment. */
function triggeredSegments(filter: Filter | undefined): Set<string> {
  return new Set((filter?.paths ?? []).map((entry) => entry.replace(/\/.*$/, '')));
}

const FILES = testFiles();
const REFERENCES = referencesOutsideApi(FILES);
const workflow = yaml.load(readFileSync(resolve(ROOT, WORKFLOW), 'utf8')) as Workflow;
const TRIGGERS = [
  { event: 'push', segments: triggeredSegments(workflow.on.push) },
  { event: 'pull_request', segments: triggeredSegments(workflow.on.pull_request) },
] as const;

describe('api workflow path triggers', () => {
  it('reads the workflow and the suite it guards', () => {
    // A walk, a filter or a pattern that quietly matched nothing would pass
    // everything below.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('api/test/unit/ops/ci-workflow-path-coverage.test.ts');
    expect(TRIGGERS.filter(({ segments }) => !segments.has('api')).map(({ event }) => event)).toEqual([]);

    const literals = (text: string): string[] =>
      [...text.matchAll(PATH_LITERAL)].map((match) => match[2] ?? '');
    expect(literals("readFileSync(resolve(ROOT, 'docs/API.md'))")).toEqual(['docs/API.md']);
    expect(literals("resolve(import.meta.dirname, '../../../../runner/app.py')")).toEqual([
      '../../../../runner/app.py',
    ]);
    // A URL, a bare filename and an interpolated template are not path reads.
    expect(literals("const issuer = 'https://auth.example.com/token';")).toEqual([]);
    expect(literals("expect(entry.name).toBe('README.md');")).toEqual([]);
    expect(literals('readFileSync(`${ROOT}/docs/API.md`)')).toEqual([]);
    // Prose naming a file is not a read of it.
    expect(stripComments("/**\n * `docs/API.md`\n */\nconst DOC = 'docs/API.md';\n")).toContain(
      "const DOC = 'docs/API.md';",
    );
    expect(stripComments('/** `caddy/Caddyfile` */\n')).not.toContain('caddy/Caddyfile');
  });

  it('finds the trees the cross-package suites are known to read', () => {
    const segments = [...new Set(REFERENCES.map((reference) => reference.segment))].sort();
    expect(segments).toEqual(
      expect.arrayContaining(['docs', 'frontend', 'public', 'runner', 'scripts', 'wrappers']),
    );
  });

  it('triggers on every tree the api suite reads', () => {
    const uncovered = REFERENCES.filter(
      ({ segment }) => !(segment in ALLOWED) && TRIGGERS.some(({ segments }) => !segments.has(segment)),
    );
    expect(
      [
        ...new Set(
          uncovered.map(({ segment, where }) => `${where} — ${segment} is missing from ${WORKFLOW}`),
        ),
      ].sort(),
    ).toEqual([]);
  });

  it('keeps no stale allowlist entries', () => {
    const found = new Set(REFERENCES.map((reference) => reference.segment));
    expect(Object.keys(ALLOWED).filter((segment) => !found.has(segment))).toEqual([]);
  });
});
