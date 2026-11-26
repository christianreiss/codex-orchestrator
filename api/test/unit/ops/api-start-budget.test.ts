import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * The api opens its listener only after owner-state hydration (107-112 s on
 * production, 2026-11-25/26). With the old 20 s start_period, probes at 30, 60
 * and 90 s all counted, Compose marked the container unhealthy at ~90 s and
 * `scripts/deploy.sh` aborted before its verification while the API came up on
 * its own. These numbers live in YAML and three shell scripts, so the
 * inequality between them is asserted here.
 */

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const MEASURED_OWNER_BOOT_SECONDS = 112;

function seconds(value: string | undefined): number {
  expect(value, 'healthcheck duration').toMatch(/^(\d+(?:h|m|s|ms))+$/);
  const unit = { h: 3600, m: 60, s: 1, ms: 0.001 } as const;
  return [...value!.matchAll(/(\d+)(h|ms|m|s)/g)].reduce((sum, [, n, u]) => sum + Number(n) * unit[u as keyof typeof unit], 0);
}

const compose = yaml.load(read('docker-compose.yml')) as {
  services: Record<string, { healthcheck?: Record<string, string | number> }>;
};
const check = compose.services.api!.healthcheck!;
const startPeriod = seconds(String(check.start_period));
const interval = seconds(String(check.interval));
const retries = Number(check.retries);
const waitTimeout = Number(execFileSync('bash', ['-c', 'source "$1"; printf %s "$INSTANCE_API_WAIT_TIMEOUT"', '--',
  resolve(root, 'bin/lib/instance-compose.sh')], { encoding: 'utf8' }));

describe('api startup health budget', () => {
  it('gives owner-state hydration a start period with margin and keeps the steady-state check tight', () => {
    expect(startPeriod).toBeGreaterThanOrEqual(2 * MEASURED_OWNER_BOOT_SECONDS);
    expect(interval).toBeLessThanOrEqual(30);
    expect(seconds(String(check.timeout))).toBeLessThanOrEqual(5);
    expect(retries).toBeLessThanOrEqual(3);
  });

  it('bounds every api wait above the point where Compose itself reports unhealthy', () => {
    expect(Number.isInteger(waitTimeout)).toBe(true);
    expect(waitTimeout).toBeGreaterThan(startPeriod + interval * retries);
  });

  it('uses the shared bound wherever up --wait starts the api', () => {
    expect(read('scripts/deploy.sh')).toContain('up_args+=(--wait --wait-timeout "${INSTANCE_API_WAIT_TIMEOUT}")');
    expect(read('scripts/deploy.sh')).not.toMatch(/--wait-timeout \d/);
    const install = read('bin/install.sh');
    const apptier = install.slice(install.indexOf('step_apptier() {'), install.indexOf('\n}\n', install.indexOf('step_apptier() {')));
    expect(apptier).toContain('--wait --wait-timeout "$INSTANCE_API_WAIT_TIMEOUT"');
    const orchestrator = read('bin/orchestrator');
    expect(orchestrator).toContain('instance_compose up -d --no-build --wait --wait-timeout "$INSTANCE_API_WAIT_TIMEOUT" ||');
    // A literal bound is only for the database tier, which has its own check.
    for (const line of orchestrator.split('\n').filter((l) => /--wait-timeout \d/.test(l)))
      expect(line.trim()).toMatch(/ mysql$/);
  });
});
