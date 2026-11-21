"""Provision the Fleet Advisor container from the API's bootstrap credential.

The API owns this host (hosts.internal_role = 'advisor') and writes
/bootstrap/bootstrap.json. This fetches each engine's signed config exactly as
the cxx installer writes it, and installs the advertised cxx binary when it is
missing or differs. Re-run on every start; nothing here is interactive.
"""
import hashlib
import json
import os
import platform
import re
import tempfile
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

HOME = os.environ["HOME"]
CFG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(HOME, ".config")), "codex-orchestrator")
BIN_DIR = os.environ.get("BIN_DIR", os.path.join(HOME, ".local", "bin"))
ENGINES = (("codex", "cdx"), ("claude", "clx"), ("grok", "cgx"), ("kimi", "ckx"))


def sort_value(value):
    # Same canonical form the installer signs over (wrapper-transition.ts).
    if isinstance(value, list):
        return [sort_value(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_value(value[k]) for k in sorted(value)}
    return value


def origin(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("advisor: invalid HTTP origin")
    return parsed.scheme, parsed.hostname, parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)


class RedirectPolicy(urllib.request.HTTPRedirectHandler):
    def __init__(self, artifact):
        self.artifact = artifact

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        source, target = origin(req.full_url), origin(newurl)
        if source != target and (not self.artifact or target[0] != "https"):
            raise ValueError("advisor: refused download redirect outside the trusted origin")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and source != target:
            redirected.remove_header("X-api-key")
            redirected.remove_header("X-wrapper-platform")
        return redirected


def fetch(base, url, key, platform_name, artifact=False):
    if origin(url) != origin(base):
        raise ValueError("advisor: unexpected initial download origin")
    req = urllib.request.Request(url, headers={"X-API-Key": key, "X-Wrapper-Platform": platform_name})
    return urllib.request.build_opener(RedirectPolicy(artifact)).open(req, timeout=60)


def write_private(path, data):
    with tempfile.NamedTemporaryFile(dir=os.path.dirname(path), delete=False) as fh:
        try:
            fh.write(data)
            fh.close()
            os.replace(fh.name, path)
        finally:
            if os.path.exists(fh.name):
                os.unlink(fh.name)


def main(bootstrap_path):
    with open(bootstrap_path, encoding="utf-8") as fh:
        boot = json.load(fh)
    base, key = boot["base_url"].rstrip("/"), boot["api_key"]
    arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine(), "amd64")
    platform_name = f"linux-{arch}"
    os.makedirs(CFG_DIR, exist_ok=True)
    os.makedirs(BIN_DIR, exist_ok=True)
    wrapper = None
    for engine, persona in ENGINES:
        try:
            with fetch(base, f"{base}/wrapper/v2/config?engine={engine}", key, platform_name) as response:
                data = response.read((64 << 20) + 1)
            if len(data) > 64 << 20:
                raise ValueError("advisor: wrapper config exceeds 64 MiB")
            bundle = json.loads(data)
        except urllib.error.HTTPError as err:
            print(f"advisor: {engine} config unavailable (HTTP {err.code}); skipping", file=sys.stderr)
            continue
        payload, signature = bundle.get("payload"), (bundle.get("signature") or {}).get("value")
        if not isinstance(payload, dict) or not signature:
            print(f"advisor: {engine} config incomplete; skipping", file=sys.stderr)
            continue
        path = os.path.join(CFG_DIR, f"{persona}.json")
        canonical = json.dumps(sort_value(payload), ensure_ascii=False, separators=(",", ":"))
        write_private(path, canonical.encode("utf-8"))
        write_private(path + ".sig", signature.encode("utf-8"))
        link = os.path.join(BIN_DIR, persona)
        if not os.path.lexists(link):
            os.symlink("cxx", link)
        wrapper = wrapper or payload.get("wrapper")
    if not wrapper:
        raise SystemExit("advisor: no engine config could be fetched")
    target = os.path.join(BIN_DIR, "cxx")
    want = str(wrapper.get("binary_sha256", "")).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", want):
        raise ValueError("advisor: missing or invalid advertised cxx checksum")
    if os.path.exists(target):
        with open(target, "rb") as installed:
            if hashlib.file_digest(installed, "sha256").hexdigest() == want:
                return
    with fetch(base, wrapper["binary_url"], key, platform_name, artifact=True) as response:
        with tempfile.NamedTemporaryFile(dir=BIN_DIR, delete=False) as binary:
            try:
                digest = hashlib.sha256()
                while chunk := response.read(1 << 20):
                    if binary.tell() + len(chunk) > 256 << 20:
                        raise ValueError("advisor: cxx binary exceeds 256 MiB")
                    digest.update(chunk)
                    binary.write(chunk)
                if digest.hexdigest() != want:
                    raise ValueError("advisor: downloaded cxx checksum mismatch")
                os.fchmod(binary.fileno(), 0o755)
                binary.close()
                os.replace(binary.name, target)
            finally:
                if os.path.exists(binary.name):
                    os.unlink(binary.name)
        print(f"advisor: installed cxx {wrapper.get('version')}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
