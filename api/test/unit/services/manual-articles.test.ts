import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManualStore, parseFrontmatter, splitFrontmatter } from '../../../src/services/manual-articles.js';
import { searchManual } from '../../../src/services/manual-search.js';

describe('parseFrontmatter', () => {
  it('parses string keys', () => {
    expect(parseFrontmatter('title: hello\ncategory: orientation')).toEqual({
      title: 'hello',
      category: 'orientation',
    });
  });

  it('parses inline arrays', () => {
    expect(parseFrontmatter('tags: [a, b, "c"]')).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('parses integers and booleans', () => {
    expect(parseFrontmatter('count: 42\nactive: true\noff: false')).toEqual({
      count: 42,
      active: true,
      off: false,
    });
  });
});

describe('splitFrontmatter', () => {
  it('splits frontmatter from body', () => {
    const raw = '---\ntitle: hi\n---\nthe body';
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter.title).toBe('hi');
    expect(body).toBe('the body');
  });

  it('returns no frontmatter when none present', () => {
    expect(splitFrontmatter('plain body')).toEqual({ frontmatter: {}, body: 'plain body' });
  });

  it('falls back to no frontmatter when delimiter never closes', () => {
    const raw = '---\ntitle: hi\nwith no closing delimiter';
    expect(splitFrontmatter(raw)).toEqual({ frontmatter: {}, body: raw });
  });
});

describe('ManualStore', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'manual-'));
    mkdirSync(join(root, 'manual', 'articles'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks the articles directory and builds a manifest', () => {
    writeFileSync(
      join(root, 'manual', 'articles', 'welcome.md'),
      ['---', 'title: Welcome', 'category: Orientation', '---', 'Welcome body'].join('\n'),
    );
    writeFileSync(
      join(root, 'manual', 'articles', 'hosts.md'),
      ['---', 'title: Hosts', 'category: Operations', '---', 'Hosts body'].join('\n'),
    );
    const store = new ManualStore(root);
    const manifest = store.manifest();
    expect(manifest.articles.map((a) => a.slug)).toEqual(['hosts', 'welcome']);
    expect(manifest.articles[0]?.title).toBe('Hosts');
    expect(manifest.articles[0]?.category).toBe('Operations');
  });

  it('refuses to load files whose slug fails the regex', () => {
    writeFileSync(join(root, 'manual', 'articles', 'BadSlug.md'), 'x');
    writeFileSync(join(root, 'manual', 'articles', 'ok-slug.md'), '---\ntitle: ok\n---\nbody');
    const store = new ManualStore(root);
    expect(store.manifest().articles.map((a) => a.slug)).toEqual(['ok-slug']);
  });

  it('returns null for an invalid slug requested via article()', () => {
    const store = new ManualStore(root);
    expect(store.article('../etc/passwd')).toBeNull();
    expect(store.article('NotASlug')).toBeNull();
  });

  it('returns the body and meta for a valid slug', () => {
    writeFileSync(
      join(root, 'manual', 'articles', 'welcome.md'),
      ['---', 'title: Welcome', 'category: Orientation', '---', 'Welcome body line 1', 'Welcome body line 2'].join('\n'),
    );
    const store = new ManualStore(root);
    const article = store.article('welcome');
    expect(article?.meta.title).toBe('Welcome');
    expect(article?.body).toContain('Welcome body line 1');
    expect(article?.body).toContain('Welcome body line 2');
  });

  it('invalidates the cache and reloads after invalidate()', () => {
    writeFileSync(join(root, 'manual', 'articles', 'a.md'), '---\ntitle: A\n---\nA');
    const store = new ManualStore(root);
    expect(store.manifest().articles).toHaveLength(1);
    writeFileSync(join(root, 'manual', 'articles', 'b.md'), '---\ntitle: B\n---\nB');
    store.invalidate();
    expect(store.manifest().articles).toHaveLength(2);
  });

  it('handles a missing manual directory gracefully', () => {
    rmSync(join(root, 'manual', 'articles'), { recursive: true });
    const store = new ManualStore(root);
    expect(store.manifest()).toEqual({ version: '0', articles: [] });
    expect(store.article('whatever')).toBeNull();
  });
});

describe('searchManual', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'manual-search-'));
    mkdirSync(join(root, 'manual', 'articles'), { recursive: true });
    writeFileSync(
      join(root, 'manual', 'articles', 'hosts.md'),
      ['---', 'title: Hosts', 'category: Operations', '---', 'A host is a single machine talking to the orchestrator.'].join('\n'),
    );
    writeFileSync(
      join(root, 'manual', 'articles', 'welcome.md'),
      ['---', 'title: Welcome', 'category: Orientation', '---', 'Welcome to the manual. There are hosts and projects.'].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns no hits for an empty query', () => {
    const store = new ManualStore(root);
    expect(searchManual(store, '   ')).toEqual([]);
  });

  it('finds title matches and ranks them above body matches', () => {
    const store = new ManualStore(root);
    const hits = searchManual(store, 'hosts');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.slug).toBe('hosts');
  });

  it('returns a snippet around the body hit', () => {
    const store = new ManualStore(root);
    const hits = searchManual(store, 'orchestrator');
    expect(hits[0]?.snippet.toLowerCase()).toContain('orchestrator');
  });
});
