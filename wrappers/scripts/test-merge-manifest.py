#!/usr/bin/env python3
"""Regression: release history is immutable and malformed history fails closed."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def stage_payload(manifest: Path, version: str, marker: bytes) -> tuple[str, int]:
    payload = marker + b":" + version.encode()
    binary = manifest.parent / f"v{version}" / "cxx"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest(), len(payload)


def publish(
    script: Path,
    manifest: Path,
    version: str,
    marker: bytes,
    *,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    digest, size = stage_payload(manifest, version, marker)
    return subprocess.run(
        [
            sys.executable,
            str(script),
            str(manifest),
            "cxx",
            "linux",
            "amd64",
            version,
            digest,
            str(size),
            f"2026-07-{int(version.rsplit('.', 1)[1]) + 1:02d}T00:00:00Z",
        ],
        check=check,
        text=True,
        capture_output=not check,
    )


def assert_rejected(script: Path, manifest: Path, malformed: dict[str, object], label: str) -> None:
    raw = json.dumps(malformed, indent=2) + "\n"
    manifest.write_text(raw, encoding="utf-8")
    result = publish(script, manifest, "0.7.2", b"candidate", check=False)
    if result.returncode == 0:
        raise SystemExit(f"malformed {label} manifest was accepted")
    if manifest.read_text(encoding="utf-8") != raw:
        raise SystemExit(f"malformed {label} manifest was mutated on failure")


def main() -> int:
    script = Path(__file__).with_name("merge-manifest.py")
    with tempfile.TemporaryDirectory() as directory:
        manifest = Path(directory) / "manifest.json"
        publish(script, manifest, "0.7.0", b"first")
        publish(script, manifest, "0.7.1", b"second")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        versions = [entry["version"] for entry in data["builds"]]
        if versions != ["0.7.0", "0.7.1"] or data["current"] != "0.7.1":
            raise SystemExit(f"release history was not preserved: {data!r}")

        # Re-selecting an identical immutable version is idempotent: it changes
        # only `current`, never the historical descriptor or build count.
        first_entry = copy.deepcopy(data["builds"][0])
        publish(script, manifest, "0.7.0", b"first")
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if data["current"] != "0.7.0" or data["builds"][0] != first_entry or len(data["builds"]) != 2:
            raise SystemExit(f"idempotent publication changed history: {data!r}")

        baseline = copy.deepcopy(data)
        cases: list[tuple[str, dict[str, object]]] = []

        wrong_identity = copy.deepcopy(baseline)
        wrong_identity["arch"] = "arm64"
        cases.append(("identity", wrong_identity))

        wrong_current = copy.deepcopy(baseline)
        wrong_current["current"] = "9.9.9"
        cases.append(("current", wrong_current))

        wrong_sha = copy.deepcopy(baseline)
        wrong_sha["builds"][0]["sha256"] = "0" * 64
        cases.append(("sha256", wrong_sha))

        wrong_size = copy.deepcopy(baseline)
        wrong_size["builds"][0]["size_bytes"] += 1
        cases.append(("size", wrong_size))

        wrong_signature = copy.deepcopy(baseline)
        wrong_signature["builds"][0]["signature"] = {"bad": True}
        cases.append(("signature", wrong_signature))

        wrong_date = copy.deepcopy(baseline)
        wrong_date["builds"][0]["published_at"] = "not-rfc3339"
        cases.append(("published_at", wrong_date))

        unknown_field = copy.deepcopy(baseline)
        unknown_field["builds"][0]["surprise"] = True
        cases.append(("unknown-field", unknown_field))

        duplicate = copy.deepcopy(baseline)
        duplicate["builds"].append(copy.deepcopy(duplicate["builds"][0]))
        cases.append(("duplicate", duplicate))

        for label, malformed in cases:
            assert_rejected(script, manifest, malformed, label)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
