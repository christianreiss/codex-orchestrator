#!/usr/bin/env python3
"""Freeze legacy grant admission, stop writers, and retain exact drain eligibility.

The READ locks are a deployment barrier, not a grant: current lifecycle state and
fresh authenticated native proof still decide permission after boot.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

MAX_BYTES = 32 * 1024 * 1024
MAX_ROWS = 100000


def instant(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def run(command):
    return subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=130).stdout.strip()


def stop_writers(args):
    images = Path(args.journal, 'previous-images.tsv')
    media = {row.split('\t')[1] for row in images.read_text().splitlines()
             if row.startswith('media-worker\t')} if images.exists() else set()
    for container in Path(args.writers).read_text().splitlines():
        if container:
            # Python installs a SIGINT handler; a Python PID 1 can ignore the
            # default SIGTERM and otherwise stalls a cutover for 120 seconds.
            signal_args = ['--signal', 'SIGINT'] if container in media else []
            run(['docker', 'stop', *signal_args, '--timeout', '120', container])
    for service in ['api', 'quota-cron', 'media-worker']:
        if run(['docker', 'ps', '-q', '--filter', f'label=com.docker.compose.project={args.project}',
                '--filter', f'label=com.docker.compose.service={service}']):
            raise RuntimeError('a previous writer is still running')


def capture(args):
    target = Path(args.store) / '.control-plane-legacy-drain.json'
    # A completed cutover's immutable eligibility list survives later restarts.
    # Never enlarge it with agents that arrived after the original boundary.
    if target.exists() or target.is_symlink():
        stop_writers(args)
        return
    command = args.compose + ['exec', '-T', 'mysql', 'sh', '-lc',
        'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --batch --raw --skip-column-names '
        '--unbuffered --skip-reconnect "$MYSQL_DATABASE"']
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    pending = None
    published = False
    try:
        signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('capture timed out')))
        signal.alarm(45)
        def send(sql):
            proc.stdin.write(sql + '\n')
            proc.stdin.flush()
        def line():
            value = proc.stdout.readline(MAX_BYTES + 1)
            if not value or len(value.encode()) > MAX_BYTES:
                raise RuntimeError('incomplete or oversized eligibility capture')
            return value.strip()
        send("SELECT JSON_OBJECT('database', DATABASE(), 'tables', COUNT(*)) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('agent_resource_claims','git_worktrees','agent_sessions','agent_native_controls','hosts','versions');")
        probe = json.loads(line())
        if probe['tables'] not in [0, 6]:
            raise RuntimeError('incomplete legacy coordination schema')
        entries = []
        if probe['tables'] == 6:
            # All grant, binding, credential and policy writes wait at this
            # barrier. It remains held until every previous writer has stopped.
            send('SET SESSION lock_wait_timeout=15; LOCK TABLES agent_resource_claims AS c READ, git_worktrees AS g READ, agent_sessions AS s READ, agent_native_controls AS n READ, hosts AS h READ, versions AS v READ;')
        send("SET @capture_at=UTC_TIMESTAMP(3); SELECT DATE_FORMAT(@capture_at,'%Y-%m-%dT%H:%i:%s.%fZ');")
        captured_at = line()
        captured_ms = instant(captured_at)
        if probe['tables'] == 6:
            session = "JSON_ARRAY(s.id,s.host_id,s.username,s.engine,s.binding_generation,s.bridge_token_hash,s.host_auth_fingerprint,s.expires_at,n.instance_id,n.binding_generation,h.ip4,h.ip6,h.allow_roaming_ips,h.reverse_dns_mode,h.secure,IF(h.reverse_dns_mode IS NULL,(SELECT v.version FROM versions v WHERE v.name='reverse_dns_enabled'),NULL))"
            security = "JSON_ARRAY(s.expires_at,h.expires_at,IF(h.secure=1,NULL,DATE_FORMAT(h.insecure_enabled_until,'%Y-%m-%dT%H:%i:%sZ')))"
            joined = "JOIN agent_sessions s ON s.id={session} JOIN agent_native_controls n ON n.session_id=s.id AND n.binding_generation=s.binding_generation JOIN hosts h ON h.id=s.host_id"
            eligible = "s.ended_at IS NULL AND n.status<>'exited' AND COALESCE(JSON_EXTRACT(s.adapter_capabilities,'$.control_state_protocol'),0)<>1 AND (h.secure=1 OR h.insecure_enabled_until>@capture_at)"
            queries = [
                ('resource', 'agent_resource_claims c', 'c', 'c.session_id',
                 "JSON_ARRAY(c.session_id,c.generation,NULL,'timed',c.request_id,c.resources,c.created_at)",
                 "c.state='active' AND c.generation=s.binding_generation"),
                ('git', 'git_worktrees g', 'g', 'g.agent_session_id',
                 "JSON_ARRAY(g.agent_session_id,g.agent_binding_generation,NULL,'timed',g.host_id,g.username,g.engine,g.clone_id,g.worktree_path,g.worktree_hash,g.registered_at)",
                 "g.status='active' AND g.released_at IS NULL AND g.agent_binding_generation=s.binding_generation"),
            ]
            size = 0
            for kind, table, alias, session_id, identity, predicate in queries:
                send(f"SELECT JSON_OBJECT('kind','{kind}','id',{alias}.id,'identity',{identity},'session',{session},'security',{security},'expiresAt',{alias}.expires_at) FROM {table} {joined.format(session=session_id)} WHERE {predicate} AND {eligible} LIMIT {MAX_ROWS + 1}; SELECT 'CAPTURE_END';")
                count = 0
                while True:
                    raw = line()
                    if raw == 'CAPTURE_END':
                        break
                    count += 1
                    size += len(raw.encode())
                    if count > MAX_ROWS or size > MAX_BYTES:
                        raise RuntimeError('legacy eligibility capture exceeds bound')
                    row = json.loads(raw)
                    expires = instant(row.pop('expiresAt'))
                    security_times = [instant(v) for v in row.pop('security') if v is not None]
                    deadline = min(security_times) if security_times else None
                    if expires <= captured_ms or deadline is not None and deadline <= captured_ms:
                        continue
                    row['securityDeadline'] = deadline
                    entries.append(row)
                    if len(entries) > MAX_ROWS:
                        raise RuntimeError('legacy eligibility capture exceeds row bound')
        signal.alarm(0)
        manifest = {'version': 1, 'database': probe['database'], 'capturedAt': captured_at, 'entries': entries}
        data = json.dumps(manifest, separators=(',', ':')).encode()
        if len(data) > MAX_BYTES:
            raise RuntimeError('legacy eligibility manifest exceeds byte bound')
        stop_writers(args)
        if proc.poll() is not None:
            raise RuntimeError('database capture barrier was lost before writer shutdown')
        # No listener can observe this eligibility list until all old writers
        # are stopped. Its publication is atomic and its directory is trusted.
        fd, pending = tempfile.mkstemp(prefix='.legacy-drain-', dir=args.store)
        try:
            parts = args.user.split(':')
            os.fchown(fd, int(parts[0]), int(parts[-1]))
            with os.fdopen(fd, 'wb') as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.link(pending, target)
            published = True
            Path(args.journal, 'legacy-drain-created').write_text(str(target))
            directory = os.open(args.store, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            os.unlink(pending)
            pending = None
        send('UNLOCK TABLES;')
        proc.stdin.close()
        if proc.wait(timeout=10) != 0:
            raise RuntimeError('database capture did not finish cleanly')
        print(f'[cutover] retained {len(entries)} existing legacy grants for explicit drain', flush=True)
    except BaseException:
        if published:
            target.unlink(missing_ok=True)
        raise
    finally:
        signal.alarm(0)
        if pending:
            Path(pending).unlink(missing_ok=True)
        if proc.poll() is None:
            proc.kill()
        proc.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for option in ['store', 'writers', 'project', 'user', 'journal']:
        parser.add_argument('--' + option, required=True)
    parser.add_argument('compose', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.compose and args.compose[0] == '--':
        args.compose.pop(0)
    try:
        capture(args)
    except Exception as error:
        # Never echo SQL, connection environment or captured credential hashes.
        raise SystemExit(f'[cutover] legacy capture failed ({type(error).__name__}); old writer recovery remains with the cutover helper')
