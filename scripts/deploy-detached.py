#!/usr/bin/env python3
"""Run deploy.sh in a systemd-owned process, with durable completion evidence.

The launcher exits after systemd accepts the unit. Inspect result.json (not the
launcher exit code) to determine deployment success. No credentials are stored.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def write_result(path, result):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, indent=2) + '\n')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--supervise', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('deploy_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    deploy_args = args.deploy_args
    if deploy_args[:1] == ['--']:
        deploy_args = deploy_args[1:]
    root = Path(__file__).resolve().parent.parent
    # Fail before systemd acceptance or publication if source provenance cannot
    # be read. HOME/PATH are explicitly retained across the systemd boundary.
    commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    if not args.supervise:
        task_id = str(uuid.uuid4())
        directory = root / 'backups' / 'deployments' / task_id
        directory.mkdir(parents=True, mode=0o700)
        result = directory / 'result.json'
        write_result(result, {'status': 'accepted', 'commit': commit, 'unit': 'cxx-deploy-' + task_id})
        command = ['systemd-run']
        if os.geteuid() != 0:
            command.append('--user')
        command += ['--collect', '--unit=cxx-deploy-' + task_id,
                    '--property=Type=exec', '--working-directory=' + str(root),
                    '--setenv=HOME=' + os.environ['HOME'],
                    '--setenv=PATH=' + os.environ['PATH'],
                    sys.executable, str(Path(__file__).resolve()), '--supervise', str(directory), '--'] + deploy_args
        try:
            subprocess.run(command, check=True)
        except (OSError, subprocess.CalledProcessError) as error:
            write_result(result, {'status': 'failed_to_start', 'commit': commit, 'error': str(error)})
            return 1
        print(json.dumps({'accepted': True, 'commit': commit, 'result': str(result), 'log': str(directory / 'deploy.log')}))
        return 0
    directory = args.supervise.resolve()
    result = directory / 'result.json'
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_result(result, {'status': 'running', 'commit': commit, 'started_at': started})
    code = 1
    error = None
    try:
        with (directory / 'deploy.log').open('ab', buffering=0) as log:
            code = subprocess.run(['bash', str(root / 'scripts/deploy.sh')] + deploy_args,
                                  cwd=root, stdout=log, stderr=subprocess.STDOUT).returncode
    except Exception as failure:
        error = str(failure)
    write_result(result, {'status': 'succeeded' if code == 0 else 'failed', 'exit_code': code,
                          'commit': commit, 'started_at': started,
                          'finished_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          **({'error': error} if error else {})})
    return code


if __name__ == '__main__':
    sys.exit(main())
