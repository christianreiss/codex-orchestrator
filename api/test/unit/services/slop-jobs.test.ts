import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inferSlopKind, normalizeSlopPath, pathsCollide, isLikelyText } from '../../../src/services/slop-jobs/paths.js';
import { compareRuns, unifiedDiff } from '../../../src/services/slop-jobs/diff.js';
import { withUnsupportedCoverageNote } from '../../../src/services/slop-jobs/coverage.js';
import { buildTar, tarName } from '../../../src/services/slop-jobs/tar.js';
import { parseReviewReply, reviewQuestion, REVIEW_FENCE, stripReviewBlock } from '../../../src/services/slop-jobs/review.js';
import { parseAdvisorVerdict } from '../../../src/services/advisor-delivery.js';
import { slopRunIdFromClientKey } from '../../../src/services/slop-jobs/advisor-hook.js';

describe('slop job paths', () => {
  it('accepts project-relative POSIX paths and strips ./', () => {
    expect(normalizeSlopPath('./src/app.svelte')).toBe('src/app.svelte');
    expect(normalizeSlopPath('DESIGN.md')).toBe('DESIGN.md');
  });
  it.each(['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'a/./b', '.slop/x', '.git/config', 'a\u0000b'])(
    'refuses %j',
    (path) => {
      expect(() => normalizeSlopPath(path)).toThrow();
    },
  );
  it('infers kinds and validates screenshots', () => {
    expect(inferSlopKind('shots/a.PNG', undefined)).toBe('screenshot');
    expect(inferSlopKind('src/a.tsx', undefined)).toBe('source');
    expect(inferSlopKind('a11y.json', 'a11y')).toBe('a11y');
    expect(() => inferSlopKind('src/a.tsx', 'screenshot')).toThrow();
    expect(() => inferSlopKind('src/a.tsx', 'binary')).toThrow();
  });
  it('detects file/directory collisions', () => {
    expect(pathsCollide('a/b', 'a/b/c')).toBe(true);
    expect(pathsCollide('a/b', 'a/bc')).toBe(false);
    expect(pathsCollide('a', 'a')).toBe(false);
  });
  it('tells text from binary', () => {
    expect(isLikelyText(Buffer.from('hällo\n'))).toBe(true);
    expect(isLikelyText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBe(false);
  });
});

describe('slop job diff', () => {
  it('produces a unified diff that patch(1) applies', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const after = before.replace('line 3\n', 'line three\n').replace('line 15\n', '') + 'tail\n';
    const result = unifiedDiff(before, after, 'a/f.txt', 'b/f.txt');
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), 'slop-diff-'));
    try {
      writeFileSync(join(dir, 'f.txt'), before);
      writeFileSync(join(dir, 'p.diff'), result.diff);
      execFileSync('patch', ['-s', join(dir, 'f.txt'), join(dir, 'p.diff')]);
      expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reports no change as an empty diff and handles creation', () => {
    expect(unifiedDiff('a\n', 'a\n', 'x', 'y').diff).toBe('');
    const created = unifiedDiff('', 'one\ntwo\n', '/dev/null', 'f@1');
    expect(created.diff).toContain('@@ -0,0 +1,2 @@');
    expect(created.added).toBe(2);
  });
});

describe('slop unsupported-source coverage note', () => {
  const skipped = {
    findings: [],
    coverage: ['Source scan: 0 files. Browser behavior not tested.', 'Skipped: 3 unsupported extension.', 'Unsupported extensions skipped: .php (3). Deterministic rules cover only .ts .tsx.'],
  };
  it('says a quick run gave the skipped files no review at all', () => {
    const out = withUnsupportedCoverageNote(skipped, 'quick');
    expect(out.coverage.at(-1)).toContain('in a quick run, no review at all');
    expect(out.coverage).toHaveLength(4);
  });
  it('says a full run covers them only through the advisor, and only once', () => {
    const out = withUnsupportedCoverageNote(skipped, 'full');
    expect(out.coverage.at(-1)).toContain('only through the Fleet Advisor review');
    expect(withUnsupportedCoverageNote(out, 'full').coverage).toHaveLength(4);
  });
  it('leaves reports without unsupported skips untouched', () => {
    const clean = { findings: [], coverage: ['Source scan: 2 files. Browser behavior not tested.'] };
    expect(withUnsupportedCoverageNote(clean, 'full')).toBe(clean);
  });
});

describe('slop job run comparison', () => {
  const file = (kind: string, sha = 'a') => ({ rev: 1, sha256: sha, kind });
  const full = {
    mode: 'full',
    findings: [
      { id: 'review:1', kind: 'review' },
      { id: 'abc', kind: 'measured' },
      { id: 'def', kind: 'measured' },
    ],
    files: { 'src/a.ts': file('source', 'a'), 'shots/home.png': file('screenshot'), 'a11y.json': file('a11y') },
  };
  const quick = { mode: 'quick', findings: [{ id: 'abc', kind: 'measured' }], files: { 'src/a.ts': file('source', 'b') } };

  it('does not call a full run review finding resolved when a quick run follows', () => {
    const cmp = compareRuns(full, quick);
    expect(cmp.findings.resolved.map((f) => f.id)).toEqual(['def']);
    expect(cmp.findings.not_rechecked.map((f) => f.id)).toEqual(['review:1']);
    expect(cmp.findings.unchanged).toBe(1);
  });
  it('does not report screenshots and a11y exports as removed when a quick run follows', () => {
    const cmp = compareRuns(full, quick);
    expect(cmp.files.removed).toEqual([]);
    expect(cmp.files.not_compared).toBe(2);
    expect(cmp.files.changed).toEqual([{ path: 'src/a.ts', from_rev: 1, to_rev: 1 }]);
  });
  it('does not report them as added when a quick run is followed by a full one', () => {
    const cmp = compareRuns(quick, full);
    expect(cmp.files.added).toEqual([]);
    expect(cmp.files.not_compared).toBe(2);
    expect(cmp.findings.new.map((f) => f.id).sort()).toEqual(['def', 'review:1']);
  });
  it('keeps the plain comparison between runs of the same mode', () => {
    const later = { ...full, findings: [{ id: 'abc', kind: 'measured' }], files: { 'src/a.ts': file('source', 'a') } };
    const cmp = compareRuns(full, later);
    expect(cmp.findings.resolved.map((f) => f.id)).toEqual(['review:1', 'def']);
    expect(cmp.findings.not_rechecked).toEqual([]);
    expect(cmp.files.removed.sort()).toEqual(['a11y.json', 'shots/home.png']);
    expect(cmp.files.not_compared).toBe(0);
  });
});

describe('slop review bundle tar', () => {
  it('builds an archive tar(1) extracts byte-for-byte, including long names', () => {
    const long = `${'deep/'.repeat(30)}file.svelte`;
    const entries = [
      { name: 'tree/src/a.svelte', data: Buffer.from('<p>hi</p>\n') },
      { name: `tree/${tarName(long)}`, data: Buffer.from('long\n') },
      { name: 'shots/x.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'slop-tar-'));
    try {
      writeFileSync(join(dir, 'b.tar'), buildTar(entries));
      execFileSync('tar', ['-xf', join(dir, 'b.tar'), '-C', dir]);
      for (const entry of entries) expect(readFileSync(join(dir, entry.name))).toEqual(entry.data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('slop review protocol', () => {
  const finding = {
    rule: 'hierarchy',
    priority: 'P0',
    kind: 'measured',
    location: 'src/a.svelte:3',
    evidence: 'two primary buttons',
    message: 'competing actions',
    remedy: 'demote one',
    acceptance: 'one primary action',
    alternative: 'both may be equally important',
  };
  it('parses the tagged block, forces kind=review and caps priority at P1', () => {
    const reply = `Findings first.\n\n\`\`\`${REVIEW_FENCE}\n${JSON.stringify({ version: 1, findings: [finding, { rule: 'x' }] })}\n\`\`\`\n\n\`\`\`json\n{"verdict":"disagree","summary":"s","evidence":[]}\n\`\`\``;
    const parsed = parseReviewReply(reply)!;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({ kind: 'review', priority: 'P1', location: 'src/a.svelte:3' });
    expect(String(parsed.findings[0]!['id'])).toMatch(/^review:[a-f0-9]{16}$/);
    expect(parsed.problems[0]).toMatch(/finding 2 lacks/);
    // Stable ids: the same finding in a later run diffs as unchanged.
    expect(parseReviewReply(reply)!.findings[0]!['id']).toBe(parsed.findings[0]!['id']);
  });
  it('still finds the json verdict after the review block', () => {
    const reply = `Text.\n\n\`\`\`${REVIEW_FENCE}\n{"version":1,"findings":[]}\n\`\`\`\n\n\`\`\`json\n{"verdict":"disagree","summary":"s"}\n\`\`\``;
    expect(parseAdvisorVerdict(stripReviewBlock(reply))).toMatchObject({ verdict: 'disagree', summary: 's' });
  });
  it('returns null without a block and reports invalid JSON', () => {
    expect(parseReviewReply('no block here')).toBeNull();
    expect(parseReviewReply(`\`\`\`${REVIEW_FENCE}\n{nope\n\`\`\``)!.problems).toEqual(['review block is not valid JSON']);
  });
  it('names the transfer and the unpack directory in the question', () => {
    const q = reviewQuestion({ jobTitle: 'Login "v2"', runSeq: 3, transferId: 'tid', bundleName: 'slop-r.tar', sourceCount: 2, screenshotCount: 1, hasDescription: false });
    expect(q).toContain('cxx transfer get tid --output ./slop-r.tar --json');
    expect(q).toContain('-C ./slop-r');
    expect(q).toContain('absent for this run');
    expect(q).toContain('including Go');
    expect(q).toContain('PTY transcript/text evidence under tree/');
    expect(q).toContain('Do not execute uploaded programs or replay transcripts');
    expect(q).toContain('needs_info, never a coverage pass');
  });
});

describe('slop advisor hook', () => {
  it('maps only <caller>:<run-uuid> client keys to runs', () => {
    expect(slopRunIdFromClientKey('caller:11111111-2222-4333-8444-555555555555')).toBe('11111111-2222-4333-8444-555555555555');
    expect(slopRunIdFromClientKey('caller:not-a-uuid')).toBeNull();
    expect(slopRunIdFromClientKey(null)).toBeNull();
  });
});
