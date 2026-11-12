// Run from the repository root: api/node_modules/.bin/tsx wrappers/cxx/internal/kimi/testdata/generate.mts
// Real API renderer/usage serializers at base 1d42130cc; synthetic endpoints and account.
import { writeFileSync } from 'node:fs';
import { normalizeKimiSettings, renderKimiSettings } from '../../../../../api/src/services/client-config.js';
import { readKimiUsage, kimiUsageAuthFields } from '../../../../../api/src/services/kimi-usage.js';
const settings = normalizeKimiSettings({
  mcp_servers: [
    { name: 'fleet', url: 'https://fleet.invalid/mcp', http_headers: { 'X-API-Key': 'fixture-only' } },
    { name: 'local', command: '/usr/bin/example-mcp', args: ['--stdio'], env: { MODE: 'fixture' } },
  ],
});
writeFileSync(new URL('server-sync.toml', import.meta.url), renderKimiSettings(settings));
const row = {
  accountId: 7, planName: 'Moderato', planFetchedAt: '2099-01-01T00:00:00.000Z', planErrorCode: null,
  fiveHourUsedPercent: 38.25, fiveHourResetsAt: '2099-01-01T05:00:00.000Z',
  weeklyUsedPercent: 62.5, weeklyResetsAt: '2099-01-08T00:00:00.000Z',
  monthTotalUsedPercent: 21, monthTotalResetsAt: '2099-02-01T00:00:00.000Z',
  monthCodeUsedPercent: 13.75, monthCodeResetsAt: null,
  fetchedAt: '2099-01-01T00:00:00.000Z', checkedAt: '2099-01-01T00:00:01.000Z', errorCode: null,
};
const reader = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) };
const reading = await readKimiUsage(reader as never, 7);
writeFileSync(new URL('server-lease.json', import.meta.url), JSON.stringify({ account_id: 7, verification_state: 'verified', usage: reading }, null, 2) + '\n');
writeFileSync(new URL('server-usage.json', import.meta.url), JSON.stringify({ kimi_usage: kimiUsageAuthFields(reading) }, null, 2) + '\n');
