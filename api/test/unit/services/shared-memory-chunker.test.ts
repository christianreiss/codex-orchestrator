/**
 * The chunker's two load-bearing invariants — chunks tile the document exactly,
 * and splits prefer structural boundaries — are what let `shared_memory_read`
 * treat a chunk range as a character range and what makes a search hit point at
 * a readable passage rather than an arbitrary 2000-character window.
 */
import { describe, it, expect } from 'vitest';
import {
  CHUNK_MAX_CHARS,
  CHUNK_TARGET_CHARS,
  MAX_CHUNKS,
  chunkContent,
  excerptFor,
  preview,
} from '../../../src/services/shared-memory-chunker.js';

function assertTiles(content: string): void {
  const chunks = chunkContent(content);
  expect(chunks[0]!.charStart).toBe(0);
  expect(chunks[chunks.length - 1]!.charEnd).toBe(content.length);
  for (let i = 1; i < chunks.length; i++) {
    expect(chunks[i]!.charStart).toBe(chunks[i - 1]!.charEnd);
    expect(chunks[i]!.ordinal).toBe(i);
  }
  expect(chunks.map((c) => c.content).join('')).toBe(content);
  for (const c of chunks) expect(c.content).toBe(content.slice(c.charStart, c.charEnd));
}

describe('chunkContent', () => {
  it('emits a single empty chunk for an empty document', () => {
    const chunks = chunkContent('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ordinal: 0, content: '', charStart: 0, charEnd: 0, heading: null });
  });

  it('keeps a short document in one chunk', () => {
    const chunks = chunkContent('# Title\n\nA short note about crane deploys.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe('Title');
  });

  it('tiles the document exactly for prose', () => {
    const para = 'The orchestrator keeps one canonical auth store per engine. '.repeat(12);
    assertTiles(Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${para}`).join('\n\n'));
  });

  it('tiles the document exactly for markdown with headings', () => {
    const body = Array.from(
      { length: 15 },
      (_, i) => `## Section ${i}\n\n${'Detail line about section content. '.repeat(30)}\n`,
    ).join('\n');
    assertTiles(`# Runbook\n\n${body}`);
  });

  it('tiles the document exactly when there is no whitespace to break on', () => {
    assertTiles('x'.repeat(CHUNK_MAX_CHARS * 3 + 17));
  });

  it('tiles the document exactly for CRLF input', () => {
    assertTiles(Array.from({ length: 40 }, (_, i) => `## H${i}\r\n\r\n${'body '.repeat(80)}`).join('\r\n'));
  });

  it('respects the hard maximum chunk size', () => {
    const content = Array.from({ length: 30 }, () => 'word '.repeat(400)).join('\n\n');
    for (const chunk of chunkContent(content)) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it('breaks at a heading once the current chunk has enough text', () => {
    const section = (n: number) => `## Section ${n}\n\n${'filler sentence here. '.repeat(60)}\n\n`;
    const chunks = chunkContent(section(1) + section(2) + section(3));
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk after the first starts exactly on its heading line.
    for (const chunk of chunks.slice(1)) {
      expect(chunk.content.startsWith('## Section')).toBe(true);
    }
  });

  it('does not split on a heading that would leave a tiny chunk', () => {
    // Many one-line sections: splitting per heading would produce one chunk
    // each, which is both slower to search and useless to read.
    const content = Array.from({ length: 60 }, (_, i) => `### H${i}\n\nshort body\n`).join('\n');
    const chunks = chunkContent(content);
    expect(chunks.length).toBeLessThan(20);
    assertTiles(content);
  });

  it('records the heading breadcrumb in force at the chunk start', () => {
    // The Deploy body is long enough to need a mid-section split, so at least
    // one chunk starts under `Ops > Deploy` without starting on its heading.
    const content = `# Ops\n\n## Deploy\n\n${'crane deploy detail. '.repeat(600)}\n\n### Crane\n\n${'more crane text. '.repeat(150)}`;
    const chunks = chunkContent(content);
    expect(chunks[0]!.heading).toBe('Ops');
    const crumbs = chunks.map((c) => c.heading);
    expect(crumbs).toContain('Ops > Deploy');
    expect(crumbs).toContain('Ops > Deploy > Crane');
  });

  it('prefers a section boundary over the soft target size', () => {
    // A heading past CHUNK_MIN_CHARS but before the hard limit wins: keeping a
    // section whole beats hitting the ~2000-character target exactly.
    const content = `## A\n\n${'body text here. '.repeat(200)}\n\n## B\n\nsecond section\n`;
    const chunks = chunkContent(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.content.length).toBeGreaterThan(CHUNK_TARGET_CHARS);
    expect(chunks[1]!.content.startsWith('## B')).toBe(true);
  });

  it('caps the chunk count and still covers the whole document', () => {
    // A pathological document: one heading every few characters would otherwise
    // produce one chunk per line.
    const content = Array.from({ length: MAX_CHUNKS + 500 }, (_, i) => `# ${i}\n`).join('');
    const chunks = chunkContent(content);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
    expect(chunks[chunks.length - 1]!.charEnd).toBe(content.length);
    assertTiles(content);
  });

  it('produces roughly target-sized chunks for uniform prose', () => {
    const content = 'sentence about the fleet. '.repeat(2000);
    const chunks = chunkContent(content);
    const sizes = chunks.slice(0, -1).map((c) => c.content.length);
    for (const size of sizes) {
      expect(size).toBeGreaterThanOrEqual(CHUNK_TARGET_CHARS - 200);
      expect(size).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });
});

describe('preview', () => {
  it('collapses whitespace and clips with an ellipsis', () => {
    expect(preview('  a\n\n  b  \tc ')).toBe('a b c');
    const long = preview('word '.repeat(200), 20);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('excerptFor', () => {
  it('returns the whole chunk when it already fits', () => {
    expect(excerptFor('short body', 'body')).toBe('short body');
  });

  it('windows around the matched term rather than the chunk start', () => {
    const content = `${'filler '.repeat(200)}the crane deploy runs manually${' filler'.repeat(200)}`;
    const out = excerptFor(content, 'crane deploy');
    expect(out).toContain('crane deploy');
    expect(out.length).toBeLessThanOrEqual(340);
  });

  it('falls back to a leading preview when no term is present', () => {
    // FULLTEXT ranks on stems and proximity, so a hit need not contain the
    // literal query string.
    const content = `start marker ${'filler '.repeat(200)}`;
    const out = excerptFor(content, 'zzz-not-present');
    expect(out.startsWith('start marker')).toBe(true);
  });

  it('ignores sub-3-character query tokens when locating the window', () => {
    const content = `${'a '.repeat(400)}unique-token-here${' b'.repeat(400)}`;
    expect(excerptFor(content, 'a b unique-token-here')).toContain('unique-token-here');
  });
});
