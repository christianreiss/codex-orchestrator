"""Grok subscription probes and refresh-incapable, isolated CLI executions.

The API owns OAuth refresh. Nothing in this module may mint a token, read the
operator's native home, or return rewritten credentials as a canonical upload.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException

ISSUER = "https://auth.x.ai"
DEFAULT_SCOPE = f"{ISSUER}::b1a00492-073a-47ea-816f-4c329264a828"
USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription"
CLI_PATH = shutil.which("grok") or "/usr/local/bin/grok"
VERSION: str | None = None
REFRESH_BUFFER_SECONDS = 300


def selected_credential(auth: dict) -> tuple[str, dict]:
    scope_map = auth.get("grok_auth")
    if not isinstance(scope_map, dict):
        raise HTTPException(400, "modern Grok subscription credentials are required")
    candidates = []
    for scope, credential in scope_map.items():
        if not isinstance(scope, str) or not isinstance(credential, dict):
            continue
        if (
            scope.startswith(f"{ISSUER}::")
            and credential.get("auth_mode") in ("oidc", "external")
            and credential.get("oidc_issuer") == ISSUER
            and isinstance(credential.get("key"), str)
            and credential["key"].strip()
        ):
            candidates.append((scope, credential))
    # A runner must not pick a different account from a multi-scope envelope.
    selected = auth.get("grok_scope", DEFAULT_SCOPE)
    if isinstance(selected, str):
        candidates = [entry for entry in candidates if entry[0] == selected]
    if len(candidates) != 1:
        raise HTTPException(400, "exactly one selected modern Grok subscription scope is required")
    return candidates[0]


def require_lifetime(credential: dict, minimum_seconds: float) -> None:
    try:
        expires = datetime.fromisoformat(credential["expires_at"].replace("Z", "+00:00"))
        remaining = expires.timestamp() - datetime.now(timezone.utc).timestamp()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise HTTPException(400, "Grok access-token expiry is missing or invalid") from None
    if remaining < minimum_seconds:
        raise HTTPException(409, "Grok access token needs a centrally refreshed generation")


def prepare_env(auth: dict, home_parent: str, minimum_seconds: float) -> tuple[dict, str, str]:
    scope, credential = selected_credential(auth)
    require_lifetime(credential, minimum_seconds)
    home = tempfile.mkdtemp(prefix="grok-runner-", dir=home_parent)
    try:
        os.chmod(home, 0o700)
        native_home = os.path.join(home, ".grok")
        os.mkdir(native_home, 0o700)
        # Only the selected access-only credential enters the native home. The
        # native reloader reads GROK_HOME/auth.json even with GROK_AUTH_PATH set.
        native = copy.deepcopy(credential)
        native.pop("refresh_token", None)
        path = os.path.join(native_home, "auth.json")
        with open(path, "x", encoding="utf-8") as output:
            json.dump({scope: native}, output)
        os.chmod(path, 0o600)
        env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
               "HOME": home, "GROK_HOME": native_home, "GROK_AUTH_PATH": path,
               "GROK_DISABLE_API_KEY_AUTH": "1", "GROK_DISABLE_AUTOUPDATER": "1"}
        for key in ("LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"):
            if os.environ.get(key):
                env[key] = os.environ[key]
        return env, home, path
    except BaseException:
        shutil.rmtree(home, ignore_errors=True)
        raise


def version(env: dict | None = None) -> str:
    if env is None and VERSION is not None:
        return VERSION
    try:
        proc = subprocess.run([CLI_PATH, "--version"], env=env, capture_output=True,
                              text=True, timeout=5)
        return proc.stdout.strip() if proc.returncode == 0 else "unavailable"
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"


def verify(auth: dict, timeout: float) -> dict:
    _, credential = selected_credential(auth)
    require_lifetime(credential, REFRESH_BUFFER_SECONDS)
    started = time.perf_counter()
    try:
        # Metadata verifies the subscription bearer without generation or refresh.
        response = httpx.get(USER_URL, headers={"Authorization": f"Bearer {credential['key']}"},
                             timeout=min(max(timeout, 1), 30), follow_redirects=False)
        ok = response.status_code == 200
        result = {"status": "ok" if ok else "fail", "reachable": True,
                  "definitive": ok or response.status_code in (401, 403),
                  "auth_readback": "unchanged", "grok_version": version(),
                  "latency_ms": int((time.perf_counter() - started) * 1000)}
        if ok:
            try:
                metadata = response.json()
            except ValueError:
                result.update(status="fail", definitive=False, reason="invalid Grok user metadata")
                return result
            if not isinstance(metadata, dict):
                result.update(status="fail", definitive=False, reason="invalid Grok user metadata")
                return result
            identity = metadata.get("userId")
            if not isinstance(identity, str) or not identity:
                result.update(status="fail", definitive=False, reason="Grok user identity is missing")
                return result
            if credential.get("user_id") and credential["user_id"] != identity:
                result.update(status="fail", definitive=True, reason="Grok subscription account identity does not match")
                return result
            result["user_id"] = identity
            result["account_identity"] = {"provider": "xai", "user_id": identity}
            result["provider_metadata"] = {key: metadata[key] for key in
                                           ("userId", "subscriptionTier", "teamId") if key in metadata}
        else:
            result["reason"] = f"Grok subscription metadata returned HTTP {response.status_code}"
        return result
    except httpx.HTTPError:
        return {"status": "fail", "reachable": False, "definitive": False,
                "reason": "Grok subscription metadata is unreachable", "auth_readback": "unchanged",
                "grok_version": version()}


def build_command(prompt: str, home: str, model: str | None = None,
                  system: str | None = None) -> list[str]:
    # `-p -` sends a literal dash. A private prompt file avoids shell parsing,
    # ARG_MAX, and exposing the user's prompt in the process command line.
    path = os.path.join(home, "prompt.txt")
    with open(path, "w", encoding="utf-8") as output:
        output.write(prompt)
    os.chmod(path, 0o600)
    cmd = [CLI_PATH, "--no-leader", "--prompt-file", path, "--output-format", "json",
           "--permission-mode", "plan", "--no-subagents", "--disable-web-search",
           "--cwd", home]
    if model:
        cmd.extend(["--model", model])
    if system:
        cmd.extend(["--system-prompt-override", system])
    return cmd


def parse_result(stdout: str) -> dict | None:
    try:
        native = json.loads(stdout)
    except ValueError:
        return None
    if not isinstance(native, dict) or not isinstance(native.get("text"), str):
        return None
    reason = native.get("stopReason")
    finish = {"end_turn": "stop", "max_tokens": "length", "refusal": "content_filter"}.get(reason)
    result = {"output": native["text"], "finish_reason": finish,
              "native_stop_reason": reason, "usage_known": False}
    usage = native.get("usage")
    keys = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    if isinstance(usage, dict) and all(isinstance(usage.get(k), int) and not isinstance(usage[k], bool)
                                      and usage[k] >= 0 for k in keys):
        result.update({k: usage[k] for k in keys})
        # Native input_tokens excludes both cache buckets; OpenAI includes them.
        result["input_tokens"] += usage["cache_read_input_tokens"] + usage["cache_creation_input_tokens"]
        result["usage_known"] = native.get("usage_is_incomplete") is not True
        reasoning = usage.get("reasoning_tokens")
        if isinstance(reasoning, int) and not isinstance(reasoning, bool) and reasoning >= 0:
            result["reasoning_tokens"] = reasoning
    return result


def run(prompt: str, env: dict, timeout: float, model: str | None = None,
        system: str | None = None) -> tuple[subprocess.CompletedProcess[str], int]:
    cmd = build_command(prompt, env["HOME"], model, system)
    started = time.perf_counter()
    proc = subprocess.run(cmd, env=env, cwd=env["HOME"], capture_output=True, text=True, timeout=timeout)
    return proc, int((time.perf_counter() - started) * 1000)
