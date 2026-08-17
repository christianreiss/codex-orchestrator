import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API_ROOT = resolve(import.meta.dirname, '../../..');
const REPO_ROOT = resolve(API_ROOT, '..');
const DIST = resolve(API_ROOT, 'dist');
const ROOT_ENV = resolve(REPO_ROOT, '.env');

// A value that cannot occur by accident in a bundle. If the build ever inlines
// or copies operator configuration again, this string is what leaks.
const SENTINEL_KEY = 'BUILD_ARTIFACT_SENTINEL';
const SENTINEL_VALUE = 'sk-sentinel-4f2a9c31d7b84e60a15c8f7e2d0b6a93';

let createdEnv = false;
/** Every secret-shaped line the build could have picked up from `../.env`. */
let sentinelValues: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function envValues(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''))
    .filter((value) => value.length >= 12);
}

beforeAll(() => {
  // Never clobber a real operator `.env`: when one is already there it *is*
  // the tripwire, and its own values are what must not appear in `dist`. In CI
  // (and any clean checkout) there is none, so plant a sentinel instead.
  if (existsSync(ROOT_ENV)) {
    sentinelValues = envValues(readFileSync(ROOT_ENV, 'utf8'));
  } else {
    writeFileSync(ROOT_ENV, `${SENTINEL_KEY}=${SENTINEL_VALUE}\n`, { mode: 0o600 });
    createdEnv = true;
    sentinelValues = [SENTINEL_VALUE];
  }

  rmSync(DIST, { recursive: true, force: true });
  execFileSync('node', ['--import', 'tsx', 'scripts/build.ts'], {
    cwd: API_ROOT,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}, 180_000);

afterAll(() => {
  if (createdEnv) rmSync(ROOT_ENV, { force: true });
});

describe('the API build never embeds operator configuration', () => {
  it('produces the expected bundle without a .env beside it', () => {
    expect(existsSync(resolve(DIST, 'server.js'))).toBe(true);
    expect(existsSync(resolve(DIST, '.env'))).toBe(false);
  });

  it('emits no dotenv-shaped or credential file anywhere under dist', () => {
    // Names, not substrings: a migration called `0010_add_secrets.sql` is
    // schema, and a check that cannot tell it from a key file gets muted.
    const CREDENTIAL_NAMES = new Set([
      'auth.json',
      'credentials.json',
      '.credentials.json',
      '.npmrc',
      '.netrc',
      'id_rsa',
      'id_ed25519',
      'signing.ed25519',
    ]);
    const CREDENTIAL_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/i;

    const offenders = walk(DIST)
      .map((path) => path.slice(DIST.length + 1))
      .filter((rel) => {
        const base = rel.split('/').pop() ?? rel;
        return (
          base === '.env' ||
          base.startsWith('.env.') ||
          CREDENTIAL_NAMES.has(base) ||
          CREDENTIAL_EXTENSIONS.test(base)
        );
      });
    expect(offenders).toEqual([]);
  });

  it('contains none of the values from the repository .env', () => {
    expect(sentinelValues.length).toBeGreaterThan(0);
    const files = walk(DIST);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'latin1');
      for (const value of sentinelValues) {
        if (text.includes(value)) hits.push(`${file.slice(DIST.length + 1)} leaks a .env value`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('has no .env copy left in the build script', () => {
    const script = readFileSync(resolve(API_ROOT, 'scripts/build.ts'), 'utf8');
    // Comments may name the file; executable copies may not.
    const code = script.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/['"`][^'"`]*\.env['"`]/);
  });
});

describe('container build inputs exclude operator configuration', () => {
  it('keeps .env out of every build context', () => {
    const ignore = readFileSync(resolve(REPO_ROOT, '.dockerignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    expect(ignore).toContain('.env');
  });

  it('has no Dockerfile stage that copies a .env into the image', () => {
    for (const rel of ['Dockerfile', 'api/Dockerfile', 'runner/Dockerfile']) {
      const path = resolve(REPO_ROOT, rel);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const copies = text
        .split(/\r?\n/)
        .filter((line) => /^\s*(COPY|ADD)\b/i.test(line))
        .filter((line) => /\.env(\s|$|\/)/.test(line));
      expect(copies, `${rel} copies a .env`).toEqual([]);
    }
  });
});

describe('the built artifact is self-contained', () => {
  it('writes a runtime package.json that pins every external dependency exactly', () => {
    const runtime = JSON.parse(readFileSync(resolve(DIST, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const loose = Object.entries(runtime.dependencies).filter(
      ([, range]) => !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(range),
    );
    expect(loose, 'runtime dependencies must be exact versions, not ranges').toEqual([]);
  });

  it('ships a lockfile beside the runtime package.json', () => {
    expect(existsSync(resolve(DIST, 'package-lock.json'))).toBe(true);
  });
});
