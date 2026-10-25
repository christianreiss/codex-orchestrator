#!/usr/bin/env python3
"""Bounded, read-only production sample. Never resets performance counters."""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import time


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def sql(statement):
    return subprocess.check_output(
        ["docker", "exec", "-i", "codex-orchestrator-mysql-1", "sh", "-c",
         'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot codex_auth -N -r --batch'],
        input=statement, text=True,
    ).splitlines()


def process_sample(name):
    pid = docker("inspect", "--format", "{{.State.Pid}}", name)
    group = Path(f"/proc/{pid}/cgroup").read_text().strip().split("::")[-1]
    stats = dict(line.split() for line in Path(f"/sys/fs/cgroup{group}/cpu.stat").read_text().splitlines())
    interfaces = Path(f"/proc/{pid}/net/dev").read_text().splitlines()[2:]
    rx = tx = 0
    for line in interfaces:
        interface, raw = line.split(":", 1)
        if interface.strip() == "lo":
            continue
        fields = raw.split()
        rx += int(fields[0])
        tx += int(fields[8])
    return {"pid": int(pid), "cpu_us": int(stats["usage_usec"]), "rx": rx, "tx": tx}


def statements():
    rows = sql("""SELECT DIGEST, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT,
        SUM_ROWS_EXAMINED FROM performance_schema.events_statements_summary_by_digest
        WHERE SCHEMA_NAME='codex_auth' AND DIGEST IS NOT NULL;""")
    result = {}
    for line in rows:
        digest, text, count, timer, examined = line.split("\t", 4)
        # Exclude only this diagnostic's own queries, not application SELECTs.
        if "performance_schema" in text or "information_schema" in text or "version_comment" in text:
            continue
        result[digest] = (text, int(count), int(timer), int(examined))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 300:
        parser.error("--seconds must be 1..300")
    names = ["codex-orchestrator-api-1", "codex-orchestrator-mysql-1"]
    before = {name: process_sample(name) for name in names}
    start_sql = statements()
    started = time.monotonic()
    time.sleep(args.seconds)
    end_sql = statements()
    after = {name: process_sample(name) for name in names}
    elapsed = time.monotonic() - started
    if any(before[name]["pid"] != after[name]["pid"] for name in names):
        raise RuntimeError("Container restarted during sample; repeat after recovery")
    deltas = []
    for digest, (text, count, timer, examined) in end_sql.items():
        previous = start_sql.get(digest, ("", 0, 0, 0))
        count -= previous[1]
        if count < 0:
            raise RuntimeError("SQL counters reset during sample")
        if count:
            deltas.append({"statement": text, "count": count,
                           "seconds": round((timer - previous[2]) / 1e12, 6),
                           "rows_examined": examined - previous[3]})
    result = {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "host": subprocess.check_output(["hostname", "-f"], text=True).strip(),
        "image": docker("inspect", "--format", "{{.Image}}", names[0]),
        "seconds": round(elapsed, 3),
        "cpu_percent_one_core": {name: round((after[name]["cpu_us"] - before[name]["cpu_us"]) / elapsed / 10000, 3) for name in names},
        "network_bytes": {name: {direction: after[name][direction] - before[name][direction] for direction in ("rx", "tx")} for name in names},
        "sql": sorted(deltas, key=lambda row: -row["count"]),
        "limitations": "Production workload sample, not controlled idle. Network includes transport/health and measurement traffic. SQL digest counters include real mutations, historical reads and external administration; classify each remaining statement before claiming idle acceptance.",
    }
    encoded = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(encoded + "\n")
    print(encoded)


if __name__ == "__main__":
    main()
