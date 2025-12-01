import json
import os
import subprocess
import tempfile
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI()

DEFAULT_TIMEOUT = 8.0
DEBUG_DUMP_AUTH = os.getenv("RUNNER_DEBUG_DUMP_AUTH") == "1"


@app.get("/health")
def health():
    return {"status": "ok"}


class VerifyRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload to test")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the probe call (seconds)"
    )


def _extract_openai_token(auth_json: dict) -> Optional[str]:
    auths = auth_json.get("auths", {})
    if isinstance(auths, dict):
        openai_entry = auths.get("api.openai.com")
        if isinstance(openai_entry, dict):
            token = openai_entry.get("token")
            if isinstance(token, str) and token.strip():
                return token.strip()
    tokens = auth_json.get("tokens", {})
    if isinstance(tokens, dict):
        candidate = tokens.get("access_token") or tokens.get("openai_api_key")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _codex_version(env: dict) -> str:
    proc = subprocess.run(
        ["/usr/local/bin/codex", "--version"],
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return "unknown"
    parts = proc.stdout.strip().split()
    return parts[-1] if parts else "unknown"


def _run_probe(payload: VerifyRequest) -> dict:
    if DEBUG_DUMP_AUTH:
        # Debug helper: persist the incoming auth.json so it can be inspected from the container.
        # WARNING: contains secrets; enable only when debugging runner probes.
        try:
            debug_path = "/tmp/last-auth.json"
            with open(debug_path, "w", encoding="utf-8") as fh:
                json.dump(payload.auth_json, fh, indent=2)
            os.chmod(debug_path, 0o600)
        except Exception:
            pass

    token = _extract_openai_token(payload.auth_json)
    if token is None or token.strip() == "":
        raise HTTPException(status_code=400, detail="no usable token in auth_json")

    env = os.environ.copy()
    home_dir = env.setdefault("HOME", tempfile.mkdtemp(prefix="codex-runner-"))
    codex_dir = os.path.join(home_dir, ".codex")
    os.makedirs(codex_dir, exist_ok=True)
    auth_path = os.path.join(codex_dir, "auth.json")
    try:
        with open(auth_path, "w", encoding="utf-8") as fh:
            json.dump(payload.auth_json, fh)
        os.chmod(auth_path, 0o600)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to write auth.json: {exc}")

    env.setdefault("CODEX_SYNC_BASE_URL", os.environ.get("CODEX_SYNC_BASE_URL", "http://api"))
    env["CODEX_SYNC_OPTIONAL"] = "1"
    env["CODEX_SYNC_BAKED"] = "0"

    timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
    probe_cmd = [
        "/usr/local/bin/codex",
        "exec",
        "Reply Banana if this works.",
        "--dangerously-bypass-approvals-and-sandbox",
        "-s",
        "danger-full-access",
        "--skip-git-repo-check",
    ]

    start = time.perf_counter()
    proc = subprocess.run(
        probe_cmd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    latency_ms = int((time.perf_counter() - start) * 1000)
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()

    ok = proc.returncode == 0 and "banana" in stdout.lower()
    result = {
        "status": "ok" if ok else "fail",
        "latency_ms": latency_ms,
        "reachable": True,
        "codex_version": _codex_version(env),
    }
    try:
        with open(auth_path, "r", encoding="utf-8") as fh:
            updated_auth = json.load(fh)
    except Exception:
        updated_auth = None
    if isinstance(updated_auth, dict) and updated_auth != payload.auth_json:
        result["updated_auth"] = updated_auth
    if not ok:
        parts = [p for p in [stderr, stdout] if p]
        message = "\n".join(parts).strip()
        result["reason"] = message[:400] if message else "probe failed"
    return result


@app.post("/verify")
def verify(payload: VerifyRequest):
    try:
        return _run_probe(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="probe timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
