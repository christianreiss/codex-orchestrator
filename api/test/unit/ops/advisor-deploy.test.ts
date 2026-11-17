import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const helper = resolve(root, 'bin/lib/advisor-deploy.sh');

describe('advisor CA bind refresh on deploy', () => {
  it.each([0, 1])('recreates only an existing running advisor (%s)', (running) => {
    const output = execFileSync('bash', ['-c', `source "$1"; compose=(printf '%s\\n'); advisor_was_running=$2; advisor_deploy_refresh`, '--', helper, String(running)], {
      encoding: 'utf8', env: { ...process.env, ADVISOR_CA_BUNDLE: '/private/custom-ca.pem' },
    });
    expect(output.trim().split('\n').filter(Boolean)).toEqual(running
      ? ['--profile', 'advisor', 'up', '-d', '--no-deps', '--force-recreate', 'advisor'] : []);
  });
  it('keeps custom bundle mounts and verified TLS and does not recreate the whole stack', () => {
    const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('${ADVISOR_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}:/etc/ssl/certs/ca-certificates.crt:ro');
    expect(compose).toContain('SSL_CERT_FILE: /etc/ssl/certs/ca-certificates.crt');
    const deploy = readFileSync(resolve(root, 'scripts/deploy.sh'), 'utf8');
    expect(deploy).toContain('--profile \'*\' ps --status running -q advisor');
    expect(deploy.indexOf('advisor_deploy_refresh\n')).toBeGreaterThan(deploy.indexOf('"${compose[@]}" "${up_args[@]}"'));
    expect(readFileSync(helper, 'utf8')).not.toMatch(/insecure|NODE_TLS_REJECT_UNAUTHORIZED|CURL_INSECURE/);
  });
});
