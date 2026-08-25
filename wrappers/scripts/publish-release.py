#!/usr/bin/env python3
"""Publish a validated staged cxx release into the served immutable store."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime


EXPECTED_PLATFORMS = {
    "linux-amd64": ("linux", "amd64"),
    "linux-arm64": ("linux", "arm64"),
    "darwin-amd64": ("darwin", "amd64"),
    "darwin-arm64": ("darwin", "arm64"),
}


class ReleaseError(ValueError):
    """A staged release is incomplete, corrupt, or conflicts with history."""


def valid_published_at(value: object) -> bool:
    if not isinstance(value, str) or not value or len(value) > 128:
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError:
        return False
    return "T" in value and parsed.tzinfo is not None


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_platform(source: Path, platform: str, version: str) -> dict[str, object]:
    os_name, arch = EXPECTED_PLATFORMS[platform]
    platform_dir = source / "cxx" / platform
    manifest_path = platform_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"cannot read {manifest_path}: {exc}") from exc
    if (
        not isinstance(manifest, dict)
        or manifest.get("engine") != "cxx"
        or manifest.get("os") != os_name
        or manifest.get("arch") != arch
        or manifest.get("current") != version
        or not isinstance(manifest.get("builds"), list)
    ):
        raise ReleaseError(f"staged manifest metadata mismatch: {manifest_path}")
    matches = [entry for entry in manifest["builds"] if isinstance(entry, dict) and entry.get("version") == version]
    if len(matches) != 1:
        raise ReleaseError(f"staged manifest must contain exactly one {version} build: {manifest_path}")
    entry = matches[0]
    binary = platform_dir / f"v{version}" / "cxx"
    sidecar = binary.with_name("cxx.sha256")
    if not binary.is_file() or not sidecar.is_file():
        raise ReleaseError(f"staged cxx payload incomplete: {binary.parent}")
    actual_sha = sha256(binary)
    actual_size = binary.stat().st_size
    sidecar_fields = sidecar.read_text(encoding="utf-8").split()
    if (
        entry.get("sha256") != actual_sha
        or entry.get("size_bytes") != actual_size
        or sidecar_fields != [actual_sha, "cxx"]
        or not valid_published_at(entry.get("published_at"))
    ):
        raise ReleaseError(f"staged cxx checksum or metadata mismatch: {binary}")
    return {
        "platform": platform,
        "os": os_name,
        "arch": arch,
        "binary": binary,
        "sha256": actual_sha,
        "size": actual_size,
        "published_at": entry["published_at"],
    }


def publish_payload(destination: Path, item: dict[str, object], version: str) -> None:
    platform_dir = destination / "cxx" / str(item["platform"])
    target = platform_dir / f"v{version}"
    platform_dir.mkdir(parents=True, exist_ok=True)
    # mkdir honours the publishing operator's umask, and this tree is read by
    # the API container under a different uid.
    platform_dir.chmod(0o755)
    if target.exists():
        target_binary = target / "cxx"
        if not target.is_dir() or not target_binary.is_file() or sha256(target_binary) != item["sha256"]:
            raise ReleaseError(f"immutable release conflict at {target}")
        if target_binary.stat().st_size != item["size"]:
            raise ReleaseError(f"immutable release size conflict at {target}")
        return

    temporary = Path(tempfile.mkdtemp(prefix=f".v{version}.", suffix=".new", dir=platform_dir))
    try:
        # mkdtemp hardcodes 0700, and this directory is renamed into place as
        # the published version directory. Left private it makes the payload
        # unreadable to the API container, which then silently declines to
        # project the release: binaryMatchesBuild swallows the EACCES, the
        # matrix looks incomplete, and boot-checks keeps the previous pointers.
        # Every host is then offered the old version with no error anywhere.
        temporary.chmod(0o755)
        target_binary = temporary / "cxx"
        shutil.copyfile(Path(item["binary"]), target_binary)
        if target_binary.stat().st_size != item["size"] or sha256(target_binary) != item["sha256"]:
            raise ReleaseError(f"staged payload changed while publishing: {item['binary']}")
        target_binary.chmod(0o755)
        sidecar = temporary / "cxx.sha256"
        sidecar.write_text(f"{item['sha256']}  cxx\n", encoding="utf-8")
        sidecar.chmod(0o644)
        for path in (target_binary, sidecar):
            with path.open("rb") as handle:
                os.fsync(handle.fileno())
        os.rename(temporary, target)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def validate_manifests(root: Path, items: list[dict[str, object]]) -> None:
    """Validate complete manifest history and every payload before publication."""
    merger = Path(__file__).with_name("merge-manifest.py")
    for item in items:
        manifest = root / "cxx" / str(item["platform"]) / "manifest.json"
        subprocess.run(
            [
                sys.executable,
                str(merger),
                "--validate",
                str(manifest),
                "cxx",
                str(item["os"]),
                str(item["arch"]),
            ],
            check=True,
        )


def validate_destination(destination: Path, items: list[dict[str, object]], version: str) -> None:
    validate_manifests(destination, items)
    for item in items:
        platform_dir = destination / "cxx" / str(item["platform"])
        target = platform_dir / f"v{version}"
        if not target.exists():
            continue
        target_binary = target / "cxx"
        if not target.is_dir() or not target_binary.is_file() or sha256(target_binary) != item["sha256"]:
            raise ReleaseError(f"immutable release conflict at {target}")
        if target_binary.stat().st_size != item["size"]:
            raise ReleaseError(f"immutable release size conflict at {target}")


def publish(source: Path, destination: Path, version: str) -> None:
    # Validate the complete matrix before the first destination mutation.
    items = [load_platform(source, platform, version) for platform in sorted(EXPECTED_PLATFORMS)]
    validate_manifests(source, items)
    validate_destination(destination, items, version)
    for item in items:
        publish_payload(destination, item, version)

    merger = Path(__file__).with_name("merge-manifest.py")
    for item in items:
        manifest = destination / "cxx" / str(item["platform"]) / "manifest.json"
        subprocess.run(
            [
                sys.executable,
                str(merger),
                str(manifest),
                "cxx",
                str(item["os"]),
                str(item["arch"]),
                version,
                str(item["sha256"]),
                str(item["size"]),
                str(item["published_at"]),
            ],
            check=True,
        )


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: publish-release.py STAGE_ROOT DESTINATION_ROOT VERSION", file=sys.stderr)
        return 2
    try:
        publish(Path(argv[1]), Path(argv[2]), argv[3].removeprefix("v"))
    except (OSError, ReleaseError, subprocess.CalledProcessError) as exc:
        print(f"publish-release: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
