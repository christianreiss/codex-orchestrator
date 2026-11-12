import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINES } from '../../../src/util/engine.js';
const root = resolve(import.meta.dirname, '../../../..');

describe('Kimi four-engine operator contracts', () => {
  it.each(['auth-retrieve', 'auth-store', 'sync-bootstrap', 'sync-status', 'versions'])('%s schema accepts every engine wherever engines are enumerated', name => {
    const schema: unknown = JSON.parse(readFileSync(resolve(root, `docs/contracts/${name}.schema.json`), 'utf8'));
    let found = 0;
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      if (Array.isArray(row.enum) && row.enum.includes('codex') && row.enum.includes('grok')) {
        expect(row.enum).toEqual(ENGINES);
        found++;
      }
      for (const child of Object.values(row)) visit(child);
    };
    visit(schema);
    expect(found).toBeGreaterThan(0);
  });
  it('accounts for every residual parity-gate path with a reviewed exemption', () => {
    expect(execFileSync('python3', [resolve(root, 'scripts/check-engine-parity.py')], { cwd: root, encoding: 'utf8' })).toContain('0 untriaged; 0 stale');
  });
  it('verifies deployment publication for every compatibility key', () => {
    const script = readFileSync(resolve(root, 'scripts/deploy.sh'), 'utf8');
    const query = script.split('\n').find(line => line.includes('SELECT CONCAT(name'))!;
    const loop = script.split('\n').find(line => line.includes('for name in wrapper_version_'))!;
    for (const engine of ENGINES) {
      expect(query).toContain(`wrapper_version_${engine}`);
      expect(loop).toContain(`wrapper_version_${engine}`);
    }
  });
});
