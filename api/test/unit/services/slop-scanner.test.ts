import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Load the worker's separately compiled TypeScript without adding it to the API build root.
const scannerPath = new URL('../../../../slop-worker/vendor/slop-detector/src/core.ts', import.meta.url).pathname;
const { scan } = await import(scannerPath);

describe('vendored slop source coverage and typography', () => {
  it('ignores product text and identifiers but detects declared font choices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slop-font-'));
    try {
      await writeFile(join(dir, 'app.html'), `<title>DALASON Internal Services</title>\n<option>International</option>\n<script>new IntersectionObserver(() => {})</script>\n<style>body { font-family: Inter, sans-serif; }</style>\n<div style="font-family: Internal">Internal</div>`);
      const report = await scan(dir, ['app.html']);
      expect(report.findings.filter((f: { rule: string }) => f.rule === 'type-default').map((f: { location: string }) => f.location)).toEqual(['app.html:4']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reports unsupported Kotlin files explicitly instead of implying scanned coverage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slop-kotlin-'));
    try {
      await writeFile(join(dir, 'View.kt'), '@Composable fun View() {}');
      const report = await scan(dir, ['View.kt']);
      expect(report.sources).toEqual({});
      expect(report.coverage).toContain('Source scan: 0 files. Browser behavior not tested.');
      expect(report.coverage).toContain('Skipped: 1 unsupported extension.');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
