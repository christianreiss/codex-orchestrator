import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Rules that must hold for every image this repository builds.
 *
 * Each one is a defect that shipped: `npm install` in the image re-resolved
 * semver ranges so two builds of one commit produced different trees; the
 * runtime stage ran as root under a read-only filesystem that hid the fact;
 * and `FROM node:22-alpine` meant "whatever that tag pointed at this morning".
 */
const DOCKERFILES = ['Dockerfile', 'api/Dockerfile', 'runner/Dockerfile'] as const;
const NODE_DOCKERFILES = ['Dockerfile', 'api/Dockerfile'] as const;

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function instructions(text: string): string[] {
  // Fold `\`-continued shell lines into one, drop comments and blanks.
  return text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function buildArgs(text: string): Record<string, string | undefined> {
  const args: Record<string, string | undefined> = {};
  for (const line of instructions(text)) {
    const match = /^ARG\s+([A-Za-z_]\w*)(?:=(.*))?$/.exec(line);
    if (match?.[1]) args[match[1]] = match[2];
  }
  return args;
}

function fromImages(text: string): string[] {
  const args = buildArgs(text);
  return instructions(text)
    .map((line) => /^FROM\s+(\S+)/.exec(line)?.[1])
    .filter((image): image is string => image !== undefined)
    .map((image) => {
      const arg = /^\$\{([A-Za-z_]\w*)\}$/.exec(image)?.[1];
      return arg ? (args[arg] ?? image) : image;
    });
}

describe('every image is built from a pinned base', () => {
  it.each(DOCKERFILES)('%s pins each FROM by digest', (rel) => {
    const images = fromImages(read(rel));
    expect(images.length).toBeGreaterThan(0);
    const unpinned = images.filter((image) => !image.includes('@sha256:') && !isStageName(image));
    expect(unpinned, `${rel} has unpinned base images`).toEqual([]);
  });

  it('pins the same Node base everywhere it is used', () => {
    const pins = new Set(
      NODE_DOCKERFILES.flatMap((rel) =>
        fromImages(read(rel)).filter((image) => image.includes('node:')),
      ),
    );
    expect(pins.size, `Node base drifted between Dockerfiles: ${[...pins].join(' vs ')}`).toBe(1);
  });
});

/** Later stages are referenced by name, not by image reference. */
function isStageName(image: string): boolean {
  return !image.includes(':') && !image.includes('/');
}

describe('node images install deterministically', () => {
  it.each(NODE_DOCKERFILES)('%s never runs npm install', (rel) => {
    const offenders = instructions(read(rel)).filter((line) =>
      /\bnpm\s+install\b/.test(line) && !/\bnpm\s+install\s+-g\b/.test(line),
    );
    expect(offenders, `${rel} must use npm ci so the lockfile decides the tree`).toEqual([]);
  });

  it.each(NODE_DOCKERFILES)('%s copies a lockfile before installing', (rel) => {
    const lines = instructions(read(rel));
    const firstInstall = lines.findIndex((line) => /\bnpm\s+ci\b/.test(line));
    expect(firstInstall, `${rel} runs no npm ci at all`).toBeGreaterThan(-1);
    const copiedLockBefore = lines
      .slice(0, firstInstall)
      .some((line) => /^COPY\b/.test(line) && /package-lock\.json/.test(line));
    expect(copiedLockBefore, `${rel} installs before any package-lock.json is present`).toBe(true);
  });

  it.each(NODE_DOCKERFILES)('%s copies the lockfile without a wildcard', (rel) => {
    // `package-lock.json*` silently tolerates the file being absent, which is
    // exactly the case `npm ci` exists to refuse.
    const optional = instructions(read(rel)).filter((line) =>
      /^COPY\b/.test(line) && /package-lock\.json\*/.test(line),
    );
    expect(optional, `${rel} makes the lockfile optional`).toEqual([]);
  });

  it.each(NODE_DOCKERFILES)('%s installs production dependencies with --omit=dev', (rel) => {
    const text = read(rel);
    expect(text).toMatch(/npm ci --omit=dev/);
  });
});

describe('images drop root', () => {
  it.each(DOCKERFILES)('%s ends as an unprivileged numeric user', (rel) => {
    const users = instructions(read(rel))
      .filter((line) => /^USER\s+/.test(line))
      .map((line) => line.replace(/^USER\s+/, '').trim());
    expect(users.length, `${rel} never drops root`).toBeGreaterThan(0);
    const last = users[users.length - 1];
    expect(last).not.toBe('root');
    expect(last).not.toBe('0');
  });

  it.each(NODE_DOCKERFILES)('%s runs as a fixed uid:gid', (rel) => {
    const users = instructions(read(rel))
      .filter((line) => /^USER\s+/.test(line))
      .map((line) => line.replace(/^USER\s+/, '').trim());
    expect(users[users.length - 1]).toMatch(/^\d+:\d+$/);
  });
});

describe('CI pins the actions it runs', () => {
  const workflowDir = resolve(REPO_ROOT, '.github/workflows');
  const workflows = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));

  it('has workflows to check', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it.each(workflows)('%s pins every third-party action to a full commit SHA', (name) => {
    const uses = readFileSync(resolve(workflowDir, name), 'utf8')
      .split(/\r?\n/)
      .map((line) => /^\s*-?\s*uses:\s*(\S+)/.exec(line)?.[1])
      .filter((ref): ref is string => ref !== undefined)
      // A local composite action (`./.github/actions/x`) has no ref to pin.
      .filter((ref) => !ref.startsWith('./'));
    expect(uses.length).toBeGreaterThan(0);
    const floating = uses.filter((ref) => !/@[0-9a-f]{40}$/.test(ref));
    expect(
      floating,
      `a tag can be moved onto different code after review: ${floating.join(', ')}`,
    ).toEqual([]);
  });
});

describe('the base-image pins have a maintained update path', () => {
  const script = 'scripts/update-base-images.sh';

  it('ships the refresh script the Dockerfiles point at', () => {
    expect(existsSync(resolve(REPO_ROOT, script))).toBe(true);
  });

  it('names every Dockerfile it is responsible for', () => {
    const text = read(script);
    for (const rel of DOCKERFILES) {
      expect(text, `${script} does not update ${rel}`).toContain(rel);
    }
  });
});
