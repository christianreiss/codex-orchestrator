#!/usr/bin/env python3
"""Regression: sequential staged publications retain rollback payloads."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


PLATFORMS = {
    "linux-amd64": ("linux", "amd64"),
    "linux-arm64": ("linux", "arm64"),
    "darwin-amd64": ("darwin", "amd64"),
    "darwin-arm64": ("darwin", "arm64"),
}


def stage(root: Path, merger: Path, version: str, marker: bytes) -> None:
    for platform, (os_name, arch) in PLATFORMS.items():
        platform_dir = root / "cxx" / platform
        version_dir = platform_dir / f"v{version}"
        version_dir.mkdir(parents=True)
        binary = version_dir / "cxx"
        payload = marker + b":" + platform.encode()
        binary.write_bytes(payload)
        digest = hashlib.sha256(payload).hexdigest()
        (version_dir / "cxx.sha256").write_text(f"{digest}  cxx\n", encoding="utf-8")
        subprocess.run(
            [
                sys.executable,
                str(merger),
                str(platform_dir / "manifest.json"),
                "cxx",
                os_name,
                arch,
                version,
                digest,
                str(len(payload)),
                "2026-07-29T00:00:00Z",
            ],
            check=True,
        )


def main() -> int:
    scripts = Path(__file__).parent
    publisher = scripts / "publish-release.py"
    merger = scripts / "merge-manifest.py"
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        destination = root / "served"
        for version, marker in (("0.7.0", b"first"), ("0.7.1", b"second")):
            staged = root / f"stage-{version}"
            stage(staged, merger, version, marker)
            subprocess.run(
                [sys.executable, str(publisher), str(staged), str(destination), version],
                check=True,
            )

        for platform in PLATFORMS:
            platform_dir = destination / "cxx" / platform
            data = json.loads((platform_dir / "manifest.json").read_text(encoding="utf-8"))
            versions = [entry["version"] for entry in data["builds"]]
            if versions != ["0.7.0", "0.7.1"] or data["current"] != "0.7.1":
                raise SystemExit(f"publication history was not preserved for {platform}: {data!r}")
            if (platform_dir / "v0.7.0" / "cxx").read_bytes() != b"first:" + platform.encode():
                raise SystemExit(f"rollback payload changed for {platform}")
            if (platform_dir / "v0.7.1" / "cxx").read_bytes() != b"second:" + platform.encode():
                raise SystemExit(f"current payload missing for {platform}")

        # A malformed destination manifest must fail before any platform gets
        # the new immutable payload; the four-platform publication is atomic at
        # the validation boundary even though manifest swaps happen per path.
        corrupt_manifest = destination / "cxx" / "linux-amd64" / "manifest.json"
        corrupt = json.loads(corrupt_manifest.read_text(encoding="utf-8"))
        corrupt["builds"][0]["size_bytes"] += 1
        corrupt_manifest.write_text(json.dumps(corrupt), encoding="utf-8")
        staged = root / "stage-0.7.2"
        stage(staged, merger, "0.7.2", b"third")
        result = subprocess.run(
            [sys.executable, str(publisher), str(staged), str(destination), "0.7.2"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            raise SystemExit("malformed destination manifest was accepted")
        for platform in PLATFORMS:
            if (destination / "cxx" / platform / "v0.7.2").exists():
                raise SystemExit(f"partial publication mutated {platform}")

        # Source validation must use the same strict manifest contract as the
        # merger. datetime.fromisoformat accepts this seconds-free timestamp,
        # but the published manifest contract requires RFC3339 seconds. This
        # failure must happen before even one immutable destination payload is
        # installed.
        malformed_stage = root / "stage-0.7.3"
        stage(malformed_stage, merger, "0.7.3", b"fourth")
        malformed_manifest = malformed_stage / "cxx" / "linux-amd64" / "manifest.json"
        malformed = json.loads(malformed_manifest.read_text(encoding="utf-8"))
        malformed["builds"][-1]["published_at"] = "2026-07-29T00:00+00:00"
        malformed_manifest.write_text(json.dumps(malformed), encoding="utf-8")
        clean_destination = root / "served-malformed-source"
        result = subprocess.run(
            [sys.executable, str(publisher), str(malformed_stage), str(clean_destination), "0.7.3"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            raise SystemExit("malformed staged manifest was accepted")
        for platform in PLATFORMS:
            if (clean_destination / "cxx" / platform / "v0.7.3").exists():
                raise SystemExit(f"malformed staged manifest partially published {platform}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
