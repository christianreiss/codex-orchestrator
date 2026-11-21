"""Join actual Go basic-block coverage to CLI cases and local MCP dispatch.

Usage from the root: python3 docs/reports/orchestrator-client-evidence.py UNIT_PROFILE OUTPUT [CLI_PROFILE]
"""

import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

profile, output = map(Path, sys.argv[1:3])
cli_profile = Path(sys.argv[3]) if len(sys.argv) == 4 else None
rows = list(csv.DictReader(Path("docs/reports/orchestrator-entrypoints.tsv").open(), delimiter="\t"))
module = Path("wrappers/cxx/go.mod").read_text().splitlines()[0].split()[1]


def read_blocks(source):
    blocks = {}
    for line in source.read_text().splitlines():
        match = re.fullmatch(re.escape(module) + r"/([^:]+):(\d+)\.(\d+),\d+\.\d+ \d+ (\d+)", line)
        if match:
            name, row, column, hits = match.groups()
            key = (f"wrappers/cxx/{name}", int(row), int(column))
            blocks[key] = max(blocks.get(key, 0), int(hits))
    if not blocks:
        raise SystemExit(f"No wrapper coverage blocks in {source}")
    return blocks


def evidence(label, labels, counters, key):
    if label not in labels:
        return "unresolved dispatch"
    if key not in counters:
        return "no matching cover block"
    if counters[key] == 0:
        return "case unentered"
    return "case entered" if len(labels) == 1 else "shared case entered"


blocks = read_blocks(profile)
cli_blocks = read_blocks(cli_profile) if cli_profile else {}

# The inventory records the exact source line for each CLI case. For MCP it
# records the discovery schema; resolve the callMCPTool dispatch separately.
case_pattern = re.compile(r'^\s*case\s+((?:"(?:[^"\\]|\\.)*"\s*,?\s*)+):')


def case_at(text):
    case = case_pattern.match(text)
    if case:
        labels = [json.loads(q) for q in re.findall(r'"(?:[^"\\]|\\.)*"', case[1])]
        # cmd/cover starts a case block immediately after its colon (1-based bytes).
        return labels, len(text[:case.end()].encode()) + 1
    return [], None


mcp = "wrappers/cxx/internal/agentbus/mcp.go"
mcp_cases = {}
lines = Path(mcp).read_text().splitlines()
inside = False
for n, line in enumerate(lines, start=1):
    if line.startswith("func "):
        inside = line.startswith("func callMCPTool(")
    if not inside or not line.startswith("\tcase "):
        continue
    labels, column = case_at(line)
    for label in labels:
        if label in mcp_cases:
            raise SystemExit(f"Non-unique MCP dispatcher for {label}")
        mcp_cases[label] = (n, labels, column)

results = []
counts = Counter()
for r in rows:
    kind, label, origin = r["Entry kind"], r["Entry or action"], r["Registration / source"]
    if kind not in {"CLI switch / option", "Local MCP"}:
        continue
    path, line = origin.rsplit(":", 1)
    n = int(line)
    if kind == "Local MCP":
        path = mcp
        n, labels, column = mcp_cases.get(label, (0, [], None))
    else:
        text = Path(path).read_text().splitlines()[n - 1]
        labels, column = case_at(text)
    key = (path, n, column)
    state = evidence(label, labels, blocks, key)
    cli_state = evidence(label, labels, cli_blocks, key) if cli_profile else "no CLI run supplied"
    counts[kind, "Go suite", state] += 1
    counts[kind, "CLI run", cli_state] += 1
    results.append((kind, label, origin, f"{path}:{n}" if n else "-", ", ".join(labels) or "-", state, cli_state))
with output.open("w") as f:
    writer = csv.writer(f, delimiter="\t", lineterminator="\n")
    writer.writerow(("Surface", "Option or tool", "Inventory registration", "Dispatch case", "Case labels", "Go suite evidence", "CLI run evidence"))
    writer.writerows(sorted(results))
for key, n in sorted(counts.items()):
    print(*key, n, sep=" | ")
