import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/INSTALL.md` and `docs/SECURITY.md` have their own guards; these five
 * docs describe the same deployment to the same operator, so a name that
 * nothing reads is a knob someone sets that silently does nothing. All five
 * presented `INSTALL_TOKEN_TTL_SECONDS` as configurable when it is the fixed
 * constant `INSTALL_TOKEN_TTL_SECONDS_DEFAULT` in
 * `api/src/services/host-management.ts`, and `docs/ADMIN.md` went as far as
 * documenting its invalid-value fallback. Six more came out with it:
 * `ADMIN_SESSION_TTL_SECONDS` and `ADMIN_WS_PING_INTERVAL` (the schema says
 * `_MINUTES` and `ADMIN_WS_HEARTBEAT_SECONDS`), `CODEX_SYNC_ALLOW_INSECURE` and
 * `CODEX_SSH_ALT_SCREEN` (v1 bash-wrapper levers; the Go wrappers read
 * `allow_insecure` off the signed config and have no alt-screen override),
 * `MCP_ALLOWED_ORIGINS` (there is no origin allowlist, only a toggle), and the
 * PHP-isms `REMOTE_ADDR` and `DATE_ATOM`.
 *
 * Name coverage only — every backticked UPPER_SNAKE identifier in each doc has
 * to be declared by the API schema, the compose file, the runner, or the
 * allowlist below. Defaults and prose are not compared.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const DOCS = [
  'docs/USAGE.md',
  'docs/ADMIN.md',
  'docs/OVERVIEW.md',
  'docs/API.md',
  'docs/interface-api.md',
];
const ENV_TS = resolve(ROOT, 'api/src/env.ts');
const COMPOSE = resolve(ROOT, 'docker-compose.yml');
const RUNNER = resolve(ROOT, 'runner/app.py');

/**
 * Names the env schema cannot declare, because they are read outside the API
 * or are not env vars at all. Each entry names the file that consumes it; the
 * stale guard below deletes the excuse once the docs stop mentioning it.
 */
const NON_API_VARS: Record<string, string> = {
  ANTHROPIC_MODEL: 'wrappers/clx/internal/summary/local_settings.go',
  BIN_DIR: 'api/src/services/wrapper-transition.ts (generated installer)',
  CODEX_HOME: 'wrappers/cdx/internal/codex/auth_writer.go',
  CODEX_INSTALL_CURL_INSECURE: 'api/src/services/wrapper-transition.ts (generated installer)',
  OPENAI_API_KEY: 'wrappers/cdx/internal/codex/env.go (exported into the Codex process)',
  TOKEN_MIN_LENGTH: 'api/src/services/runner-validation.ts (read off process.env)',
  VALID_ACCESS_LEVELS: 'api/src/services/admin-auth.ts (an exported constant, not an env var)',
};

/** `SMTP_HOST`, but not the `X-MTLS-*` header prefix or a bare `TLS`. */
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/**
 * Inline code spans only, keyed by name so a failure names the doc to fix. The
 * `[^`\n]` keeps a fenced block's ``` from pairing with the next backtick and
 * swallowing half the document.
 */
const documentedVars = (): Map<string, string[]> => {
  const names = new Map<string, string[]>();
  for (const doc of DOCS) {
    const text = readFileSync(resolve(ROOT, doc), 'utf8');
    for (const span of text.matchAll(/`([^`\n]+)`/g)) {
      for (const name of span[1]!.matchAll(ENV_NAME)) {
        const seen = names.get(name[0]) ?? [];
        if (!seen.includes(doc)) seen.push(doc);
        names.set(name[0], seen);
      }
    }
  }
  return new Map([...names].sort(([a], [b]) => a.localeCompare(b)));
};

/**
 * Top-level keys of the zod object literal, which are the only lines indented
 * exactly four spaces inside it — nested `z.enum([...])` members and the
 * `superRefine` body sit deeper or start lower.
 */
const schemaKeys = (): Set<string> => {
  const src = readFileSync(ENV_TS, 'utf8');
  const start = src.indexOf('.object({');
  const end = src.indexOf('.superRefine(', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!));
};

/** Compose `${VAR}` interpolations plus the env keys each service passes down. */
const composeVars = (): Set<string> => {
  const yml = readFileSync(COMPOSE, 'utf8');
  const names = new Set([...yml.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!));
  for (const key of yml.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)) names.add(key[1]!);
  return names;
};

const runnerVars = (): Set<string> => {
  const py = readFileSync(RUNNER, 'utf8');
  const reads = py.matchAll(/(?:getenv|environ\.get|setdefault)\(\s*"([A-Z][A-Z0-9_]*)"/g);
  return new Set([...reads].map((m) => m[1]!));
};

describe('operator docs environment reference', () => {
  it('names only variables something reads', () => {
    const declared = new Set([...schemaKeys(), ...composeVars(), ...runnerVars()]);
    const unknown = [...documentedVars()]
      .filter(([name]) => !declared.has(name) && !(name in NON_API_VARS))
      .map(([name, docs]) => `${name} (${docs.join(', ')})`);

    // Each entry is a var these docs present to operators that no source
    // declares: fix the name in the doc, drop the claim, or add it to
    // NON_API_VARS with the file that consumes it.
    expect(unknown).toEqual([]);
  });

  it('keeps the non-API allowlist to vars the docs still mention', () => {
    const documented = documentedVars();
    const stale = Object.keys(NON_API_VARS).filter((name) => !documented.has(name));

    // An allowlist entry outlives its bullet the moment the docs drop it, and a
    // stale exemption is how the next wrong name gets waved through.
    expect(stale).toEqual([]);
  });

  // Pins the four extractions, so a regex that quietly stops matching cannot
  // turn the checks above into comparisons of two empty lists.
  it('reads the names out of each doc and each source', () => {
    const documented = documentedVars();
    // Every doc has to contribute names, or one of the five goes unchecked.
    expect([...new Set([...documented.values()].flat())].sort()).toEqual([...DOCS].sort());
    expect(documented.get('PUBLIC_BASE_URL')).toContain('docs/USAGE.md');
    expect(documented.has('ADMIN_ACCESS_MODE')).toBe(true);
    expect(documented.has('RUNNER_SHARED_SECRET')).toBe(true);
    expect(documented.has('MTLS')).toBe(false); // `X-MTLS-*` is a header, not a var.

    // The knob these five docs invented: a fixed constant, never read from env.
    expect(documented.has('INSTALL_TOKEN_TTL_SECONDS')).toBe(false);
    const src = readFileSync(resolve(ROOT, 'api/src/services/host-management.ts'), 'utf8');
    expect(src).toMatch(/export const INSTALL_TOKEN_TTL_SECONDS_DEFAULT = 1800;/);

    const keys = schemaKeys();
    expect(keys.size).toBeGreaterThan(50);
    expect(keys.has('ADMIN_SESSION_TTL_MINUTES')).toBe(true);
    expect(keys.has('SMTP_SECURE')).toBe(true); // The last key before superRefine.
    expect(keys.has('INSTALL_TOKEN_TTL_SECONDS')).toBe(false);

    expect(composeVars().has('DB_ROOT_PASSWORD')).toBe(true);
    expect(composeVars().has('MYSQL_USER')).toBe(true); // A service-level env key.
    expect(runnerVars().has('RUNNER_SHARED_SECRET')).toBe(true);
  });
});
