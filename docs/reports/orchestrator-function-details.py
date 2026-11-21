"""Export one row per registered entry by joining the reviewed family and runtime registers."""

import csv
from collections import defaultdict
from pathlib import Path

REPORTS = Path(__file__).resolve().parent


def records(filename):
    with (REPORTS / filename).open(newline="") as source:
        return list(csv.DictReader(source, delimiter="\t"))


def families():
    result = {}
    for line in (REPORTS / "orchestrator-functional-matrix.md").read_text().splitlines():
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) == 9 and cells[0].isupper():
            result[cells[0]] = cells
    return result


def observed_calls(row):
    evidence = []
    for key, value in row.items():
        if key == "responses after original handler":
            name = "canonical"
        elif key.endswith(" responses after original handler"):
            name = key.removesuffix(" responses after original handler")
        else:
            continue
        if value and value != "-":
            evidence.append(f"{name} {value}")
    return " / ".join(evidence) or "No HTTP response attributed to an original handler in these traces"


def main():
    family = families()
    http = {r["method and registered pattern"]: r for r in records("orchestrator-http-trace.tsv")}
    cli = {
        (r["Surface"], r["Option or tool"], r["Inventory registration"]): r
        for r in records("orchestrator-client-evidence.tsv")
    }
    operator = defaultdict(list)
    for r in records("orchestrator-admin-roundtrip.tsv"):
        operator[f"{r['Method']} {r['Registered pattern']}"].append(r)
    head_checks = {
        f"{r['Method']} {r['Registered pattern']}": r["Verified protocol outcome"]
        for r in records("orchestrator-admin-roundtrip-head.tsv")
    }
    mcp = defaultdict(list)
    for r in records("orchestrator-mcp-receipts.tsv"):
        mcp[(r["Namespace"], r["Tool"])].append(r)
    operator_tools = defaultdict(list)
    for source in ("orchestrator-operator-mcp.tsv", "orchestrator-mcp-completion.tsv"):
        for receipt in records(source):
            operator_tools[receipt["Tool"]].append({**receipt, "Evidence file": source})
    entries = records("orchestrator-entrypoints.tsv")
    headings = (
        "Family", "Entry kind", "Function or action", "User goal (family)", "Entry point",
        "API, service or dispatch", "Persistence (family)", "Downstream consumer (family)",
        "Feedback and recovery contract (family)", "Rights and engine scope", "Operator success observed",
        "Operator failure or recovery observed", "Runtime evidence for this entry", "Proof and boundary",
        "Product decision",
    )
    with (REPORTS / "orchestrator-functions.tsv").open("w", newline="") as target:
        out = csv.writer(target, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_ALL)
        out.writerow(headings)
        for entry in entries:
            key = entry["Entry or action"]
            group = family[entry["Family"]]
            kind = entry["Entry kind"]
            location = entry["Registration / source"]
            proof = entry["Evidence"]
            runtime = "See family evidence for the end-to-end scenario"
            successes, failures = [], []
            if kind == "HTTP":
                route = http[key]
                runtime = observed_calls(route)
                proof = "orchestrator-http-trace.tsv (source and transport attribution)"
                if key in head_checks:
                    runtime += ". HEAD check: " + head_checks[key]
                    proof += " / orchestrator-admin-roundtrip-head.tsv (HTTP protocol assertion)"
                for receipt in operator.get(key, []):
                    code = int(receipt["HTTP status"])
                    observation = f"{receipt['Identity']}, {code}, {receipt['Verified business outcome']}"
                    (successes if 200 <= code < 300 else failures).append(observation)
                if successes or failures:
                    proof += " / orchestrator-admin-roundtrip.tsv (named workflow assertions)"
            elif (kind, key) in mcp:
                named = mcp[(kind, key)]
                runtime = " / ".join(f"{r['Revision']}: {r['Named result']}" for r in named)
                proof = "orchestrator-mcp-receipts.tsv / " + " / ".join(dict.fromkeys(r["Source"] for r in named))
            elif kind in ("CLI switch / option", "Local MCP"):
                case = cli[(kind, key, location)]
                runtime = f"Go suite: {case['Go suite evidence']}. CLI profile: {case['CLI run evidence']}."
                proof = "orchestrator-client-evidence.tsv (individual and shared Go case counters)"
            if kind == "Fleet MCP" and key in operator_tools:
                for receipt in operator_tools[key]:
                    successes.append(f"{receipt['Identity']}: {receipt['Verified scenario outcome']}")
                locations = dict.fromkeys(r["Source"] for r in operator_tools[key])
                proof += " / " + " / ".join(dict.fromkeys(r["Evidence file"] for r in operator_tools[key])) + " / " + " / ".join(locations)
            out.writerow((
                group[0], kind, key, group[1], location, entry["Effect or dispatch"], group[3],
                group[4], group[5], entry["Guard / scope"] + " / " + group[6],
                " / ".join(dict.fromkeys(successes)), " / ".join(dict.fromkeys(failures)),
                runtime, proof + " / " + group[7], entry["Family product decision"],
            ))
    print(f"{len(entries)} registered entries joined to {len(family)} family contracts")


if __name__ == "__main__":
    main()
