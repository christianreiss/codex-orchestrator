"""Kimi Code executions with access-only credentials; the API alone refreshes."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time

import httpx
from fastapi import HTTPException

CLI_PATH = shutil.which("kimi") or "/usr/local/bin/kimi"
VERSION: str | None = None
REFRESH_BUFFER_SECONDS = 300
DEFAULT_MODEL = "kimi-for-coding"
MODELS = ("k3.1-pro", "k3.1-pro-highspeed", "k3", "k3-256k", DEFAULT_MODEL, "kimi-for-coding-highspeed")


def selected_credential(auth: dict) -> tuple[str, dict]:
    credential = auth.get("kimi_code")
    if not isinstance(credential, dict) or not isinstance(credential.get("access_token"), str) or not credential["access_token"].strip():
        raise HTTPException(400, "canonical Kimi subscription credentials are required")
    if not isinstance(auth.get("device_id"), str) or not re.fullmatch(r"[a-fA-F0-9]{32}", auth["device_id"]):
        raise HTTPException(400, "Kimi device_id must contain 32 hexadecimal characters")
    base = auth.get("base_url", "https://api.kimi.com/coding/v1")
    # Canonical subscription endpoints only: verification must not forward a
    # bearer to an arbitrary URL supplied in an upload.
    if not isinstance(base, str) or base.rstrip("/") not in ("https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"):
        raise HTTPException(400, "invalid Kimi subscription base_url")
    oauth_host = auth.get("oauth_host", "https://auth.kimi.com")
    if oauth_host not in ("https://auth.kimi.com", "https://auth.kimi.ai"):
        raise HTTPException(400, "invalid Kimi oauth_host")
    return base.rstrip("/"), credential


def require_lifetime(credential: dict, minimum_seconds: float) -> None:
    expiry = credential.get("expires_at")
    if isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry) or not (expiry > 0):
        raise HTTPException(400, "Kimi access-token expiry is missing or invalid")
    if expiry - time.time() < minimum_seconds:
        raise HTTPException(409, "Kimi access token needs a centrally refreshed generation")


def model_alias(model: str | None) -> str:
    native = model or DEFAULT_MODEL
    if native.startswith("kimi-code/"):
        native = native[len("kimi-code/"):]
    if native not in MODELS:
        raise HTTPException(400, "unknown Kimi Code model")
    return f"kimi-code/{native}"


def prepare_env(auth: dict, home_parent: str, minimum_seconds: float) -> tuple[dict, str, str]:
    base, credential = selected_credential(auth)
    require_lifetime(credential, minimum_seconds)
    home = tempfile.mkdtemp(prefix="kimi-runner-", dir=home_parent)
    try:
        os.chmod(home, 0o700)
        native = os.path.join(home, ".kimi-code")
        os.mkdir(native, 0o700)
        os.mkdir(os.path.join(native, "credentials"), 0o700)
        projection = {"access_token": credential["access_token"], "refresh_token": "", "expires_at": 0,
                      "expires_in": 0, "scope": "kimi-code", "token_type": "Bearer"}
        path = os.path.join(native, "credentials", "kimi-code.json")
        def write(name: str, body: str) -> None:
            with open(name, "x", encoding="utf-8") as output:
                output.write(body)
            os.chmod(name, 0o600)
        write(path, json.dumps(projection))
        write(os.path.join(native, "device_id"), auth["device_id"])
        oauth_host = auth.get("oauth_host", "https://auth.kimi.com")
        oauth_key = "oauth/kimi-code"
        if base != "https://api.kimi.com/coding/v1" or oauth_host != "https://auth.kimi.com":
            # Native 2.5.3 scopes non-default environments, even when config
            # names the default slot. Preserve the canonical projection and
            # provide its access-only scoped alias for that same environment.
            identity = json.dumps({"oauthHost": oauth_host, "baseUrl": base}, separators=(",", ":"))
            suffix = hashlib.sha256(identity.encode()).hexdigest()[:16]
            oauth_key = "oauth/kimi-code-env-" + suffix
            write(os.path.join(native, "credentials", f"kimi-code-env-{suffix}.json"), json.dumps(projection))
        config = ('default_model = "kimi-code/kimi-for-coding"\ndefault_permission_mode = "auto"\n'
                  'telemetry = false\nauto_session_title = false\ndisable_feedback_survey = true\n'
                  '[providers."managed:kimi-code"]\ntype = "kimi"\n'
                  f'base_url = {json.dumps(base)}\napi_key = ""\n'
                  f'oauth = {{ storage = "file", key = {json.dumps(oauth_key)}, oauth_host = {json.dumps(oauth_host)} }}\n')
        for model in MODELS:
            context_size = 1048576 if model in ("k3.1-pro", "k3.1-pro-highspeed", "k3") else 262144
            config += (f'[models."kimi-code/{model}"]\nprovider = "managed:kimi-code"\n'
                       f'model = "{model}"\nmax_context_size = {context_size}\n')
        # The runner is inference-only. Deny all native tool executions,
        # including shell, filesystem, MCP, web and spawned agents.
        config += '[[permission.rules]]\ndecision = "deny"\nscope = "user"\npattern = "*"\n'
        write(os.path.join(native, "config.toml"), config)
        env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": home,
               "KIMI_CODE_HOME": native, "KIMI_DISABLE_TELEMETRY": "1", "KIMI_CODE_NO_AUTO_UPDATE": "1"}
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
        proc = subprocess.run([CLI_PATH, "--version"], env=env, capture_output=True, text=True, timeout=5)
        return proc.stdout.strip() if proc.returncode == 0 else "unavailable"
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"


def verify(auth: dict, timeout: float) -> dict:
    base, credential = selected_credential(auth)
    require_lifetime(credential, REFRESH_BUFFER_SECONDS)
    started = time.perf_counter()
    result = {"status": "fail", "reachable": False, "definitive": False,
              "auth_readback": "unchanged", "kimi_version": version()}
    try:
        response = httpx.get(base + "/usages", headers={"Authorization": f"Bearer {credential['access_token']}",
                             "Accept": "application/json"}, timeout=min(max(timeout, 1), 30), follow_redirects=False)
        result.update(reachable=True, definitive=response.status_code in (401, 403))
        if response.status_code == 200:
            try:
                metadata = response.json()
            except ValueError:
                metadata = None
            if isinstance(metadata, dict) and isinstance(metadata.get("usages"), dict):
                result.update(status="ok", definitive=True)
            else:
                result["reason"] = "invalid Kimi usage metadata"
        else:
            result["reason"] = f"Kimi subscription metadata returned HTTP {response.status_code}"
    except httpx.HTTPError:
        result["reason"] = "Kimi subscription metadata is unreachable"
    result["latency_ms"] = int((time.perf_counter() - started) * 1000)
    return result


def build_command(prompt: str, home: str, model: str | None = None, system: str | None = None) -> list[str]:
    if system:
        path = os.path.join(home, ".kimi-code", "SYSTEM.md")
        with open(path, "w", encoding="utf-8") as output:
            output.write(system)
        os.chmod(path, 0o600)
    # Explicit empty native tool allowlist: print mode is auto, so the
    # inference boundary must remove tools rather than depend on approvals.
    agent = os.path.join(home, "inference-agent.md")
    with open(agent, "w", encoding="utf-8") as output:
        output.write('---\nname: runner-inference\ndescription: Inference only\ntools: []\n---\n')
        output.write(system or "Answer the user request directly. No tools are available.")
    os.chmod(agent, 0o600)
    # 2.5.3 rejects -p together with --auto; print mode is already auto.
    return [CLI_PATH, "-p", prompt, "--output-format", "stream-json", "-m", model_alias(model),
            "--agent-file", agent]


def parse_result(stdout: str) -> dict | None:
    # 2.5.3 PromptJsonWriter emits complete assistant/tool messages and meta
    # lines. It exposes neither usage nor a native finish reason. Do not infer
    # either from a successful process exit or from a resume hint.
    texts = []
    seen = False
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            return None
        if not isinstance(event, dict) or event.get("type") == "error":
            return None
        role = event.get("role")
        if role == "assistant":
            if "content" in event and not isinstance(event["content"], str):
                return None
            if event.get("tool_calls"):
                # No successful tool execution belongs on this surface.
                return None
            if isinstance(event.get("content"), str):
                texts.append(event["content"])
                seen = True
        elif role not in ("meta", "tool"):
            return None
    if not seen:
        return None
    return {"output": "\n".join(texts), "usage_known": False, "finish_reason": None, "native_stop_reason": None}


def run(prompt: str, env: dict, timeout: float, model: str | None = None,
        system: str | None = None) -> tuple[subprocess.CompletedProcess[str], int]:
    cmd = build_command(prompt, env["HOME"], model, system)
    started = time.perf_counter()
    proc = subprocess.run(cmd, env=env, cwd=env["HOME"], capture_output=True, text=True, timeout=timeout)
    return proc, int((time.perf_counter() - started) * 1000)
