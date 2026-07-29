#!/usr/bin/env python3
"""Merge one immutable cxx build into a rollback-safe platform manifest."""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import re
import sys
import tempfile
from datetime import datetime


SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
MANIFEST_KEYS = {"engine", "os", "arch", "current", "builds"}
BUILD_KEYS = {"version", "sha256", "size_bytes", "signature", "published_at"}
MAX_BUILDS = 4096
MAX_SIGNATURE = 16_384
MAX_PUBLISHED_AT = 128


def semver_key(raw: str) -> tuple[object, ...]:
    match = SEMVER.fullmatch(raw)
    if not match:
        raise ValueError(f"invalid semantic version {raw!r}")
    prerelease = match.group(4)
    identifiers: tuple[tuple[int, object], ...] = ()
    if prerelease is not None:
        identifiers = tuple(
            (0, int(value)) if value.isdigit() else (1, value)
            for value in prerelease.split(".")
        )
    # A release sorts after its prereleases for the same numeric core.
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)), prerelease is None, identifiers)


def validate_rfc3339(raw: object) -> None:
    if not isinstance(raw, str) or len(raw) > MAX_PUBLISHED_AT or not RFC3339.fullmatch(raw):
        raise ValueError(f"invalid published_at {raw!r}")
    try:
        parsed = datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
    except ValueError as exc:
        raise ValueError(f"invalid published_at {raw!r}") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"invalid published_at {raw!r}")


def normalize_build(candidate: object, path: Path) -> dict[str, object]:
    if not isinstance(candidate, dict) or set(candidate) - BUILD_KEYS:
        raise ValueError(f"invalid build entry in {path}")
    version = candidate.get("version")
    sha = candidate.get("sha256")
    size = candidate.get("size_bytes")
    if not isinstance(version, str):
        raise ValueError(f"invalid build version in {path}")
    semver_key(version)
    if not isinstance(sha, str) or not SHA256.fullmatch(sha):
        raise ValueError(f"invalid build sha256 in {path}")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ValueError(f"invalid build size_bytes in {path}")
    signature = candidate.get("signature")
    if signature is not None and (not isinstance(signature, str) or len(signature) > MAX_SIGNATURE):
        raise ValueError(f"invalid build signature in {path}")
    published = candidate.get("published_at")
    if published is not None:
        validate_rfc3339(published)
    normalized: dict[str, object] = {"version": version, "sha256": sha, "size_bytes": size}
    if "signature" in candidate:
        normalized["signature"] = signature
    if "published_at" in candidate:
        normalized["published_at"] = published
    return normalized


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_existing(
    path: Path, existing: object, engine: str, os_name: str, arch: str
) -> list[dict[str, object]]:
    if not isinstance(existing, dict) or set(existing) != MANIFEST_KEYS:
        raise ValueError(f"invalid existing manifest {path}")
    if existing.get("engine") != engine or existing.get("os") != os_name or existing.get("arch") != arch:
        raise ValueError(f"existing manifest identity mismatch {path}")
    current = existing.get("current")
    raw_builds = existing.get("builds")
    if not isinstance(current, str) or not isinstance(raw_builds, list) or not 1 <= len(raw_builds) <= MAX_BUILDS:
        raise ValueError(f"invalid existing manifest {path}")
    semver_key(current)
    builds = [normalize_build(candidate, path) for candidate in raw_builds]
    versions = [str(candidate["version"]) for candidate in builds]
    if len(set(versions)) != len(versions) or current not in versions:
        raise ValueError(f"invalid existing manifest version set {path}")
    for candidate in builds:
        binary = path.parent / f"v{candidate['version']}" / "cxx"
        if not binary.is_file():
            raise ValueError(f"historical payload missing for {candidate['version']} in {path}")
        if binary.stat().st_size != candidate["size_bytes"] or file_sha256(binary) != candidate["sha256"]:
            raise ValueError(f"historical payload mismatch for {candidate['version']} in {path}")
    return builds


def merge(path: Path, engine: str, os_name: str, arch: str, version: str, sha: str, size: int, published: str) -> None:
    if engine != "cxx" or (os_name, arch) not in {
        ("linux", "amd64"),
        ("linux", "arm64"),
        ("darwin", "amd64"),
        ("darwin", "arm64"),
    }:
        raise ValueError(f"unsupported cxx artifact identity {engine}/{os_name}/{arch}")
    semver_key(version)
    if not SHA256.fullmatch(sha):
        raise ValueError("sha256 must be 64 lowercase hexadecimal characters")
    if size <= 0:
        raise ValueError("size_bytes must be positive")
    validate_rfc3339(published)
    new_binary = path.parent / f"v{version}" / "cxx"
    if not new_binary.is_file() or new_binary.stat().st_size != size or file_sha256(new_binary) != sha:
        raise ValueError(f"new payload does not match publication metadata: {new_binary}")

    builds: list[dict[str, object]] = []
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        builds = validate_existing(path, existing, engine, os_name, arch)

    retained: list[dict[str, object]] = []
    already_published = False
    for candidate in builds:
        if candidate["version"] != version:
            retained.append(candidate)
        elif candidate["sha256"] != sha or candidate["size_bytes"] != size:
            raise ValueError(f"immutable version {version} conflicts with existing manifest {path}")
        else:
            retained.append(candidate)
            already_published = True
    if not already_published:
        retained.append(
            {
                "version": version,
                "sha256": sha,
                "size_bytes": size,
                "signature": None,
                "published_at": published,
            }
        )
    retained.sort(key=lambda item: semver_key(str(item["version"])))
    manifest = {
        "engine": engine,
        "os": os_name,
        "arch": arch,
        "current": version,
        "builds": retained,
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".new", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main(argv: list[str]) -> int:
    if len(argv) == 6 and argv[1] == "--validate":
        path = Path(argv[2])
        if not path.exists():
            return 0
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            validate_existing(path, existing, argv[3], argv[4], argv[5])
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"merge-manifest: {exc}", file=sys.stderr)
            return 1
        return 0
    if len(argv) != 9:
        print(
            "usage: merge-manifest.py PATH ENGINE OS ARCH VERSION SHA256 SIZE_BYTES PUBLISHED_AT\n"
            "       merge-manifest.py --validate PATH ENGINE OS ARCH",
            file=sys.stderr,
        )
        return 2
    try:
        merge(Path(argv[1]), argv[2], argv[3], argv[4], argv[5], argv[6], int(argv[7]), argv[8])
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"merge-manifest: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
