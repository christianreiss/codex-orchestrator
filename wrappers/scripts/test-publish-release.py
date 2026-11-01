#!/usr/bin/env python3
"""Regression: sequential staged publications retain rollback payloads."""

from __future__ import annotations

import hashlib
import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch


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
    preflight_regressions(scripts)
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
            # The API container reads this tree under its own uid. A private
            # version directory makes the payload unreadable there, and the
            # release is then declined at boot with no error anywhere.
            for path in (platform_dir, platform_dir / "v0.7.0", platform_dir / "v0.7.1"):
                if not path.stat().st_mode & 0o055 == 0o055:
                    raise SystemExit(f"published directory is not world-traversable: {path}")
            for path in (platform_dir / "manifest.json", platform_dir / "v0.7.1" / "cxx"):
                if not path.stat().st_mode & 0o044 == 0o044:
                    raise SystemExit(f"published file is not world-readable: {path}")

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


def preflight_regressions(scripts: Path) -> None:
    spec = importlib.util.spec_from_file_location("publisher", scripts / "publish-release.py")
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)
    merger = scripts / "merge-manifest.py"
    cases = ("unchanged", "intervening", "corrupt-history", "corrupt-stage",
             "removed-history", "changed-stage-manifest", "receipt-permissions", "publisher-lock")
    for case in cases:
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(io.StringIO()):
            root = Path(directory)
            destination, staged, receipt = root / "served", root / "new", root / "verified.json"
            for version in ("0.7.0", "0.7.1"):
                old = root / version
                stage(old, merger, version, b"old")
                publisher.publish(old, destination, version)
            stage(staged, merger, "0.7.4", b"new")
            publisher.publish(staged, destination, "0.7.4", prepare=receipt)
            assert not receipt.stat().st_mode & 0o077
            for platform in PLATFORMS:
                assert not (destination / "cxx" / platform / "v0.7.4").exists()

            if case == "intervening":
                middle = root / "middle"
                stage(middle, merger, "0.7.3", b"intervening")
                publisher.publish(middle, destination, "0.7.3")
            if case in ("corrupt-history", "corrupt-stage"):
                binary = ((destination / "cxx/linux-amd64/v0.7.0/cxx") if case == "corrupt-history"
                          else staged / "cxx/linux-amd64/v0.7.4/cxx")
                before = binary.stat()
                content = binary.read_bytes()
                binary.write_bytes(bytes([content[0] ^ 1]) + content[1:])
                os.utime(binary, ns=(before.st_atime_ns, before.st_mtime_ns))
                assert binary.stat().st_size == before.st_size
                assert binary.stat().st_mtime_ns == before.st_mtime_ns
            if case in ("removed-history", "changed-stage-manifest"):
                manifest = (destination if case == "removed-history" else staged) / "cxx/linux-amd64/manifest.json"
                data = json.loads(manifest.read_text())
                if case == "removed-history":
                    data["builds"] = [entry for entry in data["builds"] if entry["version"] != "0.7.0"]
                else:
                    data["builds"][0]["published_at"] = "2026-08-01T00:00:00Z"
                manifest.write_text(json.dumps(data))
            if case == "receipt-permissions":
                receipt.chmod(0o644)

            with contextlib.ExitStack() as stack:
                if case == "publisher-lock":
                    lock = stack.enter_context((destination / ".publish.lock").open("a"))
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    # Standalone manifest writers must respect the same lock.
                    manifest = destination / "cxx" / next(iter(PLATFORMS)) / "manifest.json"
                    data = json.loads(manifest.read_text())
                    build = data["builds"][0]
                    os_name, arch = next(iter(PLATFORMS)).split("-")
                    try:
                        publisher.merger.merge(manifest, "cxx", os_name, arch,
                            build["version"], build["sha256"], build["size_bytes"], build["published_at"])
                    except ValueError as exc:
                        assert "another wrapper publisher" in str(exc)
                    else:
                        raise AssertionError("standalone manifest writer ignored publication lock")
                if case in ("unchanged", "intervening"):
                    original_open = Path.open
                    historical = {str((destination / "cxx" / plat / f"v{version}" / "cxx").resolve())
                                  for plat in PLATFORMS for version in ("0.7.0", "0.7.1")}
                    def no_history_read(path, *args, **kwargs):
                        assert str(path.resolve()) not in historical, "unchanged history rehashed during cutover"
                        return original_open(path, *args, **kwargs)
                    stack.enter_context(patch.object(Path, "open", no_history_read))
                    publisher.publish(staged, destination, "0.7.4", prepared=receipt)
                else:
                    try:
                        publisher.publish(staged, destination, "0.7.4", prepared=receipt)
                    except (ValueError, OSError):
                        pass
                    else:
                        raise AssertionError(f"unsafe preflight accepted: {case}")
                    for platform in PLATFORMS:
                        assert not (destination / "cxx" / platform / "v0.7.4").exists(), case
            if case in ("unchanged", "intervening"):
                for platform in PLATFORMS:
                    data = json.loads((destination / "cxx" / platform / "manifest.json").read_text())
                    assert data["current"] == "0.7.4"
                    assert len(data["builds"]) == (4 if case == "intervening" else 3)
        print(f"preflight regression passed: {case}")


if __name__ == "__main__":
    raise SystemExit(main())
