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
