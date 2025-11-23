import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI()

TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")
DEFAULT_TIMEOUT = 8.0


class VerifyRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload to test")
    base_url: Optional[str] = Field(None, description="Override CODEX_SYNC_BASE_URL")
    probe: Optional[str] = Field("login", description="cdx subcommand to run after --")
    probe_args: Optional[List[str]] = Field(
        None, description="Additional args for the probe command"
    )
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the probe call (seconds)"
    )


def _validated_probe_tokens(probe: str, probe_args: Optional[List[str]]) -> List[str]:
    if not TOKEN_PATTERN.match(probe):
        raise HTTPException(status_code=400, detail="invalid probe token")
    args: List[str] = []
    for item in probe_args or ["status"]:
        if not TOKEN_PATTERN.match(item):
            raise HTTPException(status_code=400, detail="invalid probe arg")
        args.append(item)
    return [probe] + args


def _wrapper_version(env: dict) -> str:
    proc = subprocess.run(
        ["/app/cdx", "--wrapper-version"],
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return "unknown"
    parts = proc.stdout.strip().split()
    return parts[-1] if parts else "unknown"


def _run_probe(payload: VerifyRequest) -> dict:
    tmpdir = tempfile.mkdtemp(prefix="codex-runner-")
    try:
        env = os.environ.copy()
        env["HOME"] = tmpdir
        env["CODEX_SYNC_BASE_URL"] = payload.base_url or env.get(
            "CODEX_SYNC_BASE_URL", "http://api"
        )
        env.setdefault("CODEX_SYNC_ALLOW_INSECURE", "1")
        env.setdefault("CODEX_SYNC_OPTIONAL", "1")

        codex_home = os.path.join(tmpdir, ".codex")
        os.makedirs(codex_home, exist_ok=True)
        auth_path = os.path.join(codex_home, "auth.json")
        with open(auth_path, "w", encoding="utf-8") as fh:
            json.dump(payload.auth_json, fh)

        probe_cmd = ["/app/cdx"] + _validated_probe_tokens(
            payload.probe or "login", payload.probe_args
        )
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT

        start = time.perf_counter()
        version_proc = subprocess.run(
            ["/app/cdx", "--wrapper-version"],
            env=env,
            capture_output=True,
            text=True,
        )
        if version_proc.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail="cdx wrapper not runnable",
            )

        proc = subprocess.run(
            probe_cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        updated_auth = None
        try:
            with open(auth_path, "r", encoding="utf-8") as fh:
                current_auth = json.load(fh)
                if isinstance(current_auth, dict) and current_auth != payload.auth_json:
                    updated_auth = current_auth
        except Exception:
            updated_auth = None

        latency_ms = int((time.perf_counter() - start) * 1000)
        result = {
            "status": "ok" if proc.returncode == 0 else "fail",
            "latency_ms": latency_ms,
            "wrapper_version": _wrapper_version(env),
        }
        if proc.returncode != 0:
            stderr = (proc.stderr or "").strip()
            stdout = (proc.stdout or "").strip()
            parts = [p for p in [stderr, stdout] if p]
            message = "\n".join(parts)
            result["reason"] = message[:400] if message else "probe failed"
        if updated_auth is not None:
            result["updated_auth"] = updated_auth
            result.setdefault("reason", "auth.json changed during probe")
        return result
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/verify")
def verify(payload: VerifyRequest):
    try:
        return _run_probe(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="probe timeout")
