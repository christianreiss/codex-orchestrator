import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sourceRoot = resolve(import.meta.dirname, '../../../..');
const fixtures: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'instance-cli-'));
  fixtures.push(dir);
  const repo = join(dir, 'checkout');
  cpSync(join(sourceRoot, 'bin'), join(repo, 'bin'), { recursive: true });
  cpSync(join(sourceRoot, 'docker-compose.yml'), join(repo, 'docker-compose.yml'));
  cpSync(join(sourceRoot, 'scripts'), join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'wrappers'));
  cpSync(join(sourceRoot, 'wrappers/Makefile'), join(repo, 'wrappers/Makefile'));
  writeFileSync(join(repo, '.gitignore'), '.env\n.env.local\n.orchestrator.lock\n');
  const data = join(dir, 'data');
  const envFile = `DATA_ROOT=${data}\nAUTH_ENCRYPTION_KEY=fixture-secret\nCOMPOSE_PROFILES=\n`;
  writeFileSync(join(repo, '.env'), envFile);
  const mock = join(dir, 'mock');
  cpSync(join(repo, 'bin/lib'), mock, { recursive: true });
  const docker = join(mock, 'docker');
  // Execute a mock, rather than checking source substrings: arguments,
  // environment, command ordering and real Git state are the contracts.
  writeFileSync(docker, `#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
with open(os.environ['MOCK_LOG'], 'a') as f:
    f.write(json.dumps({'args': a, 'env_file': os.environ.get('ENV_FILE'),
                        'data_root': os.environ.get('DATA_ROOT'),
                        'probe': os.environ.get('PROBE'),
                        'build_commit': os.environ.get('ORCHESTRATOR_BUILD_COMMIT'),
                        'build_dirty': os.environ.get('ORCHESTRATOR_BUILD_DIRTY')}) + '\\n')
if a == ['info']:
    sys.exit(int(os.environ.get('DAEMON_EXIT', '0')))
if a == ['compose', 'version']:
    sys.exit(0)
if 'config' in a and '--services' in a:
    print('api\\nmysql\\nauth-runner\\nmedia-worker\\nquota-cron')
    if 'caddy' in a: print('caddy')
elif 'config' in a:
    os.makedirs(os.environ['DATA_ROOT'] + '/store', exist_ok=True)
    print(json.dumps({'name': 'codex-orchestrator', 'services': {'api': {'volumes': [{'target': '/app/storage',
            'source': os.environ['DATA_ROOT'] + '/store'}]}}}))
elif 'ps' in a and '-q' in a:
    if os.environ.get('EXISTING_API') and 'api' in a: print('previous-api')
    if os.environ.get('EXISTING_CADDY') and a[0]=='compose': print('existing-caddy')
elif 'ps' in a and '--format' in a:
    state = os.environ.get('SERVICE_STATE', 'running')
    rows = [{'Service': s, 'State': state, 'Health': os.environ.get('SERVICE_HEALTH', 'healthy')}
            for s in ['api', 'mysql', 'auth-runner', 'media-worker', 'quota-cron']]
    if os.environ.get('EXISTING_CADDY') or 'caddy' in a:
        rows.append({'Service': 'caddy', 'State': state, 'Health': ''})
    if os.environ.get('MISSING_SERVICE'): rows.pop(0)
    if os.environ.get('PS_ARRAY'): print(json.dumps(rows))
    else:
        for row in rows: print(json.dumps(row))
elif 'exec' in a and 'mysql' in a:
    if '--unbuffered' in a[-1]:
        for line in sys.stdin:
            if 'JSON_OBJECT' in line: print(json.dumps({'database': os.environ.get('DB_DATABASE','codex_auth'), 'tables': 0}), flush=True)
            elif 'DATE_FORMAT' in line: print('2026-10-24T00:00:00.000Z', flush=True)
        sys.exit(0)
    if 'information_schema.tables' in a[-1]: print('4096'); sys.exit(0)
    if os.environ.get('DUMP_EXIT'): sys.exit(int(os.environ['DUMP_EXIT']))
    print('-- fixture SQL')
    if not os.environ.get('INCOMPLETE_DUMP'): print('-- Dump completed on 2026-10-12')
elif 'exec' in a and 'api' in a:
    if os.environ.get('READY_EXIT'): sys.exit(int(os.environ['READY_EXIT']))
    print(json.dumps({'ok': not bool(os.environ.get('NOT_READY')),
                      'checks': [{'id': 'database', 'ok': not bool(os.environ.get('NOT_READY')), 'critical': True}]}))
elif 'up' in a:
    sys.exit(int(os.environ.get('UP_EXIT', '0')))
`);
  chmodSync(docker, 0o755);
  const log = join(dir, 'docker.log');
  const env = { ...process.env, PATH: `${mock}:${process.env.PATH}`, MOCK_LOG: log,
    ENV_FILE: '', COMPOSE_PROFILES: '', ORCHESTRATOR_UPDATE_PHASE: '',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  function git(...args: string[]) {
    const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  }
  git('init', '-b', 'main');
  git('add', 'bin', 'scripts', 'wrappers', 'docker-compose.yml', '.gitignore');
  git('commit', '-m', 'fixture');
  function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync(join(repo, 'bin/orchestrator'), args,
      { cwd: dir, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000 });
  }
  function calls() {
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((s) =>
      JSON.parse(s) as { args: string[]; env_file: string; data_root: string; probe?: string; build_commit?: string; build_dirty?: string }) : [];
  }
  return { dir, repo, data, env, log, git, run, calls };
}

function upstream(f: ReturnType<typeof fixture>, deployExit = 0) {
  // Commit a lightweight deploy fixture. The real helper's contracts are tested
  // separately; this suite checks CLI dispatch and re-exec after Git updates.
  writeFileSync(join(f.repo, 'scripts/deploy.sh'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" > "$MOCK_DEPLOY_LOG"
printf '%s\\n' "$ENV_FILE" >> "$MOCK_DEPLOY_LOG"
exit ${deployExit}
`);
  f.git('add', 'scripts/deploy.sh');
  f.git('commit', '-m', 'deploy fixture');
  const previous = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.repo, 'upstream-marker'), 'next revision');
  // Updated code must run in the very same update, with the inherited lock.
  const cli = join(f.repo, 'bin/orchestrator');
  writeFileSync(cli, readFileSync(cli, 'utf8').replace('Update complete:', 'Updated CLI ran:'));
  f.git('add', 'upstream-marker', 'bin/orchestrator');
  f.git('commit', '-m', 'next');
  const target = f.git('rev-parse', 'HEAD');
  const remote = join(f.dir, 'remote.git');
  const clone = spawnSync('git', ['clone', '--bare', f.repo, remote], { env: f.env, encoding: 'utf8' });
  expect(clone.status, clone.stderr).toBe(0);
  // Only a disposable fixture is reset; never the shared workspace.
  f.git('reset', '--hard', previous);
  return { previous, target, remote, deployLog: join(f.dir, 'deploy.log') };
}

afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('local instance CLI', () => {
  it('shows help without Docker and rejects unknown commands/options', () => {
    const f = fixture();
    expect(f.run(['--help'], { DAEMON_EXIT: '1' }).status).toBe(0);
    expect(f.run(['start', '--help']).status).toBe(0);
    expect(f.calls()).toEqual([]);
    expect(f.run(['unknown']).status).toBe(2);
    expect(f.run(['start', '--json']).status).toBe(2);
    expect(f.run(['update', '--repo-url']).status).toBe(2);
  });

  it('refuses installer wrapper regeneration with an existing API', () => {
    const f = fixture();
    const result = f.run(['setup', '--only', 'wrappers', '--non-interactive'], { EXISTING_API: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('use scripts/deploy.sh');
    expect(f.calls().some(call => call.args.includes('build') || call.args.includes('stop'))).toBe(false);
  });

  it('starts repeatedly and stops all profiles without deleting data', () => {
    const f = fixture();
    expect(f.run(['start']).status).toBe(0);
    expect(f.run(['start']).status).toBe(0);
    expect(f.run(['stop']).status).toBe(0);
    const calls = f.calls();
    expect(calls.filter(c => c.args.includes('up'))).toHaveLength(2);
    const stop = calls.find(c => c.args.includes('stop'))!;
    expect(stop.args).toContain('*');
    expect(calls.some(c => c.args.includes('down') || c.args.includes('rm'))).toBe(false);
    expect(calls.find(c => c.args.includes('up'))!.args).toEqual(expect.arrayContaining([
      '--project-directory', f.repo, '-f', join(f.repo, 'docker-compose.yml'), '-p', 'codex-orchestrator',
      '--no-build', '--wait', '--wait-timeout', '180',
    ]));
  });

  it('loads custom env literally, overrides interpolation and detects old Caddy', () => {
    const f = fixture();
    const path = join(f.repo, '.env.local');
    writeFileSync(path, `DATA_ROOT='${f.data}/custom'\nENV_FILE=./.env\nCOMPOSE_PROFILES=caddy\nPROBE=$(touch ${f.dir}/executed)\n`);
    const r = f.run(['status', '--env-file', '.env.local', '--json'], { DATA_ROOT: '/wrong', PS_ARRAY: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).state).toBe('ready');
    const c = f.calls().find(c => c.args.includes('config'))!;
    expect(c.env_file).toBe(path);
    expect(c.data_root).toBe(`${f.data}/custom`);
    expect(c.probe).toContain('$(touch');
    expect(existsSync(join(f.dir, 'executed'))).toBe(false);
    expect(c.args).toContain('caddy');
    writeFileSync(join(f.repo, '.env'), readFileSync(join(f.repo, '.env'), 'utf8').replace('COMPOSE_PROFILES=\n', ''));
    expect(f.run(['start'], { EXISTING_CADDY: '1' }).status).toBe(0);
    expect(f.calls().filter(c => c.args.includes('up')).at(-1)!.args).toContain('caddy');
  });

  it.each([
    [{ SERVICE_STATE: 'exited' }, 'stopped'],
    [{ MISSING_SERVICE: '1' }, 'partial'],
    [{ SERVICE_HEALTH: 'unhealthy' }, 'unhealthy'],
    [{ NOT_READY: '1' }, 'unhealthy'],
    [{ READY_EXIT: '1' }, 'unhealthy'],
  ])('reports a non-ready status with exit 1: %s', (env, state) => {
    const f = fixture();
    const r = f.run(['status', '--json'], env);
    expect(r.status, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).state).toBe(state);
    expect(f.calls().some(c => c.args.includes('up') || c.args.includes('stop'))).toBe(false);
    expect(existsSync(join(f.repo, '.orchestrator.lock'))).toBe(false);
    expect(r.stdout).not.toContain('fixture-secret');
  });

  it('fails clearly on missing configuration, unavailable Docker and unhealthy start', () => {
    const f = fixture();
    expect(f.run(['start'], { DAEMON_EXIT: '1' }).stderr).toContain('Docker daemon is unreachable');
    const unhealthyStart = f.run(['start'], { UP_EXIT: '7' });
    expect(unhealthyStart.status).toBe(1);
    expect(unhealthyStart.stderr).toContain('exit 7');
    expect(f.run(['start'], { NOT_READY: '1' }).status).toBe(1);
    rmSync(join(f.repo, '.env'));
    const r = f.run(['start']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run bin/orchestrator setup');
  });

  it('forwards setup flags and shares the mutation lock while status stays available', async () => {
    const f = fixture();
    const r = f.run(['setup', '--help']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('--non-interactive');
    expect(f.calls()).toEqual([]);
    writeFileSync(join(f.repo, 'bin/install.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
    const setup = f.run(['setup', '--non-interactive', '--tls', 'none']);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toBe('--non-interactive\n--tls\nnone\n');
    const holder = spawn('flock', [join(f.repo, '.orchestrator.lock'), 'sh', '-c', 'echo locked; cat'], { stdio: 'pipe' });
    try {
      await new Promise<void>((res) => holder.stdout.once('data', () => res()));
      expect(f.run(['stop']).stderr).toContain('another instance command holds');
      expect(f.run(['setup']).status).toBe(1);
      expect(f.run(['status', '--json']).status).toBe(0);
    } finally {
      holder.stdin.end();
      await new Promise<void>((res) => holder.once('exit', () => res()));
    }
  });

  it('persists the TLS profile and preserves unrelated profiles when it is disabled', () => {
    const f = fixture();
    writeFileSync(join(f.repo, '.env'), readFileSync(join(f.repo, '.env'), 'utf8')
      .replace('COMPOSE_PROFILES=', 'COMPOSE_PROFILES=metrics'));
    const acme = f.run(['setup', '--only', 'tls', '--non-interactive', '--tls', 'acme', '--acme-email', 'fixture@example.invalid']);
    expect(acme.status, acme.stderr).toBe(0);
    expect(readFileSync(join(f.repo, '.env'), 'utf8')).toContain('COMPOSE_PROFILES=metrics,caddy');
    const none = f.run(['setup', '--only', 'tls', '--non-interactive', '--tls', 'none'], { EXISTING_CADDY: '1' });
    expect(none.status, none.stderr).toBe(0);
    expect(readFileSync(join(f.repo, '.env'), 'utf8')).toContain('COMPOSE_PROFILES=metrics\n');
    expect(f.run(['start'], { EXISTING_CADDY: '1' }).status).toBe(0);
    expect(f.calls().filter(c => c.args.includes('up')).at(-1)!.args).not.toContain('caddy');
  });

  it('resumes setup with persisted Caddy and uses the selected env file for deployment', () => {
    const f = fixture();
    writeFileSync(join(f.repo, '.env.local'), `DATA_ROOT=${f.data}\nCOMPOSE_PROFILES=caddy\n`);
    const r = f.run(['setup', '--only', 'apptier', '--non-interactive'], { ENV_FILE: '.env.local' });
    expect(r.status, r.stderr).toBe(0);
    const start = f.calls().find(c => c.args.includes('up') && c.args.includes('api'))!;
    expect(start.args).toContain('caddy');
    expect(start.args).toContain('media-worker');
    expect(start.env_file).toBe(join(f.repo, '.env.local'));
    // The real deploy helper fails intentionally at this mock's missing active
    // signer, but its Compose configuration must already be identical.
    const deploy = spawnSync('bash', [join(f.repo, 'scripts/deploy.sh'), '--skip-git', '--no-cleanup'],
      { cwd: f.dir, env: { ...f.env, ENV_FILE: '.env.local' }, encoding: 'utf8', timeout: 15000 });
    expect(deploy.status).not.toBe(0);
    const config = f.calls().filter(c => c.args.includes('config')).at(-1)!;
    expect(config.env_file).toBe(join(f.repo, '.env.local'));
    expect(config.data_root).toBe(f.data);
    expect(config.args).toContain('caddy');
  });

  it.each([false, true])('stamps the sources actually built after a pull (skip git: %s)', (skipGit) => {
    const f = fixture();
    // Ownership changes belong to deployment, not this unprivileged fixture.
    const chown = join(f.dir, 'mock/chown');
    writeFileSync(chown, '#!/bin/sh\nexit 0\n');
    chmodSync(chown, 0o755);
    const previous = f.git('rev-parse', 'HEAD');
    writeFileSync(join(f.repo, 'source-update'), 'new application sources');
    f.git('add', 'source-update');
    f.git('commit', '-m', 'source update');
    const target = f.git('rev-parse', 'HEAD');
    if (!skipGit) {
      const remote = join(f.dir, 'source-remote.git');
      const cloned = spawnSync('git', ['clone', '--bare', f.repo, remote], { env: f.env, encoding: 'utf8' });
      expect(cloned.status, cloned.stderr).toBe(0);
      // Reset only this disposable fixture to exercise a real fast-forward.
      f.git('reset', '--hard', previous);
      f.git('remote', 'add', 'origin', remote);
      f.git('fetch', 'origin');
      f.git('branch', '--set-upstream-to=origin/main', 'main');
    }
    const args = ['--skip-wrappers', '--no-cleanup', '--no-wait', '--service', 'api'];
    if (skipGit) args.push('--skip-git');
    const result = spawnSync('bash', [join(f.repo, 'scripts/deploy.sh'), ...args],
      { cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 15000 });
    expect(result.status, result.stderr).toBe(0);
    expect(f.git('rev-parse', 'HEAD')).toBe(target);
    const build = f.calls().find(c => c.args.includes('build') && c.args.includes('api'))!;
    expect(build).toBeDefined();
    expect(build.build_commit).toBe(target);
    expect(build.build_dirty).toBe('false');
  });

  it('updates from pinned main, backs up privately, re-execs and retries the same revision', () => {
    const f = fixture();
    const u = upstream(f);
    // The github remote is independent of origin/upstream.
    f.git('remote', 'add', 'github', u.remote);
    const r = f.run(['update', '--profile', 'caddy'], { MOCK_DEPLOY_LOG: u.deployLog, SERVICE_STATE: 'running' });
    expect(r.status, r.stderr).toBe(0);
    expect(f.git('rev-parse', 'HEAD')).toBe(u.target);
    expect(r.stderr).toContain('Updated CLI ran:');
    expect(readFileSync(u.deployLog, 'utf8')).toContain('--skip-git --no-cleanup --profile caddy');
    const backups = join(f.data, 'backups');
    const backup = join(backups, readdirSync(backups)[0]!);
    expect(readFileSync(join(backup, 'database.sql'), 'utf8')).toContain('Dump completed');
    expect(readFileSync(join(backup, 'env'), 'utf8')).toContain('fixture-secret');
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    expect(statSync(join(backup, 'env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(backup, 'database.sql')).mode & 0o777).toBe(0o600);
    expect(f.run(['update', '--repo-url', u.remote], { MOCK_DEPLOY_LOG: u.deployLog }).status).toBe(0);
    expect(readdirSync(backups)).toHaveLength(2);
  });

  it.each(['dirty', 'untracked', 'ahead', 'diverged', 'branch'] as const)(
    'refuses %s checkouts before runtime changes', (kind) => {
      const f = fixture();
      const u = upstream(f);
      if (kind === 'dirty') writeFileSync(join(f.repo, 'bin/setup.sh'), 'dirty');
      if (kind === 'untracked') writeFileSync(join(f.repo, 'untracked'), 'local');
      if (kind === 'ahead') f.git('merge', '--ff-only', u.target);
      if (kind === 'ahead' || kind === 'diverged') {
        writeFileSync(join(f.repo, 'local-file'), 'local');
        f.git('add', 'local-file'); f.git('commit', '-m', 'local change');
      }
      if (kind === 'branch') f.git('switch', '-c', 'local');
      const head = f.git('rev-parse', 'HEAD');
      const r = f.run(['update', '--repo-url', u.remote], { MOCK_DEPLOY_LOG: u.deployLog });
      expect(r.status).toBe(1);
      expect(f.git('rev-parse', 'HEAD')).toBe(head);
      expect(f.calls().some(c => c.args.includes('up'))).toBe(false);
      expect(existsSync(u.deployLog)).toBe(false);
    });

  it.each([{ DUMP_EXIT: '5' }, { INCOMPLETE_DUMP: '1' }])('does not advance after backup failure: %s', (env) => {
    const f = fixture();
    const u = upstream(f);
    const r = f.run(['update', '--repo-url', u.remote], { MOCK_DEPLOY_LOG: u.deployLog, ...env });
    expect(r.status).not.toBe(0);
    expect(f.git('rev-parse', 'HEAD')).toBe(u.previous);
    expect(r.stderr).toContain('stage: backup');
    expect(existsSync(u.deployLog)).toBe(false);
  });

  it('reports fetch and deploy failures, preserving the backup and actual checkout revision', () => {
    const f = fixture();
    const u = upstream(f, 9);
    const fetch = f.run(['update', '--repo-url', join(f.dir, 'missing.git')]);
    expect(fetch.status).not.toBe(0);
    expect(fetch.stderr).toContain('stage: fetch');
    expect(f.calls().some(c => c.args.includes('up'))).toBe(false);
    const deploy = f.run(['update', '--repo-url', u.remote], { MOCK_DEPLOY_LOG: u.deployLog });
    expect(deploy.status).toBe(1);
    expect(deploy.stderr).toContain('exit 9');
    expect(deploy.stderr).toContain('stage: deploy');
    expect(deploy.stderr).toContain(u.target);
    expect(f.git('rev-parse', 'HEAD')).toBe(u.target);
    expect(readdirSync(join(f.data, 'backups'))).toHaveLength(1);
    expect(deploy.stderr).not.toContain('Update complete');
  });
});

// Opt-in real Docker control/backup smoke. It uses a small readiness server and
// real MySQL, not provider credentials or the full fleet/wrapper installation.
// Only the fixture's Compose project name changes, to isolate the host's stack.
it.skipIf(process.env.TEST_INSTANCE_DOCKER !== '1')('controls isolated Docker containers and backs up real MySQL during update', () => {
  const f = fixture();
  const project = `instance-cli-${process.pid}-${Date.now()}`;
  const helper = join(f.repo, 'bin/lib/instance-compose.sh');
  writeFileSync(helper, readFileSync(helper, 'utf8').replace('-p codex-orchestrator', `-p ${project}`));
  const nodeImage = readFileSync(join(sourceRoot, 'Dockerfile'), 'utf8').match(/^ARG NODE_IMAGE=(.+)$/m)![1]!;
  const apiDir = join(f.repo, 'smoke-api');
  mkdirSync(apiDir);
  writeFileSync(join(apiDir, 'Dockerfile'), `FROM ${nodeImage}\nCOPY ready.js /ready.js\nCMD ["node", "/ready.js"]\n`);
  writeFileSync(join(apiDir, 'ready.js'), `const server = require('http').createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ok: true, checks: [{id: 'smoke', ok: true, critical: true}]}));
  }).listen(8080, '0.0.0.0');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));\n`);
  writeFileSync(join(f.repo, 'docker-compose.yml'), `services:
  api:
    build: ./smoke-api
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8080/readyz"]
      interval: 1s
      timeout: 2s
      retries: 30
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: smoke-root
      MYSQL_DATABASE: smoke
      MYSQL_USER: smoke
      MYSQL_PASSWORD: smoke-pass
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-psmoke-root"]
      interval: 1s
      timeout: 2s
      retries: 60
  caddy:
    image: ${nodeImage}
    profiles: [caddy]
    command: ["node", "-e", "setInterval(() => {}, 1000)"]
`);
  // Exercise real Docker builds and a schema change in the deploy adapter. The
  // production deploy's signer/provider checks have their own contract tests.
  writeFileSync(join(f.repo, 'scripts/deploy.sh'), `#!/usr/bin/env bash
set -euo pipefail
INSTANCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$INSTANCE_ROOT/bin/lib/instance-compose.sh"
declare -a INSTANCE_PROFILES=()
instance_env_path
instance_compose build
instance_compose exec -T mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "CREATE TABLE IF NOT EXISTS smoke_migration (id INT);"'
instance_compose up -d --wait --wait-timeout 90
`);
  f.git('add', 'bin/lib/instance-compose.sh', 'scripts/deploy.sh', 'docker-compose.yml', 'smoke-api');
  f.git('commit', '-m', 'Docker smoke fixture');
  const previous = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.repo, 'smoke-version'), 'next');
  f.git('add', 'smoke-version'); f.git('commit', '-m', 'Docker update target');
  const target = f.git('rev-parse', 'HEAD');
  const remote = join(f.dir, 'docker-remote.git');
  expect(spawnSync('git', ['clone', '--bare', f.repo, remote], { env: f.env }).status).toBe(0);
  f.git('reset', '--hard', previous);
  const env = { ...f.env, PATH: process.env.PATH };
  const composeArgs = ['compose', '-p', project, '--project-directory', f.repo, '-f', join(f.repo, 'docker-compose.yml')];
  const docker = (args: string[]) => spawnSync('docker', [...composeArgs, ...args],
    { env, encoding: 'utf8', timeout: 150000 });
  const run = (args: string[]) => spawnSync(join(f.repo, 'bin/orchestrator'), args,
    { env, cwd: f.dir, encoding: 'utf8', timeout: 150000 });
  try {
    // Configure using the actual resumable installer, restricted to TLS so this
    // test never seeds fleet credentials or builds the four-platform wrappers.
    const setup = run(['setup', '--only', 'tls', '--non-interactive', '--tls', 'none']);
    expect(setup.status, setup.stderr).toBe(0);
    const built = docker(['build']);
    expect(built.status, built.stderr).toBe(0);
    const start = run(['start']);
    expect(start.status, start.stderr).toBe(0);
    expect(JSON.parse(run(['status', '--json']).stdout).state).toBe('ready');
    const seeded = docker(['exec', '-T', 'mysql', 'sh', '-lc',
      'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "CREATE TABLE smoke_data (value INT); INSERT INTO smoke_data VALUES (42);"']);
    expect(seeded.status, seeded.stderr).toBe(0);
    expect(run(['stop']).status).toBe(0);
    const stopped = run(['status', '--json']);
    expect(stopped.status).toBe(1);
    expect(JSON.parse(stopped.stdout).state).toBe('stopped');
    const update = run(['update', '--repo-url', remote]);
    expect(update.status, update.stderr).toBe(0);
    expect(f.git('rev-parse', 'HEAD')).toBe(target);
    expect(JSON.parse(run(['status', '--json']).stdout).state).toBe('ready');
    const backupDir = join(f.data, 'backups', readdirSync(join(f.data, 'backups'))[0]!);
    expect(readFileSync(join(backupDir, 'database.sql'), 'utf8')).toContain('(42)');
    const checked = docker(['exec', '-T', 'mysql', 'sh', '-lc',
      'mysql -N -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT value FROM smoke_data; SELECT COUNT(*) FROM smoke_migration;"']);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout.trim()).toBe('42\n0');
    expect(run(['stop']).status).toBe(0);
    expect(run(['start']).status).toBe(0);
  } finally {
    const cleanup = docker(['--profile', '*', 'down', '--volumes', '--rmi', 'local']);
    expect(cleanup.status, cleanup.stderr).toBe(0);
  }
}, 240000);
