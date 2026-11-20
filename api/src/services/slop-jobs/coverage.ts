/**
 * Reduced-coverage note for runs whose sources the deterministic scanner could
 * not read. The scanner itself names the skipped extensions and the extensions
 * its rules cover (vendored patch, see slop-worker/vendor/VENDOR.md); only the
 * run mode, and so what else looked at the skipped files, is known here.
 */
const UNSUPPORTED = /\d+ unsupported extension/;

export const UNSUPPORTED_NOTE: Record<'quick' | 'full', string> = {
  quick:
    'Skipped unsupported sources got no deterministic findings and, in a quick run, no review at all. Run full for an advisor review of them.',
  full: 'Skipped unsupported sources got no deterministic findings; this full run covers them only through the Fleet Advisor review, which is a judgment, not a measurement.',
};

/** Returns a copy of the report with the mode-specific note appended once. */
export function withUnsupportedCoverageNote<R extends { coverage?: unknown }>(report: R, mode: string): R {
  const coverage = Array.isArray(report?.coverage) ? (report.coverage as unknown[]).filter((c): c is string => typeof c === 'string') : [];
  if (!coverage.some((line) => UNSUPPORTED.test(line))) return report;
  const note = UNSUPPORTED_NOTE[mode === 'full' ? 'full' : 'quick'];
  if (coverage.includes(note)) return report;
  return { ...report, coverage: [...coverage, note] };
}
