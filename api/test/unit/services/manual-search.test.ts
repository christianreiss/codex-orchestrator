import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ManualStore } from '../../../src/services/manual-articles.js';
import { searchManual, type SearchHit } from '../../../src/services/manual-search.js';

describe('searchManual', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'manual-search-'));
    mkdirSync(join(root, 'manual', 'articles'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeArticle(slug: string, title: string, category: string, body: string): void {
    writeFileSync(
      join(root, 'manual', 'articles', `${slug}.md`),
      ['---', `title: ${title}`, `category: ${category}`, '---', body].join('\n'),
    );
  }

  function scores(hits: SearchHit[]): Map<string, number> {
    return new Map(hits.map((h) => [h.slug, h.score]));
  }

  it('returns nothing for an empty or whitespace-only query', () => {
    writeArticle('logs', 'Logs', 'Operations', 'Body about logs.');
    const store = new ManualStore(root);
    expect(searchManual(store, '')).toEqual([]);
    expect(searchManual(store, '   \t\n ')).toEqual([]);
  });

  it('ranks a title match above an article that only mentions the query in its body', () => {
    writeArticle('logs', 'Logs and Diagnostics', 'Operations', 'Where to find them, and how to read them.');
    writeArticle(
      'architecture',
      'Architecture',
      'Design',
      Array.from({ length: 15 }, (_, i) => `Component ${i} ships its logs to the collector.`).join(' '),
    );
    const store = new ManualStore(root);
    const hits = searchManual(store, 'logs');
    expect(hits.map((h) => h.slug)).toEqual(['logs', 'architecture']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('caps how much repetition a body match can earn', () => {
    writeArticle('some', 'Some', 'Design', Array.from({ length: 11 }, () => 'logs').join(' '));
    writeArticle('many', 'Many', 'Design', Array.from({ length: 40 }, () => 'logs').join(' '));
    const store = new ManualStore(root);
    const byScore = scores(searchManual(store, 'logs'));
    expect(byScore.get('many')).toBe(byScore.get('some'));
  });

  it('ranks an exact title above a title substring that also matches category and body', () => {
    writeArticle('logs', 'Logs', 'Reference', 'How to read what the fleet emits.');
    writeArticle(
      'log-shipping',
      'Logs and Diagnostics',
      'logs',
      Array.from({ length: 12 }, () => 'logs').join(' '),
    );
    const store = new ManualStore(root);
    const hits = searchManual(store, 'logs');
    expect(hits.map((h) => h.slug)).toEqual(['logs', 'log-shipping']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('weights a category match above a bare body match', () => {
    writeArticle('alpha', 'Alpha', 'Operations', 'One operations mention.');
    writeArticle('beta', 'Beta', 'Reference', 'One operations mention.');
    const store = new ManualStore(root);
    const hits = searchManual(store, 'operations');
    expect(hits.map((h) => h.slug)).toEqual(['alpha', 'beta']);
    const byScore = scores(hits);
    expect(byScore.get('alpha')! - byScore.get('beta')!).toBe(3);
  });

  it('returns at most 20 hits', () => {
    for (let i = 0; i < 25; i += 1) {
      writeArticle(`filler-${i}`, `Filler ${i}`, 'Reference', 'A widget lives here.');
    }
    const store = new ManualStore(root);
    expect(searchManual(store, 'widget')).toHaveLength(20);
  });

  it('brackets a mid-body snippet with ellipses', () => {
    const filler = 'padding '.repeat(30);
    writeArticle('deep', 'Deep', 'Reference', `${filler}needle${filler}`);
    const store = new ManualStore(root);
    const snippet = searchManual(store, 'needle')[0]!.snippet;
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('needle');
  });

  it('falls back to the leading body slice when only the title matches', () => {
    writeArticle('logs', 'Logs', 'Reference', 'Nothing\n  here   names  it.');
    const store = new ManualStore(root);
    const snippet = searchManual(store, 'logs')[0]!.snippet;
    expect(snippet).toBe('Nothing here names it.');
  });

  it('returns an empty snippet for an article with no body', () => {
    writeFileSync(
      join(root, 'manual', 'articles', 'logs.md'),
      ['---', 'title: Logs', 'category: Reference', '---', ''].join('\n'),
    );
    const store = new ManualStore(root);
    expect(searchManual(store, 'logs')[0]!.snippet).toBe('');
  });
});
