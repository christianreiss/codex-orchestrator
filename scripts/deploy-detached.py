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
    parser.add_argument('--source-before-pull', help=argparse.SUPPRESS)
    parser.add_argument('deploy_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    deploy_args = args.deploy_args
    if deploy_args[:1] == ['--']:
        deploy_args = deploy_args[1:]
    root = Path(__file__).resolve().parent.parent
    # Fail before systemd acceptance or publication if source provenance cannot
    # be read. HOME/PATH are explicitly retained across the systemd boundary.
    before = args.source_before_pull if args.supervise else None
    if before is None:
        before = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    provenance = {'source_before_pull': before, 'commit': None}
    if not args.supervise:
        task_id = str(uuid.uuid4())
        directory = root / 'backups' / 'deployments' / task_id
        directory.mkdir(parents=True, mode=0o700)
        result = directory / 'result.json'
        write_result(result, {'status': 'accepted', **provenance, 'unit': 'cxx-deploy-' + task_id})
        command = ['systemd-run']
        if os.geteuid() != 0:
            command.append('--user')
        command += ['--collect', '--unit=cxx-deploy-' + task_id,
                    '--property=Type=exec', '--working-directory=' + str(root),
                    '--setenv=HOME=' + os.environ['HOME'],
                    '--setenv=PATH=' + os.environ['PATH'],
                    sys.executable, str(Path(__file__).resolve()), '--supervise', str(directory),
                    '--source-before-pull', before, '--'] + deploy_args
        try:
            subprocess.run(command, check=True)
        except (OSError, subprocess.CalledProcessError) as error:
            write_result(result, {'status': 'failed_to_start', **provenance, 'error': str(error)})
            return 1
        print(json.dumps({'accepted': True, **provenance, 'result': str(result), 'log': str(directory / 'deploy.log')}))
        return 0
    directory = args.supervise.resolve()
    result = directory / 'result.json'
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_result(result, {'status': 'running', **provenance, 'started_at': started})
    code = 1
    error = None
    try:
        with (directory / 'deploy.log').open('ab', buffering=0) as log:
            code = subprocess.run(['bash', str(root / 'scripts/deploy.sh')] + deploy_args,
                                  cwd=root, stdout=log, stderr=subprocess.STDOUT).returncode
    except Exception as failure:
        error = str(failure)
    # deploy.sh may fast-forward the checkout before building. This is final
    # checkout provenance; verification of a served artifact remains separate.
    after = None
    provenance_error = None
    try:
        after = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
        if not after:
            raise ValueError('Final checkout HEAD is empty')
    except (OSError, subprocess.CalledProcessError, ValueError) as failure:
        provenance_error = str(failure)
    status = 'failed' if code != 0 else 'unknown' if provenance_error else 'succeeded'
    write_result(result, {'status': status, 'exit_code': code, **provenance,
                          'commit': after if status == 'succeeded' else None,
                          'source_after_deploy': after, 'started_at': started,
                          'finished_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          **({'provenance_error': provenance_error} if provenance_error else {}),
                          **({'error': error} if error else {})})
    return code if code != 0 else 1 if provenance_error else 0


if __name__ == '__main__':
    sys.exit(main())
