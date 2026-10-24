import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(failure = '', noBackup = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-'));
  fixtures.push(dir);
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'store'));
  writeFileSync(join(dir, 'store', 'receipt'), 'durable receipt');
  writeFileSync(join(dir, 'runtime.env'), 'PRIVATE_TEST_VALUE=secret');
  writeFileSync(
    join(dir, 'bin', 'docker'),
    `#!/usr/bin/env python3
import os,sys,json,datetime
from pathlib import Path
p=Path(os.environ['FIXTURE']); a=sys.argv[1:]
with open(p/'calls','a') as f: f.write(' '.join(a)+'\\n')
if a[0]=='config': print(json.dumps({'name':'test','services':{'api':{'environment':{'PRIVATE_TEST_VALUE':'private-config'},'user':str(os.getuid())+':'+str(os.getgid()),'volumes':[{'target':'/app/storage','source':str(p/'store')}]}}}))
elif a[0]=='ps':
 if os.environ['FAILURE']=='discovery': sys.exit(8)
 if 'label=com.docker.compose.service=api' in a and not (p/'stopped').exists(): print('previous-api')
elif a[0]=='inspect': print('sha256:old' if '--format' in a else json.dumps([{'Mounts':[{'Destination':'/app/storage','Source':str(p/('wrong-store' if os.environ['FAILURE']=='mismatch' else 'store'))}], 'Config':{'Env':['PRIVATE_TEST_VALUE=private-container']}}]))
elif a[0]=='stop': (p/'stopped').touch()
elif a[0]=='start': (p/'resumed').touch()
elif a[0]=='exec':
 if '--unbuffered' in a[-1]:
  for line in sys.stdin:
   if 'SELECT JSON_OBJECT' in line: print(json.dumps({'database':'test','tables':0}),flush=True)
   elif 'DATE_FORMAT' in line: print(datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),flush=True)
   elif 'UNLOCK TABLES' in line: break
  sys.exit(0)
 if 'SUM(data_length + index_length)' in a[-1]: print('4096'); sys.exit(0)
 if os.environ['FAILURE']=='dump' and 'mysqldump' in a[-1]: sys.exit(9)
 print('CREATE DATABASE test;')
`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "$HELPER"; INSTANCE_ROOT="$FIXTURE"; ENV_PATH="$FIXTURE/runtime.env"; INSTANCE_COMPOSE=(docker); owner_cutover_prepare || exit $?; owner_cutover_phase changing; [[ "$FAILURE" != after ]]`,
    ],
    {
      env: {
        ...process.env,
        FIXTURE: dir,
        FAILURE: failure,
        OWNER_CUTOVER_NO_BACKUP: noBackup ? '1' : '0',
        CODEX_DEPLOY_BACKUP_RESERVE_BYTES: failure === 'space' ? '999999999999999' : '1073741824',
        HELPER: join(root, 'bin/lib/owner-cutover.sh'),
        PATH: `${dir}/bin:${process.env.PATH}`,
      },
      encoding: 'utf8',
    },
  );
  const base = join(dir, noBackup ? 'cutovers' : 'backups');
  const bundle = join(base, readdirSync(base)[0]!);
  return { dir, bundle, result, calls: readFileSync(join(dir, 'calls'), 'utf8') };
}
describe('quiescent owner cutover', () => {
  it('prepares one private lock inode and preserves an existing kernel lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cutover-lock-'));
    fixtures.push(dir);
    const result = spawnSync(
      'python3',
      [
        '-c',
        `
import fcntl, os, pathlib, stat, subprocess, sys
root=pathlib.Path(sys.argv[1]); lock=root/'.control-plane-owner.lock'
lock.write_bytes(b'preserve existing inode')
with lock.open('r+b') as owner:
 fcntl.flock(owner,fcntl.LOCK_EX|fcntl.LOCK_NB)
 before=os.fstat(owner.fileno()).st_ino
 subprocess.run(['bash','-c','source "$HELPER"; owner_cutover_storage_lock "$STORE" "$API_USER"'],check=True)
 assert lock.stat().st_ino==before
 assert lock.read_bytes()==b'preserve existing inode'
 assert stat.S_IMODE(lock.stat().st_mode)==0o600
 assert (lock.stat().st_uid,lock.stat().st_gid)==(os.getuid(),os.getgid())
 with lock.open('r+b') as competitor:
  try: fcntl.flock(competitor,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: pass
  else: raise AssertionError('existing lock was replaced or lost')
link=root/'symlink-store'; link.mkdir(); (link/'.control-plane-owner.lock').symlink_to(lock)
denied=subprocess.run(['bash','-c','source "$HELPER"; owner_cutover_storage_lock "$STORE/symlink-store" "$API_USER"'],capture_output=True)
assert denied.returncode!=0
assert lock.read_bytes()==b'preserve existing inode'
`,
        dir,
      ],
      {
        env: {
          ...process.env,
          HELPER: join(root, 'bin/lib/owner-cutover.sh'),
          STORE: dir,
          API_USER: `${process.getuid!()}:${process.getgid!()}`,
        },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
  });
  it('stops the exact old writer before snapshot and protects rollback secrets', () => {
    const { bundle, result, calls } = fixture();
    expect(result.status, result.stderr).toBe(0);
    expect(calls.indexOf('stop --timeout 120 previous-api')).toBeLessThan(calls.indexOf('mysqldump -uroot'));
    expect(calls).toContain('tag sha256:old codex-orchestrator/rollback:api-');
    expect(statSync(bundle).mode & 0o777).toBe(0o700);
    for (const file of ['database.sql', 'compose.json', 'runtime.env', 'store.tar.gz'])
      expect(statSync(join(bundle, file)).mode & 0o077).toBe(0);
    expect(readFileSync(join(bundle, 'phase'), 'utf8')).toBe('changing\n');
  });
  it('quiesces explicitly without archives, credential copies or backup sizing', () => {
    const { bundle, result, calls } = fixture('dump', true);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('stop --timeout 120 previous-api');
    expect(calls).toContain('tag sha256:old codex-orchestrator/rollback:api-');
    expect(calls).not.toContain('SUM(data_length + index_length)');
    expect(calls).not.toContain('mysqldump');
    for (const file of ['database.sql', 'store.tar.gz', 'runtime.env', 'space-budget.txt', 'SHA256SUMS'])
      expect(existsSync(join(bundle, file))).toBe(false);
    expect(readFileSync(join(bundle, 'compose.json'), 'utf8')).not.toContain('environment');
    expect(readFileSync(join(bundle, 'compose.json'), 'utf8')).not.toContain('private-config');
    expect(readFileSync(join(bundle, 'container-api-previous-api.json'), 'utf8')).not.toContain('Env');
    expect(readFileSync(join(bundle, 'container-api-previous-api.json'), 'utf8')).not.toContain('private-container');
    expect(readFileSync(join(bundle, 'no-backup'), 'utf8')).toBe('1\n');
    expect(result.stderr).toContain('no DB/storage rollback copy');
  });
  it('rejects conflicting explicit backup flags before deployment', () => {
    const result = spawnSync('bash', [join(root, 'scripts/deploy.sh'), '--backup', '--no-backup'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--backup and --no-backup are mutually exclusive');
  });
  it('resumes the previous writer if backup fails, including conditional callers', () => {
    const { result, calls, bundle } = fixture('dump');
    expect(result.status).toBe(9);
    expect(existsSync(join(bundle, 'database.sql.tmp'))).toBe(false);
    expect(calls).toContain('start previous-api');
  });
  it('rejects a changed storage target before stopping the old API', () => {
    const { result, calls } = fixture('mismatch');
    expect(result.status).toBe(1);
    expect(calls).not.toContain('stop --timeout');
  });
  it('rejects insufficient backup headroom before stopping writers', () => {
    const { result, calls } = fixture('space');
    expect(result.status).toBe(1);
    expect(calls).not.toContain('stop --timeout');
    expect(calls).not.toContain('mysqldump -uroot');
  });
  it('fails closed when writer discovery fails', () => {
    const { result, calls } = fixture('discovery');
    expect(result.status).toBe(8);
    expect(calls).not.toContain('mysqldump -uroot');
    expect(calls).not.toContain('stop --timeout');
  });
  it('does not restart an old writer automatically after durable changes begin', () => {
    const { result, calls } = fixture('after');
    expect(result.status).toBe(1);
    expect(calls).not.toContain('start previous-api');
  });
});
