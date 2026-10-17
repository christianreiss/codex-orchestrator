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
import sys
import urllib.error
import urllib.request

HOME = os.environ["HOME"]
CFG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(HOME, ".config")), "codex-orchestrator")
BIN_DIR = os.environ.get("BIN_DIR", os.path.join(HOME, ".local", "bin"))
ENGINES = (("codex", "cdx"), ("claude", "clx"), ("grok", "cgx"))


def sort_value(value):
    # Same canonical form the installer signs over (wrapper-transition.ts).
    if isinstance(value, list):
        return [sort_value(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_value(value[k]) for k in sorted(value)}
    return value


def fetch(url, key, platform_name):
    req = urllib.request.Request(url, headers={"X-API-Key": key, "X-Wrapper-Platform": platform_name})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def write_private(path, data):
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


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
            bundle = json.loads(fetch(f"{base}/wrapper/v2/config?engine={engine}", key, platform_name))
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
    have = hashlib.sha256(open(target, "rb").read()).hexdigest() if os.path.exists(target) else ""
    if have != want:
        binary = fetch(wrapper["binary_url"], key, platform_name)
        if hashlib.sha256(binary).hexdigest() != want:
            raise SystemExit("advisor: downloaded cxx checksum mismatch")
        tmp = f"{target}.tmp.{os.getpid()}"
        with open(tmp, "wb") as fh:
            fh.write(binary)
        os.chmod(tmp, 0o755)
        os.replace(tmp, target)
        print(f"advisor: installed cxx {wrapper.get('version')}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
