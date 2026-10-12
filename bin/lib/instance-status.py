#!/usr/bin/env python3
"""Normalize Compose v2 array/NDJSON output without exposing its environment."""
import json
import sys


def objects(raw):
    if not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else [parsed]
    except json.JSONDecodeError:
        return [json.loads(line) for line in raw.splitlines() if line.strip()]


def main():
    mode, revision, env_path = sys.argv[1:]
    # Input sections are NUL-separated; neither JSON nor service names contain
    # literal NUL bytes. No temp file or secret-bearing environment is needed.
    raw_services, raw_containers, raw_ready = sys.stdin.read().split('\0')
    expected = raw_services.split()
    containers = objects(raw_containers)
    services = []
    for name in sorted(set(expected) | {c['Service'] for c in containers}):
        rows = [c for c in containers if c['Service'] == name]
        if not rows:
            services.append({'service': name, 'state': 'missing', 'health': '', 'configured': name in expected})
        for row in rows:
            services.append({'service': name, 'state': row.get('State', 'unknown'),
                             'health': row.get('Health', ''), 'configured': name in expected})
    try:
        ready = json.loads(raw_ready)
        # Some URL surfaces use the standard response envelope.
        ready = ready.get('data', ready)
        api_ready = ready.get('ok') is True
        checks = [{'id': c['id'], 'ok': c['ok'], 'critical': c.get('critical', False)}
                  for c in ready.get('checks', [])]
    except (ValueError, AttributeError, TypeError, KeyError):
        api_ready = False
        checks = []
    configured_services = [s for s in services if s['configured']]
    if not containers or all(c.get('State') in ('exited', 'created') for c in containers):
        state = 'stopped'
    elif not configured_services or any(s['state'] != 'running' for s in configured_services):
        state = 'partial'
    elif any(s['health'] not in ('', 'healthy') for s in configured_services) or not api_ready:
        state = 'unhealthy'
    else:
        state = 'ready'
    report = {'state': state, 'revision': revision, 'env_file': env_path,
              'services': services, 'api_ready': api_ready, 'checks': checks}
    if mode == 'json':
        print(json.dumps(report))
    else:
        print(f"Instance: {state}\nRevision: {revision}\nEnv file: {env_path}")
        for service in services:
            suffix = '' if service['configured'] else ' (profile disabled or orphan)'
            print(f"  {service['service']}: {service['state']} {service['health']}".rstrip() + suffix)
        print('API readiness: ' + ('ready' if api_ready else 'not ready'))
        for check in checks:
            if check['critical'] and not check['ok']:
                print(f"  Failing critical check: {check['id']}")
    return 0 if state == 'ready' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, TypeError):
        print('Could not parse Docker instance status', file=sys.stderr)
        sys.exit(1)
