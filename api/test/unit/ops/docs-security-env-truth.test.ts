import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs/SECURITY.md` is the hardening checklist an operator works through, so a
 * knob named there that nothing reads is a setting someone applies believing it
 * hardened something. It had five: `ADMIN_SESSION_TTL_SECONDS` (the schema says
 * `ADMIN_SESSION_TTL_MINUTES`), `ADMIN_ACCESS_MODE=none` (not in the enum),
 * `INSTALL_TOKEN_TTL_SECONDS` (a fixed constant), `MCP_ALLOWED_ORIGINS` and
 * `CODEX_SYNC_ALLOW_INSECURE`.
 *
 * Name coverage only — every backticked UPPER_SNAKE identifier in the doc has
 * to be declared by the API schema, read directly from `process.env` under
 * `api/src`, or listed below. Defaults and prose are not compared, except for
 * `ADMIN_ACCESS_MODE` values, which are checked against the zod enum.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const DOC = resolve(ROOT, 'docs/SECURITY.md');
const ENV_TS = resolve(ROOT, 'api/src/env.ts');
const API_SRC = resolve(ROOT, 'api/src');

/**
 * Vars the API never reads, so they cannot come from the schema. Each entry
 * names where it is consumed; the stale guard below deletes the excuse once
 * the doc stops mentioning it.
 */
const NON_API_VARS: Record<string, string> = {
  CODEX_INSTALL_CURL_INSECURE: 'api/src/services/wrapper-transition.ts (generated installer)',
  RUNNER_SHARED_SECRET: 'runner/app.py',
};

/** `SMTP_HOST`, but not the `X-Runner-Auth` header or a bare `TLS`. */
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

/** Vars read straight off `process.env`, bypassing the schema entirely. */
const processEnvVars = (): Set<string> => {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const src = readFileSync(path, 'utf8');
      const reads = src.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"])/g);
      for (const read of reads) names.add((read[1] ?? read[2])!);
    }
  };
  walk(API_SRC);
  return names;
};

/** Members of `ADMIN_ACCESS_MODE: z.enum([...])`. */
const accessModes = (): Set<string> => {
  const src = readFileSync(ENV_TS, 'utf8');
  const decl = /ADMIN_ACCESS_MODE: z\.enum\(\[([^\]]+)\]\)/.exec(src);
  expect(decl).not.toBeNull();
  return new Set([...decl![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!));
};

/** `ADMIN_ACCESS_MODE=cookie` and the `mtls|open` alternation form. */
const documentedAccessModes = (): string[] => {
  const doc = readFileSync(DOC, 'utf8');
  const mentions = doc.matchAll(/ADMIN_ACCESS_MODE=([a-z]+(?:\|[a-z]+)*)/g);
  return [...new Set([...mentions].flatMap((m) => m[1]!.split('|')))].sort();
};

describe('docs/SECURITY.md environment reference', () => {
  it('names only variables something reads', () => {
    const declared = new Set([...schemaKeys(), ...processEnvVars()]);
    const unknown = documentedVars().filter(
      (name) => !declared.has(name) && !(name in NON_API_VARS),
    );

    // Each entry is a var docs/SECURITY.md tells operators about that no source
    // declares: fix the name in the doc, drop the claim, or add it to
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

  it('documents only ADMIN_ACCESS_MODE values the enum accepts', () => {
    const modes = accessModes();
    const documented = documentedAccessModes();
    expect(documented.length).toBeGreaterThan(0);

    // `ADMIN_ACCESS_MODE=none` fails the schema at boot, so a doc telling an
    // operator to set it hands them a config the API refuses to start on.
    expect(documented.filter((mode) => !modes.has(mode))).toEqual([]);
  });

  // Pins the extractions, so a regex that quietly stops matching cannot turn
  // the checks above into comparisons of two empty lists.
  it('reads the names out of the doc and each source', () => {
    const documented = documentedVars();
    expect(documented).toContain('AUTH_RUNNER_URL');
    expect(documented).toContain('ADMIN_SESSION_TTL_MINUTES');
    expect(documented).toContain('TRUSTED_PROXY_CIDRS');
    expect(documented).not.toContain('ADMIN_SESSION_TTL_SECONDS');
    expect(documented).not.toContain('INSTALL_TOKEN_TTL_SECONDS');

    const keys = schemaKeys();
    expect(keys.size).toBeGreaterThan(50);
    expect(keys.has('ADMIN_SESSION_TTL_MINUTES')).toBe(true);
    expect(keys.has('SMTP_SECURE')).toBe(true); // The last key before superRefine.

    expect(processEnvVars().has('TOKEN_MIN_LENGTH')).toBe(true); // runner-validation.ts
    expect(accessModes()).toEqual(new Set(['mtls', 'cookie', 'open']));
    expect(documentedAccessModes()).toContain('open');
  });
});
