#!/usr/bin/env python3
"""Publish a validated staged cxx release into the served immutable store."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from datetime import datetime
import time

from release_hashes import VerifiedHashes, publication_lock

_spec = importlib.util.spec_from_file_location("merge_manifest", Path(__file__).with_name("merge-manifest.py"))
merger = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(merger)


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


def load_platform(source: Path, platform: str, version: str, hashes: VerifiedHashes) -> dict[str, object]:
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
    actual_sha = hashes.sha256(binary)
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


def publish_payload(destination: Path, item: dict[str, object], version: str, hashes: VerifiedHashes) -> None:
    platform_dir = destination / "cxx" / str(item["platform"])
    target = platform_dir / f"v{version}"
    platform_dir.mkdir(parents=True, exist_ok=True)
    # mkdir honours the publishing operator's umask, and this tree is read by
    # the API container under a different uid.
    platform_dir.chmod(0o755)
    if target.exists():
        target_binary = target / "cxx"
        if not target.is_dir() or not target_binary.is_file() or hashes.sha256(target_binary) != item["sha256"]:
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
        if target_binary.stat().st_size != item["size"] or hashes.sha256(target_binary) != item["sha256"]:
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


def log(message: str) -> None:
    print(f"[wrapper-publication] {message}", file=sys.stderr, flush=True)


def validate_manifests(root: Path, items: list[dict[str, object]], hashes: VerifiedHashes) -> dict:
    """Always parse manifests; only unchanged, previously hashed bytes are reused."""
    manifests = {}
    for item in items:
        platform = str(item["platform"])
        manifest = root / "cxx" / platform / "manifest.json"
        started = time.monotonic()
        if manifest.exists():
            existing = json.loads(manifest.read_text(encoding="utf-8"))
            merger.validate_existing(manifest, existing, "cxx", str(item["os"]),
                                     str(item["arch"]), hash_file=hashes.sha256)
            manifests[platform] = existing
        else:
            manifests[platform] = None
        log(f"verified {root.name}/{platform} in {time.monotonic()-started:.3f}s")
    return manifests


def validate_destination(destination: Path, items: list[dict[str, object]], version: str,
                         hashes: VerifiedHashes) -> dict:
    manifests = validate_manifests(destination, items, hashes)
    for item in items:
        target = destination / "cxx" / str(item["platform"]) / f"v{version}"
        if not target.exists():
            continue
        target_binary = target / "cxx"
        if not target.is_dir() or not target_binary.is_file() or hashes.sha256(target_binary) != item["sha256"]:
            raise ReleaseError(f"immutable release conflict at {target}")
        if target_binary.stat().st_size != item["size"]:
            raise ReleaseError(f"immutable release size conflict at {target}")
    return manifests


def validate_prepared_manifests(prepared: dict, current: dict) -> None:
    if set(prepared) != {"source", "destination"} or prepared["source"] != current["source"]:
        raise ReleaseError("staged manifests changed since verification")
    if not isinstance(prepared["destination"], dict) or set(prepared["destination"]) != set(EXPECTED_PLATFORMS):
        raise ReleaseError("invalid prepared destination inventory")
    for platform, old in prepared["destination"].items():
        if old is None:
            continue
        now = current["destination"][platform]
        if not isinstance(old, dict) or not isinstance(old.get("builds"), list):
            raise ReleaseError("invalid prepared destination manifest")
        current_builds = {entry["version"]: entry for entry in now["builds"]} if now else {}
        # A legitimate intervening publication may append builds or move current;
        # it may not remove or rewrite history verified before the outage.
        if any(current_builds.get(entry["version"]) != entry for entry in old["builds"]):
            raise ReleaseError(f"verified destination history changed: {platform}")


def publish(source: Path, destination: Path, version: str, *, prepare: Path | None = None,
            prepared: Path | None = None) -> None:
    source, destination = source.resolve(), destination.resolve()
    binding = {"source": str(source), "destination": str(destination), "version": version}
    hashes, baseline = VerifiedHashes.read(prepared, binding) if prepared else (VerifiedHashes(), None)
    # Serialize preparation and activation with standalone manifest writers too.
    with publication_lock(destination):
        started = time.monotonic()
        log("preflight verification" if prepare else "publication verification")
        items = [load_platform(source, platform, version, hashes) for platform in sorted(EXPECTED_PLATFORMS)]
        manifests = {
            "source": validate_manifests(source, items, hashes),
            "destination": validate_destination(destination, items, version, hashes),
        }
        if baseline is not None:
            validate_prepared_manifests(baseline, manifests)
        if prepare:
            hashes.write(prepare, binding, manifests)
        else:
            # Complete all-platform validation before the first release mutation.
            for item in items:
                publish_payload(destination, item, version, hashes)
            for item in items:
                manifest = destination / "cxx" / str(item["platform"]) / "manifest.json"
                merger.merge(manifest, "cxx", str(item["os"]), str(item["arch"]), version,
                             str(item["sha256"]), int(item["size"]), str(item["published_at"]),
                             hash_file=hashes.sha256, lock_held=True)
        log(f"{'preflight' if prepare else 'publication'} complete in {time.monotonic()-started:.3f}s; "
            f"hashed {hashes.files_hashed} files/{hashes.bytes_hashed} bytes; reused {hashes.hits} checks")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("version")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", type=Path, help="verify while API is online and write a private receipt; do not publish")
    mode.add_argument("--prepared", type=Path, help="reuse unchanged verified payloads, rechecking manifests and changed files")
    args = parser.parse_args(argv[1:])
    try:
        publish(args.source, args.destination, args.version.removeprefix("v"), prepare=args.prepare, prepared=args.prepared)
    except (OSError, ValueError) as exc:
        print(f"publish-release: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
