import { expect, it } from 'vitest';
import { SlopJobsService } from '../../../src/services/slop-jobs.js';
import type { SlopRun } from '../../../src/db/schema.js';

it('makes zero scanned files and unsupported source coverage visible in the run response', () => {
  const service = Object.create(SlopJobsService.prototype) as SlopJobsService;
  const coverage = ['Source scan: 0 files. Browser behavior not tested.', 'Skipped: 3 unsupported extension.'];
  const run = { reportJson: JSON.stringify({ findings: [], errors: [], sources: {}, coverage }) } as SlopRun;
  expect(service.runSummary(run)).toMatchObject({ findings: 0, coverage, scanned_source_files: 0 });
  expect(service.runSummary({ reportJson: null } as SlopRun)).toMatchObject({ coverage: null, scanned_source_files: null });
});

const finding = (id: string, priority: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  priority,
  kind,
  rule: 'focus',
  location: 'a.css:1',
  message: `m-${id}`,
  remedy: 'r',
  ...extra,
});

it('counts findings with an inline slop-ok suppression apart from the open P-counts', () => {
  const service = Object.create(SlopJobsService.prototype) as SlopJobsService;
  const findings = [
    finding('open', 'P1', 'review'),
    finding('ack', 'P1', 'review', { suppression: 'outline replaced by ring' }),
    finding('m', 'P0', 'measured'),
  ];
  const run = { reportJson: JSON.stringify({ findings, errors: [], coverage: [] }) } as SlopRun;
  const summary = service.runSummary(run);
  expect(summary.findings).toBe(3);
  expect(summary.counts).toEqual({ P0: 1, P1: 1, P2: 0, measured: 1, review: 1, suppressed: 1 });
});

it('lists suppressed findings with their reason in their own markdown section', () => {
  const service = Object.create(SlopJobsService.prototype) as SlopJobsService;
  const report = {
    findings: [finding('open', 'P1', 'review'), finding('ack', 'P1', 'review', { suppression: 'outline replaced by ring' })],
    errors: [],
    coverage: [],
  };
  const md = (service as unknown as { markdown(j: unknown, r: unknown, p: unknown): string }).markdown(
    { title: 'job' },
    { seq: 1, mode: 'quick', status: 'completed', exitCode: 0, slopVersion: '0.3.1', verdictJson: null, error: null },
    report,
  );
  const [open, suppressed] = md.split('## Suppressed');
  expect(open).toContain('## P1 (1)');
  expect(open).toContain('m-open');
  expect(open).not.toContain('m-ack');
  expect(suppressed).toContain('m-ack');
  expect(suppressed).toContain('Suppressed (P1): outline replaced by ring');
});
