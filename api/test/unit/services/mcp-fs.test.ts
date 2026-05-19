import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpFsTools } from '../../../src/services/mcp-fs.js';

/**
 * Unit tests for the operator-only fs_* tools. Each test stages a fresh
 * tmpdir as the sandbox root so suites are isolated.
 */

let root: string;
let fs: McpFsTools;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-fs-'));
  // Seed: hello.txt, sub/world.txt, sub/nested/deep.txt, three search-corpus files.
  writeFileSync(join(root, 'hello.txt'), 'hello world\nsecond line\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'world.txt'), 'inside sub\n');
  mkdirSync(join(root, 'sub', 'nested'));
  writeFileSync(join(root, 'sub', 'nested', 'deep.txt'), 'deeply nested\nKEYWORD here\n');
  writeFileSync(join(root, 'a.log'), 'no match here\n');
  writeFileSync(join(root, 'b.log'), 'KEYWORD found in b\n');
  writeFileSync(join(root, 'c.log'), 'two KEYWORD matches\nthird line\n');

  fs = new McpFsTools({
    root,
    maxReadBytes: 1024 * 1024,
    maxListEntries: 1000,
    maxSearchHits: 50,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('McpFsTools.readFile', () => {
  it('reads a known file and returns content + sha256', async () => {
    const r = (await fs.readFile({ path: 'hello.txt' })) as Record<string, unknown>;
    expect(r['content']).toBe('hello world\nsecond line\n');
    expect(r['size']).toBe('hello world\nsecond line\n'.length);
    expect(r['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(r['truncated']).toBe(false);
    expect(r['path']).toBe('hello.txt');
  });

  it('rejects paths that escape the root via ..', async () => {
    await expect(fs.readFile({ path: '../escape.txt' })).rejects.toThrow(/escapes/);
  });

  it('rejects absolute paths outside root', async () => {
    await expect(fs.readFile({ path: '/etc/passwd' })).rejects.toThrow();
  });

  it('rejects missing path', async () => {
    await expect(fs.readFile({})).rejects.toThrow(/required/);
  });

  it('NotFoundError on nonexistent file', async () => {
    await expect(fs.readFile({ path: 'nope.txt' })).rejects.toThrow(/not found/);
  });

  it('truncates content when max_bytes is smaller than file', async () => {
    const r = (await fs.readFile({ path: 'hello.txt', max_bytes: 5 })) as Record<string, unknown>;
    expect((r['content'] as string).length).toBe(5);
    expect(r['truncated']).toBe(true);
  });

  it('rejects reading a directory', async () => {
    await expect(fs.readFile({ path: 'sub' })).rejects.toThrow(/not a regular file/);
  });

  it('rejects symlinks that escape the root', async () => {
    // Set up a symlink inside root pointing at /etc.
    const link = join(root, 'evil');
    try {
      symlinkSync('/etc', link);
    } catch {
      // Some envs don't allow symlinks — skip.
      return;
    }
    await expect(fs.readFile({ path: 'evil/passwd' })).rejects.toThrow();
  });
});

describe('McpFsTools.writeFile', () => {
  it('writes a new file then reads it back', async () => {
    const w = (await fs.writeFile({ path: 'new.txt', content: 'fresh' })) as Record<string, unknown>;
    expect(w['bytes_written']).toBe(5);
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('fresh');

    const r = (await fs.readFile({ path: 'new.txt' })) as Record<string, unknown>;
    expect(r['content']).toBe('fresh');
  });

  it('overwrites an existing file', async () => {
    await fs.writeFile({ path: 'hello.txt', content: 'replaced' });
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('replaced');
  });

  it('rejects writes outside root', async () => {
    await expect(fs.writeFile({ path: '../escape.txt', content: 'x' })).rejects.toThrow(/escapes/);
  });

  it('rejects writes without string content', async () => {
    await expect(fs.writeFile({ path: 'x.txt' })).rejects.toThrow(/content/);
  });
});

describe('McpFsTools.listDir', () => {
  it('lists a directory with subdirs (non-recursive)', async () => {
    const r = (await fs.listDir({ path: '.' })) as { entries: Array<{ name: string; type: string }> };
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toContain('hello.txt');
    expect(names).toContain('sub');
    expect(names).toContain('a.log');
    const sub = r.entries.find((e) => e.name === 'sub');
    expect(sub?.type).toBe('dir');
    const hello = r.entries.find((e) => e.name === 'hello.txt');
    expect(hello?.type).toBe('file');
  });

  it('recurses when recursive=true', async () => {
    const r = (await fs.listDir({ path: '.', recursive: true })) as {
      entries: Array<{ name: string; type: string }>;
    };
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('sub/world.txt');
    expect(names).toContain('sub/nested/deep.txt');
  });

  it('caps entries at max_entries', async () => {
    const r = (await fs.listDir({ path: '.', recursive: true, max_entries: 2 })) as {
      entries: unknown[];
      truncated: boolean;
    };
    expect(r.entries.length).toBeLessThanOrEqual(2);
    expect(r.truncated).toBe(true);
  });

  it('rejects listing a file', async () => {
    await expect(fs.listDir({ path: 'hello.txt' })).rejects.toThrow(/not a directory/);
  });

  it('rejects listing outside root', async () => {
    await expect(fs.listDir({ path: '../..' })).rejects.toThrow(/escapes/);
  });
});

describe('McpFsTools.fileExists + stat', () => {
  it('fileExists reports true for known file with type', async () => {
    const r = (await fs.fileExists({ path: 'hello.txt' })) as Record<string, unknown>;
    expect(r['exists']).toBe(true);
    expect(r['type']).toBe('file');
  });

  it('fileExists reports false for missing path (no throw)', async () => {
    const r = (await fs.fileExists({ path: 'nope.txt' })) as Record<string, unknown>;
    expect(r['exists']).toBe(false);
  });

  it('stat returns metadata for existing file', async () => {
    const r = (await fs.stat({ path: 'hello.txt' })) as Record<string, unknown>;
    expect(r['type']).toBe('file');
    expect(typeof r['size']).toBe('number');
    expect(typeof r['mode']).toBe('number');
    expect(typeof r['mtime']).toBe('string');
    expect(typeof r['ctime']).toBe('string');
  });

  it('stat throws NotFoundError for missing path', async () => {
    await expect(fs.stat({ path: 'nope.txt' })).rejects.toThrow(/not found/);
  });

  it('write-then-delete-then-stat behaves correctly', async () => {
    await fs.writeFile({ path: 'temp.txt', content: 'xyz' });
    let r = (await fs.stat({ path: 'temp.txt' })) as Record<string, unknown>;
    expect(r['size']).toBe(3);
    rmSync(join(root, 'temp.txt'));
    expect(existsSync(join(root, 'temp.txt'))).toBe(false);
    await expect(fs.stat({ path: 'temp.txt' })).rejects.toThrow(/not found/);
    r = (await fs.fileExists({ path: 'temp.txt' })) as Record<string, unknown>;
    expect(r['exists']).toBe(false);
  });
});

describe('McpFsTools.searchInFiles', () => {
  it('finds matches across multiple files', async () => {
    const r = (await fs.searchInFiles({ path: '.', pattern: 'KEYWORD' })) as {
      matches: Array<{ path: string; line: number; text: string }>;
    };
    const paths = new Set(r.matches.map((m) => m.path));
    expect(paths.has('b.log')).toBe(true);
    expect(paths.has('c.log')).toBe(true);
    expect(paths.has('sub/nested/deep.txt')).toBe(true);
    // Three seeded files contain KEYWORD — c.log contributes two matches.
    expect(r.matches.length).toBeGreaterThanOrEqual(3);
    for (const m of r.matches) {
      expect(m.line).toBeGreaterThan(0);
      expect(m.text.toUpperCase()).toContain('KEYWORD');
    }
  });

  it('caps results at max_hits', async () => {
    const r = (await fs.searchInFiles({ path: '.', pattern: 'KEYWORD', max_hits: 1 })) as {
      matches: unknown[];
      truncated: boolean;
    };
    expect(r.matches.length).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it('filters by glob (only .log files)', async () => {
    const r = (await fs.searchInFiles({ path: '.', pattern: 'KEYWORD', glob: '*.log' })) as {
      matches: Array<{ path: string }>;
    };
    for (const m of r.matches) {
      expect(m.path.endsWith('.log')).toBe(true);
    }
  });

  it('rejects empty pattern', async () => {
    await expect(fs.searchInFiles({ path: '.', pattern: '' })).rejects.toThrow(/pattern/);
  });

  it('rejects search outside root', async () => {
    await expect(fs.searchInFiles({ path: '../..', pattern: 'x' })).rejects.toThrow(/escapes/);
  });
});

describe('McpFsTools.resolveSafe', () => {
  it('treats empty / dot paths as root itself', async () => {
    const safe = await fs.resolveSafe('.', true);
    expect(safe).toBe(resolve(root));
  });

  it('strips leading slashes to keep paths root-relative', async () => {
    const safe = await fs.resolveSafe('/hello.txt', true);
    expect(safe).toBe(resolve(root, 'hello.txt'));
  });

  it('rejects backslash + dotdot traversal attempts', async () => {
    await expect(fs.resolveSafe('../../etc/passwd')).rejects.toThrow(/escapes/);
    await expect(fs.resolveSafe('sub/../../etc/passwd')).rejects.toThrow(/escapes/);
  });
});
