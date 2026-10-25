#!/usr/bin/env python3
"""Bounded, read-only production sample. Never resets performance counters."""
import argparse
import datetime
import json
import hashlib
import re
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


def ensure_sql_observation():
    consumers = dict(row.split("\t") for row in sql("""SELECT NAME, ENABLED
        FROM performance_schema.setup_consumers WHERE NAME IN
        ('global_instrumentation','thread_instrumentation','statements_digest');"""))
    execute = sql("""SELECT ENABLED FROM performance_schema.setup_instruments
        WHERE NAME='statement/com/Execute';""")
    if len(consumers) != 3 or any(value != "YES" for value in consumers.values()) or execute != ["YES"]:
        raise RuntimeError("SQL instrumentation disabled/incomplete; cannot report a quiet sample")


def prepared_statements():
    # Binary-protocol execute() calls are absent from statement digests on the
    # deployed MySQL 8.4. Keep their own counters; never print raw SQL_TEXT.
    rows = sql("""SELECT OBJECT_INSTANCE_BEGIN, STATEMENT_ID, OWNER_THREAD_ID,
        HEX(SQL_TEXT), COUNT_EXECUTE, SUM_TIMER_EXECUTE
        FROM performance_schema.prepared_statements_instances WHERE SQL_TEXT IS NOT NULL;""")
    result = {}
    for line in rows:
        address, statement_id, thread_id, encoded, count, timer = line.split("\t")
        statement = bytes.fromhex(encoded).decode("utf-8", errors="replace")
        result[(address, statement_id, thread_id)] = (statement, int(count), int(timer))
    return result


def prepared_total():
    row = sql("""SELECT COUNT_STAR FROM
        performance_schema.events_statements_summary_global_by_event_name
        WHERE EVENT_NAME='statement/com/Execute';""")
    if len(row) != 1:
        raise RuntimeError("Prepared execution counter unavailable; SQL sample is incomplete")
    return int(row[0])


def prepared_deltas(before, after, tables):
    result = []
    for key, (statement, count, timer) in after.items():
        previous = before.get(key, ("", 0, 0))
        delta = count - previous[1]
        if delta < 0:
            raise RuntimeError("Prepared statement counters reset during sample")
        if not delta:
            continue
        operation = statement.lstrip().split(None, 1)[0].upper()
        if operation not in {"SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE"}:
            operation = "OTHER"
        # Expose only recognised schema identifiers, never query literals or
        # credential-bearing bindings. Object IDs keep reused statement IDs apart.
        words = set(re.findall(r"[A-Za-z_][A-Za-z_0-9]*", statement))
        result.append({"statement": "prepared " + operation,
                       "statement_sha256": hashlib.sha256(statement.encode()).hexdigest(),
                       "tables": sorted(words.intersection(tables)), "count": delta,
                       "seconds": round((timer - previous[2]) / 1e12, 6)})
    return sorted(result, key=lambda row: -row["count"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 300:
        parser.error("--seconds must be 1..300")
    ensure_sql_observation()
    names = ["codex-orchestrator-api-1", "codex-orchestrator-mysql-1"]
    tables = set(sql("SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA='codex_auth';"))
    started = time.monotonic()
    before = {name: process_sample(name) for name in names}
    start_prepared_total = prepared_total()
    start_prepared = prepared_statements()
    start_sql = statements()
    time.sleep(args.seconds)
    end_sql = statements()
    end_prepared = prepared_statements()
    end_prepared_total = prepared_total()
    if end_prepared_total < start_prepared_total:
        raise RuntimeError("Prepared execution counter reset during sample")
    prepared = prepared_deltas(start_prepared, end_prepared, tables)
    prepared_count = end_prepared_total - start_prepared_total
    attributed = sum(row["count"] for row in prepared)
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
        "prepared_sql": prepared,
        "prepared_execution_count": prepared_count,
        "prepared_unattributed_executions": max(0, prepared_count - attributed),
        "prepared_accounting": "Global binary-execute counter includes statements closed/evicted during the window. Per-statement attribution covers retained/new instances only; snapshot boundary races can cause a small difference. On this MySQL these executions are absent from digests; counts remain separate rather than assuming this on every server.",
        "limitations": "Production workload sample, not controlled idle. Network includes transport/health and measurement traffic. SQL digest and separate binary-prepared counters include real mutations, historical reads and external administration; classify each remaining statement before claiming idle acceptance.",
    }
    encoded = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(encoded + "\n")
    print(encoded)


if __name__ == "__main__":
    main()
