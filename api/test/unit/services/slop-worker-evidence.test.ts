import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const vendor = new URL('../../../../slop-worker/vendor/slop-detector/src/', import.meta.url).pathname;
const { validateEvidence } = await import(vendor + 'validate.ts');
const { blank, finding } = await import(vendor + 'core.ts');
const worker = new URL('../../../../slop-worker/worker.mjs', import.meta.url).pathname;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function waitJson(file: string) {
  for (let i = 0; i < 400; i++) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* worker has not published yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Worker result timed out');
}

describe('Slop worker evidence handoff', () => {
  it('validates full-review Go and PTY citations without claiming scanner coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-tui-'));
    try {
      await writeFile(join(root, 'view.go'), 'package main\nfunc view() {}\n');
      await writeFile(join(root, 'terminal.txt'), '80x24; Tab; focused Save\nEnter; saved\n');
      const report = blank();
      report.findings = [finding('focus', 'view.go:2', 'terminal.txt:1 shows focus', 'focus', 'fix', 'check')];
      expect(await validateEvidence(root, [], report)).toEqual([]);
      expect(report.sources).toEqual({});
      report.findings[0].location = 'terminal.txt:99';
      expect((await validateEvidence(root, [], report))[0]).toContain('Line out of range');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['startup', 'missed event'] as const)('preserves uploaded evidence through scan and report after %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'slop-worker-'));
    const run = join(root, 'slop/runs/11111111-1111-4111-8111-111111111111');
    const staging = join(root, 'prepared');
    const runs = join(root, 'slop/runs');
    await mkdir(runs, { recursive: true });
    const slop = join(root, 'scanner');
    await mkdir(join(slop, 'dist'), { recursive: true });
    await mkdir(join(staging, 'out/evidence'), { recursive: true });
    await mkdir(join(staging, 'tree'), { recursive: true });
    await writeFile(join(slop, 'package.json'), JSON.stringify({ version: 'test', type: 'module' }));
    // Stub the CLI only: real worker filesystem/protocol and real evidence validator below.
    await writeFile(join(slop, 'dist/cli.js'), `
      import { readFile, writeFile, mkdir } from 'node:fs/promises';
      import { join } from 'node:path';
      const args = process.argv.slice(2), command = args[0];
      if (command === 'rubric') { console.log('Test rubric'); }
      else {
        const out = args[args.indexOf('--out') + 1];
        await mkdir(out, { recursive: true });
        const report = command === 'scan' ? ${JSON.stringify(blank())} : JSON.parse(await readFile(args[1], 'utf8'));
        await writeFile(join(out, command + '.json'), JSON.stringify(report));
      }
    `);
    await writeFile(join(staging, 'out/evidence/desktop.png'), 'image bytes');
    await writeFile(join(staging, 'scan.request.json'), JSON.stringify({ task: 'scan', full: true,
      artifacts: { 'evidence/desktop.png': hash('image bytes') } }));
    const args = [];
    if (scenario === 'startup') {
      await rename(staging, run);
    } else {
      // Simulate lost inotify notifications; the filesystem, clocks, worker and process are real.
      const noNotifications = join(root, 'no-watch.cjs');
      await writeFile(noNotifications, `require('node:fs').watch = () => new (require('node:events').EventEmitter)();
        require('node:module').syncBuiltinESMExports();`);
      args.push('--require', noNotifications);
    }
    const child = spawn(process.execPath, [...args, worker], {
      env: { ...process.env, DATA_ROOT: root, SLOP_HOME: slop }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const closed = once(child, 'exit');
    try {
      if (scenario === 'missed event') {
        await once(child.stdout, 'data');
        await rename(staging, run);
      }
      const scan = await waitJson(join(run, 'scan.result.json'));
      expect(scan.state).toBe('done');
      expect(scan.report.artifacts).toEqual({ 'evidence/desktop.png': hash('image bytes') });
      await writeFile(join(run, 'review.json'), JSON.stringify({ version: 1, findings: [] }));
      await writeFile(join(run, 'report.request.json'), JSON.stringify({ task: 'report' }));
      const final = await waitJson(join(run, 'report.result.json'));
      expect(final.report.artifacts).toEqual(scan.report.artifacts);
      const report = final.report;
      report.findings = [finding('copy', 'evidence/desktop.png', 'See desktop.png', 'copy', 'fix', 'check')];
      expect(await validateEvidence(join(run, 'tree'), [join(run, 'out')], report)).toEqual([]);
      await writeFile(join(run, 'out/evidence/desktop.png'), 'changed');
      expect(await validateEvidence(join(run, 'tree'), [join(run, 'out')], report)).toContain('Artifact changed since capture: evidence/desktop.png');
      await rm(join(run, 'out/evidence/desktop.png'));
      expect(await validateEvidence(join(run, 'tree'), [join(run, 'out')], report)).toContain('Missing artifact: evidence/desktop.png');
      await writeFile(join(run, 'out/evidence/desktop.png'), 'image bytes');
      await mkdir(join(run, 'out/other'));
      await writeFile(join(run, 'out/other/desktop.png'), 'other bytes');
      report.artifacts['other/desktop.png'] = hash('other bytes');
      expect((await validateEvidence(join(run, 'tree'), [join(run, 'out')], report)).some((error: string) => error.startsWith('Ambiguous screenshot'))).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);
});
