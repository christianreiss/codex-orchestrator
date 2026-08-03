import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/INSTALL.md` is what an operator reads while writing `.env`, so a name
 * in it that nothing reads is a knob someone sets that silently does nothing.
 * It had six: `ADMIN_SESSION_TTL_SECONDS` (the schema says
 * `ADMIN_SESSION_TTL_MINUTES`), `ADMIN_PASSWORD_MIN_LENGTH`,
 * `INSTALL_TOKEN_TTL_SECONDS`, `RATE_LIMIT_GLOBAL_PER_MINUTE`,
 * `RATE_LIMIT_GLOBAL_WINDOW` and three `AUTH_RUNNER_*_URL` summary knobs.
 *
 * Name coverage only — every backticked UPPER_SNAKE identifier in the doc has
 * to be declared by the API schema, the compose file, the runner, or the
 * allowlist below. Defaults and prose are not compared.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const DOC = resolve(ROOT, 'docs/INSTALL.md');
const ENV_TS = resolve(ROOT, 'api/src/env.ts');
const COMPOSE = resolve(ROOT, 'docker-compose.yml');
const RUNNER = resolve(ROOT, 'runner/app.py');

/**
 * Vars the API never reads, so they cannot come from the schema. Each entry
 * names where it is consumed; the stale guard below deletes the excuse once
 * the doc stops mentioning it.
 */
const NON_API_VARS: Record<string, string> = {
  CADDY_TLS_CERT_FILE: 'caddy/tls-custom.caddy',
  CADDY_TLS_KEY_FILE: 'caddy/tls-custom.caddy',
  CODEX_DEBUG: 'wrappers/cxx/internal/app/codex/main.go',
  CODEX_DEPLOY_BACKUP_DIR: 'scripts/deploy.sh',
  // Spec-standard OpenTelemetry knob, read by the SDK itself rather than by
  // `env.ts`. Deliberately not mirrored into the schema: re-declaring it would
  // invite a second source of truth for a value we only ever pass through.
  // Verified consumer, not a guess — `loadDefaultConfig()` in
  // node_modules/@opentelemetry/sdk-trace-base/build/src/config.js, reached
  // through the NodeTracerProvider that api/src/observability/tracing.ts builds.
  OTEL_TRACES_SAMPLER: '@opentelemetry/sdk-trace-base config.js, via api/src/observability/tracing.ts',
};

/** `SMTP_HOST`, but not the `X-MTLS-*` header prefix or a bare `TLS`. */
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/**
 * Inline code spans only. The `[^`\n]` keeps a fenced block's ``` from pairing
 * with the next backtick and swallowing half the document.
 */
const documentedVars = (): string[] => {
  const doc = readFileSync(DOC, 'utf8');
  const names = new Set<string>();
  for (const span of doc.matchAll(/`([^`\n]+)`/g)) {
    for (const name of span[1]!.matchAll(ENV_NAME)) names.add(name[0]);
  }
  return [...names].sort();
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

describe('docs/INSTALL.md environment reference', () => {
  it('names only variables something reads', () => {
    const declared = new Set([...schemaKeys(), ...composeVars(), ...runnerVars()]);
    const unknown = documentedVars().filter(
      (name) => !declared.has(name) && !(name in NON_API_VARS),
    );

    // Each entry is a var docs/INSTALL.md tells operators to set that no
    // source declares: fix the name in the doc, drop the bullet, or add it to
    // NON_API_VARS with the file that consumes it.
    expect(unknown).toEqual([]);
  });

  it('keeps the non-API allowlist to vars the doc still mentions', () => {
    const documented = new Set(documentedVars());
    const stale = Object.keys(NON_API_VARS).filter((name) => !documented.has(name));

    // An allowlist entry outlives its bullet the moment the doc drops it, and
    // a stale exemption is how the next wrong name gets waved through.
    expect(stale).toEqual([]);
  });

  // Pins the three extractions, so a regex that quietly stops matching cannot
  // turn the check above into a comparison of two empty lists.
  it('reads the names out of the doc and each source', () => {
    const documented = documentedVars();
    expect(documented).toContain('AUTH_RUNNER_URL');
    expect(documented).toContain('ADMIN_SESSION_TTL_MINUTES');
    expect(documented).toContain('RUN_MIGRATIONS_ON_BOOT');
    expect(documented).not.toContain('MTLS'); // `X-MTLS-*` is a header, not a var.

    const keys = schemaKeys();
    expect(keys.size).toBeGreaterThan(50);
    expect(keys.has('ADMIN_SESSION_TTL_MINUTES')).toBe(true);
    expect(keys.has('SMTP_SECURE')).toBe(true); // The last key before superRefine.
    expect(keys.has('ADMIN_SESSION_TTL_SECONDS')).toBe(false);

    expect(composeVars().has('DB_ROOT_PASSWORD')).toBe(true);
    expect(composeVars().has('MYSQL_USER')).toBe(true); // A service-level env key.
    expect(runnerVars().has('RUNNER_SHARED_SECRET')).toBe(true);
  });

  it('describes boot migrations the way RUN_MIGRATIONS_ON_BOOT behaves', () => {
    const doc = readFileSync(DOC, 'utf8');
    expect(doc).not.toMatch(/no boot migration runner/i);

    // Reading the default out of the schema keeps the doc's "default on" claim
    // pinned to the declaration rather than to this test's memory of it.
    const src = readFileSync(ENV_TS, 'utf8');
    expect(src).toMatch(/RUN_MIGRATIONS_ON_BOOT: boolish\.default\(true\)/);
    expect(doc).toMatch(/`RUN_MIGRATIONS_ON_BOOT` \(default on\)/);
  });
});
