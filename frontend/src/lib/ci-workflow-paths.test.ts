import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `.github/workflows/frontend.yml` fired on `frontend/**` and itself, but the
 * frontend suite is not confined to `frontend/`: `api/cli-auth.test.ts` reads
 * the CLI auth service out of the api to pin the device-code alphabet against
 * the service that issues it. A commit that edited only the api therefore ran
 * no frontend job at all — and the api workflow does not run this suite — so
 * the parity that test exists to catch shipped unseen. Only the local gate,
 * which always runs everything, saw it.
 *
 * So the filters are held against the suite itself: every quoted path literal
 * under `frontend/src` that resolves outside `frontend/` has to have its
 * top-level segment listed by both the `push` and the `pull_request` filter.
 * The scan is deliberately literal — a path spelled in code counts — because
 * an extra segment costs one cheap CI job and a missing one costs the
 * guarantee the test was written for.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FRONTEND = resolve(ROOT, "frontend");
const SRC = resolve(FRONTEND, "src");
const WORKFLOW = ".github/workflows/frontend.yml";
const EVENTS = ["push", "pull_request"] as const;

/** The cross-package read this guard was written for, named from the root. */
const PARITY_TEST = "frontend/src/lib/api/cli-auth.test.ts";

/**
 * Top-level segments a path literal names without the suite depending on the
 * tree. Empty today — the one segment the scan finds is a file a frontend test
 * opens. An entry belongs here only for a literal that is not a repo path at
 * all, and has to name why.
 */
const ALLOWED: Record<string, string> = {};

/**
 * A quoted literal that spells a path: `"../../../../api/src/services/cli-auth.ts"`,
 * or a root-relative `"docs/API.md"`. A bare filename is not one, an endpoint
 * is not one either — every route in this suite starts with `/` — and
 * excluding `$` keeps interpolated templates out.
 */
const PATH_LITERAL = /(['"`])((?:\.{1,2}\/|[\w@.-]+\/)[\w@./-]*)\1/g;

/**
 * Comments only, so that prose about a file is never mistaken for a read; a
 * block comment keeps its newlines so the line numbers below stay true. The
 * `[^:'"`]` guard keeps a `://` inside a URL from eating its own line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, "$1");
}

/** Every `*.test.ts` under `frontend/src`, named from the repo root. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.ts")) found.push(relative(ROOT, path).replace(/\\/g, "/"));
    }
  };
  walk(SRC);
  return found.sort();
}

interface Reference {
  /** The repo-root-relative top-level segment, e.g. `api`. */
  segment: string;
  /** `frontend/src/lib/api/cli-auth.test.ts:91 ../../../../api/src/services/cli-auth.ts` */
  where: string;
}

/**
 * A literal written relative resolves against its own file; anything else
 * resolves against the repo root. A resolution that does not exist is not a
 * repo path — `"application/json"` is a media type, `"@tanstack/svelte-query"`
 * a package the mocks name — so it drops out.
 */
function referencesOutsideFrontend(files: string[]): Reference[] {
  const found: Reference[] = [];
  for (const file of files) {
    const path = resolve(ROOT, file);
    stripComments(readFileSync(path, "utf8"))
      .split("\n")
      .forEach((line, index) => {
        for (const match of line.matchAll(PATH_LITERAL)) {
          const literal = match[2];
          if (!literal) continue;
          const absolute = literal.startsWith(".")
            ? resolve(dirname(path), literal)
            : resolve(ROOT, literal);
          if (!relative(FRONTEND, absolute).startsWith("..")) continue;
          const fromRoot = relative(ROOT, absolute);
          if (!fromRoot || fromRoot.startsWith("..")) continue;
          if (!existsSync(absolute)) continue;
          const segment = fromRoot.split(sep)[0];
          if (!segment) continue;
          found.push({ segment, where: `${file}:${index + 1} ${literal}` });
        }
      });
  }
  return found;
}

/**
 * The `paths:` list of each event under `on:`. The frontend carries no YAML
 * parser — the suite runs on bare `node --test` and a guard is not worth a
 * dependency — so the block is read directly. That is enough for this file:
 * one `on:` mapping, whose events each hold a flat list of quoted scalars.
 */
function workflowFilters(source: string): Record<string, string[]> {
  const filters: Record<string, string[]> = {};
  let inOn = false;
  let event = "";
  let collecting: string[] | null = null;

  for (const line of source.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (collecting) {
      if (indent >= 6 && stripped.startsWith("- ")) {
        collecting.push(stripped.slice(2).trim().replace(/^(['"])(.*)\1$/, "$2"));
        continue;
      }
      collecting = null;
    }

    if (indent === 0) {
      inOn = stripped === "on:";
      event = "";
    } else if (inOn && indent === 2 && stripped.endsWith(":")) {
      event = stripped.slice(0, -1);
    } else if (event && indent === 4 && stripped === "paths:") {
      collecting = filters[event] = [];
    }
  }

  return filters;
}

/** `api/**` and `docker-compose.yml` alike admit their first segment. */
function triggeredSegments(entries: string[] | undefined): Set<string> {
  return new Set((entries ?? []).map((entry) => entry.replace(/\/.*$/, "")));
}

const FILES = testFiles();
const REFERENCES = referencesOutsideFrontend(FILES);
const FILTERS = workflowFilters(readFileSync(resolve(ROOT, WORKFLOW), "utf8"));
const TRIGGERS = EVENTS.map((event) => ({ event, segments: triggeredSegments(FILTERS[event]) }));

describe("frontend workflow path triggers", () => {
  it("reads the workflow and the suite it guards", () => {
    // A walk, a filter or a pattern that quietly matched nothing would pass
    // everything below.
    assert.ok(FILES.length > 20, `only ${FILES.length} test files found under ${SRC}`);
    assert.ok(FILES.includes("frontend/src/lib/ci-workflow-paths.test.ts"), FILES.join(" "));
    for (const { event, segments } of TRIGGERS) {
      assert.ok(segments.has("frontend"), `no frontend/ entry in the ${event} paths`);
      assert.ok(segments.has(".github"), `no workflow entry in the ${event} paths`);
      // Every entry is read as an include, so a negation would be honoured
      // backwards.
      assert.deepEqual([...segments].filter((segment) => segment.startsWith("!")), []);
    }

    const literals = (text: string): string[] =>
      [...text.matchAll(PATH_LITERAL)].map((match) => match[2] ?? "");
    assert.deepEqual(literals('new URL("../../../../api/src/services/cli-auth.ts", import.meta.url)'), [
      "../../../../api/src/services/cli-auth.ts",
    ]);
    assert.deepEqual(literals('readFileSync(resolve(ROOT, "api/src/server.ts"))'), [
      "api/src/server.ts",
    ]);
    // A URL, an endpoint, a bare filename and an interpolated template are not
    // path reads.
    assert.deepEqual(literals('const issuer = "https://auth.example.com/token";'), []);
    assert.deepEqual(literals('assert.equal(request.url, "/admin/api/hosts");'), []);
    assert.deepEqual(literals('assert.equal(entry.name, "README.md");'), []);
    assert.deepEqual(literals("readFileSync(`${ROOT}/api/src/server.ts`)"), []);
    // Prose naming a file is not a read of it. The fixtures below stay inside
    // `api/` for the same reason the workflow lists it: a literal spelled here
    // is a reference like any other.
    assert.ok(
      stripComments('/**\n * `api/src/server.ts`\n */\nconst SERVICE = "api/src/server.ts";\n').includes(
        'const SERVICE = "api/src/server.ts";',
      ),
    );
    assert.ok(!stripComments("/** `api/src/env.ts` */\n").includes("api/src/env.ts"));
  });

  it("finds the api service the parity test is known to read", () => {
    // Likewise: a scan that stopped seeing the one cross-package read this
    // guard was written for has nothing left to guard.
    assert.ok(
      REFERENCES.some(({ segment, where }) => segment === "api" && where.startsWith(`${PARITY_TEST}:`)),
      `no api read found in ${PARITY_TEST}: ${JSON.stringify(REFERENCES)}`,
    );
  });

  it("triggers on every tree the frontend suite reads", () => {
    const uncovered = REFERENCES.filter(
      ({ segment }) =>
        !(segment in ALLOWED) && TRIGGERS.some(({ segments }) => !segments.has(segment)),
    );
    assert.deepEqual(
      [
        ...new Set(
          uncovered.map(({ segment, where }) => `${where} — ${segment} is missing from ${WORKFLOW}`),
        ),
      ].sort(),
      [],
    );
  });

  it("keeps no stale allowlist entries", () => {
    const found = new Set(REFERENCES.map((reference) => reference.segment));
    assert.deepEqual(
      Object.keys(ALLOWED).filter((segment) => !found.has(segment)),
      [],
    );
  });
});
