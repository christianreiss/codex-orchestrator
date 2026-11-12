import { describe, expect, it } from 'vitest';
import { countHostOverrides } from '../../../src/services/host-override-counts.js';

const host = (id: number, autoUpdateOverride: number | null = null, reverseDnsMode: number | null = null) => ({
  id,
  autoUpdateOverride,
  reverseDnsMode,
});

describe('countHostOverrides', () => {
  it('counts host columns that hold an explicit choice, including an explicit off', () => {
    const counts = countHostOverrides([host(1, 0), host(2, 1, 1), host(3)], []);
    expect(counts.auto_update).toBe(2);
    expect(counts.reverse_dns).toBe(1);
  });
  it('counts per-engine RTK and housekeeping overrides of existing hosts only', () => {
    const counts = countHostOverrides(
      [host(1), host(2)],
      [
        { name: 'rtk_claude_host_1', version: '1' },
        { name: 'rtk_claude_host_2', version: '0' },
        { name: 'rtk_codex_host_1', version: '1' },
        { name: 'rtk_codex_host_99', version: '1' }, // host removed
        { name: 'rtk_report_claude_host_1', version: '{}' }, // telemetry, not an override
        { name: 'rtk_grok_host_1', version: '' }, // cleared
        { name: 'session_housekeeping_grok_host_2', version: '{"enabled":true}' },
        { name: 'session_housekeeping_grok', version: '{"enabled":true}' }, // fleet value
        { name: 'rtk_kimi_host_2', version: '1' },
        { name: 'session_housekeeping_kimi_host_1', version: '{"enabled":false}' },
      ],
    );
    expect(counts.rtk).toEqual({ claude: 2, codex: 1, grok: 0, kimi: 1 });
    expect(counts.session_housekeeping).toEqual({ grok: 1, claude: 0, codex: 0, kimi: 1 });
  });
  it('is all zero for an empty fleet', () => {
    expect(countHostOverrides([], [])).toMatchObject({ auto_update: 0, reverse_dns: 0 });
  });
});
