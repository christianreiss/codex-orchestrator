import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const API_ROOT = resolve(import.meta.dirname, '../../..');
let fixture: string;
let apiRoot: string;

beforeAll(() => {
  fixture = mkdtempSync(resolve(tmpdir(), 'api-build-manifests-'));
  apiRoot = resolve(fixture, 'api');
  mkdirSync(resolve(apiRoot, 'dist'), { recursive: true });
  symlinkSync(resolve(API_ROOT, 'node_modules'), resolve(fixture, 'node_modules'), 'dir');
  // Keep the launcher outside the malformed package scope: otherwise Node's
  // module loader can reject package.json before the build gets to read it.
  buildSync({
    entryPoints: [resolve(API_ROOT, 'scripts/build.ts')],
    outfile: resolve(fixture, 'build.mjs'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node22',
    format: 'esm',
    define: { 'import.meta.dirname': JSON.stringify(resolve(apiRoot, 'scripts')) },
  });
});

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe('API build manifest errors', () => {
  it.each(['package.json', 'package-lock.json'])(
    'rejects malformed %s before touching build artifacts without printing its contents',
    (filename) => {
      writeFileSync(resolve(apiRoot, 'package.json'), JSON.stringify({ dependencies: {} }));
      writeFileSync(resolve(apiRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
      const sentinel = 'PRIVATE_MANIFEST_SENTINEL';
      writeFileSync(resolve(apiRoot, filename), `{ "${sentinel}": invalid }`);
      const artifact = resolve(apiRoot, 'dist', 'server.js');
      writeFileSync(artifact, 'previous successful build');

      const result = spawnSync(process.execPath, [resolve(fixture, 'build.mjs')], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, NODE_OPTIONS: '' },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Invalid JSON in build manifest ${resolve(apiRoot, filename)}`);
      expect(result.stderr).not.toContain(sentinel);
      expect(result.stdout).not.toContain('Build complete');
      expect(readdirSync(resolve(apiRoot, 'dist'))).toEqual(['server.js']);
      expect(readFileSync(artifact, 'utf8')).toBe('previous successful build');
    },
  );
});
