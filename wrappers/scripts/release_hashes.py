"""Private, per-deployment verification receipts for immutable wrapper payloads.

This is a local optimization for the trusted publisher, not an authenticity
proof for external input. Changed files are hashed again, never trusted by size
or mtime alone. Standalone publication works without a receipt.
"""

from __future__ import annotations

import hashlib
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile


@contextlib.contextmanager
def publication_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".publish.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("another wrapper publisher is active; retry after it finishes") from exc
        yield


def fingerprint(info: os.stat_result) -> list[int]:
    return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns]


class VerifiedHashes:
    def __init__(self, records=None):
        self.records = records or {}
        self.hits = self.files_hashed = self.bytes_hashed = 0

    def sha256(self, path: Path) -> str:
        key = str(path.resolve())
        before = fingerprint(path.stat())
        prior = self.records.get(key)
        if prior is not None and prior["stat"] == before:
            self.hits += 1
            return prior["sha256"]
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            if fingerprint(os.fstat(handle.fileno())) != before:
                raise ValueError(f"payload changed before verification: {path}")
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
            if fingerprint(os.fstat(handle.fileno())) != before:
                raise ValueError(f"payload changed during verification: {path}")
        if fingerprint(path.stat()) != before:
            raise ValueError(f"payload replaced during verification: {path}")
        value = digest.hexdigest()
        self.records[key] = {"stat": before, "sha256": value}
        self.files_hashed += 1
        self.bytes_hashed += before[5]
        return value

    def write(self, path: Path, binding: dict, manifests: dict) -> None:
        fd, temporary = tempfile.mkstemp(prefix=".verified-", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"protocol": 1, "binding": binding, "manifests": manifests,
                           "payloads": self.records}, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @classmethod
    def read(cls, path: Path, binding: dict):
        # Validate the descriptor we actually read, without following a symlink
        # or reopening the checked name. Receipts live in the deployer's stage.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise ValueError("verification receipt must be a private regular file owned by the publisher")
            content = handle.read(16 * 1024 * 1024 + 1)
            if len(content) > 16 * 1024 * 1024:
                raise ValueError("verification receipt exceeds size limit")
            data = json.loads(content)
            if fingerprint(os.fstat(handle.fileno())) != fingerprint(info):
                raise ValueError("verification receipt changed while reading")
        if not isinstance(data, dict) or data.get("protocol") != 1 or data.get("binding") != binding:
            raise ValueError("verification receipt does not match this publication")
        records = data.get("payloads")
        if not isinstance(records, dict) or not isinstance(data.get("manifests"), dict):
            raise ValueError("invalid verification receipt")
        for key, record in records.items():
            if (not isinstance(key, str) or not isinstance(record, dict)
                    or not isinstance(record.get("stat"), list) or len(record["stat"]) != 8
                    or any(type(value) is not int for value in record["stat"])
                    or not isinstance(record.get("sha256"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", record["sha256"])):
                raise ValueError("invalid verified payload record")
        return cls(records), data["manifests"]
