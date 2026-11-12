#!/usr/bin/env python3
"""Check the reviewed Grok-without-Kimi parity gate against explicit exemptions."""
from pathlib import Path
import re
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ['git', 'grep', '-il', 'grok', '--', '.', ':!*.lock', ':!public/admin/**', ':!CHANGELOG.md'],
        cwd=root, capture_output=True, text=True, check=False,
    )
    if result.returncode not in (0, 1):
        sys.stderr.write(result.stderr)
        return result.returncode
    remaining = {name for name in result.stdout.splitlines() if 'kimi' not in (root / name).read_text().lower()}
    doc = (root / 'docs/interface-ckx.md').read_text().split('\n## Parity exemptions\n', 1)[1]
    exemptions = set(re.findall(r'^\| `([^`]+)` \| .+ \|$', doc, re.MULTILINE))
    uncovered, stale = sorted(remaining - exemptions), sorted(exemptions - remaining)
    for path in uncovered:
        print(f'UNTRIAGED: {path}')
    for path in stale:
        print(f'STALE EXEMPTION: {path}')
    print(f'Kimi parity: {len(remaining)} residual files; {len(exemptions)} explicit exemptions; {len(uncovered)} untriaged; {len(stale)} stale')
    return 1 if uncovered or stale else 0


if __name__ == '__main__':
    sys.exit(main())
