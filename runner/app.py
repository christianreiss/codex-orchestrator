import json
import os
import secrets
import shutil
import subprocess
import tempfile
import time
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

app = FastAPI()

DEFAULT_TIMEOUT = 8.0
DEBUG_DUMP_AUTH = os.getenv("RUNNER_DEBUG_DUMP_AUTH") == "1"
ALLOW_SECRET_DUMP = os.getenv("RUNNER_ALLOW_SECRET_DUMP") == "1"
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
RUNNER_SHARED_SECRET = os.getenv("RUNNER_SHARED_SECRET", "").strip()
DEBUG_DUMP_ENABLED = DEBUG_DUMP_AUTH and ALLOW_SECRET_DUMP and APP_ENV != "production"


@app.get("/health")
def health():
    return {"status": "ok"}


class VerifyRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload to test")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the probe call (seconds)"
    )


class SkillSummaryRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    slug: str = Field(..., description="Skill slug")
    manifest: str = Field(..., description="SKILL.md contents to summarize")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the summary call (seconds)"
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


def _prepare_codex_env(auth_json: dict) -> tuple[dict, str, str]:
    if DEBUG_DUMP_ENABLED:
        # Debug helper: persist the incoming auth.json so it can be inspected from the container.
        # WARNING: contains secrets; enable only when debugging runner probes.
        try:
            debug_path = "/tmp/last-auth.json"
            with open(debug_path, "w", encoding="utf-8") as fh:
                json.dump(auth_json, fh, indent=2)
            os.chmod(debug_path, 0o600)
        except Exception:
            pass

    token = _extract_openai_token(auth_json)
    if token is None or token.strip() == "":
        raise HTTPException(status_code=400, detail="no usable token in auth_json")

    env = os.environ.copy()
    home_dir = tempfile.mkdtemp(prefix="codex-runner-")
    env["HOME"] = home_dir
    codex_dir = os.path.join(home_dir, ".codex")
    os.makedirs(codex_dir, exist_ok=True)
    auth_path = os.path.join(codex_dir, "auth.json")
    try:
        with open(auth_path, "w", encoding="utf-8") as fh:
            json.dump(auth_json, fh)
        os.chmod(auth_path, 0o600)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to write auth.json: {exc}")

    env.setdefault("CODEX_SYNC_BASE_URL", os.environ.get("CODEX_SYNC_BASE_URL", "http://api"))
    env["CODEX_SYNC_OPTIONAL"] = "1"
    env["CODEX_SYNC_BAKED"] = "0"

    return env, home_dir, auth_path


def _run_codex_exec(prompt: str, env: dict, timeout: float) -> tuple[subprocess.CompletedProcess[str], int]:
    cmd = [
        "/usr/local/bin/codex",
        "exec",
        prompt,
        "-s",
        "read-only",
        "--skip-git-repo-check",
    ]
    start = time.perf_counter()
    proc = subprocess.run(
        cmd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    latency_ms = int((time.perf_counter() - start) * 1000)
    return proc, latency_ms


def _run_probe(payload: VerifyRequest) -> dict:
    env, home_dir, auth_path = _prepare_codex_env(payload.auth_json)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_codex_exec("Reply Banana if this works.", env, timeout)
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
    finally:
        shutil.rmtree(home_dir, ignore_errors=True)


def _sanitize_skill_summary(text: str) -> str:
    summary = " ".join(text.replace("\r", "\n").split())
    summary = summary.strip(" \t\n\r`\"'-")
    if summary.startswith("* "):
        summary = summary[2:].strip()
    if summary.startswith("- "):
        summary = summary[2:].strip()
    if len(summary) > 180:
        summary = summary[:177].rstrip(" ,;:.") + "..."
    return summary


def _skill_summary_prompt(slug: str, manifest: str) -> str:
    return (
        "Summarize this Codex skill for an AGENTS.md skills inventory. "
        "Return exactly one plain sentence, no markdown, no quotes, max 18 words. "
        "Describe what the skill is used for, not implementation details.\n\n"
        f"Skill slug: {slug}\n\n"
        "SKILL.md:\n"
        f"{manifest}"
    )


def _summarize_skill(payload: SkillSummaryRequest) -> dict:
    slug = payload.slug.strip()
    manifest = payload.manifest.strip()
    if slug == "":
        raise HTTPException(status_code=400, detail="slug is required")
    if manifest == "":
        raise HTTPException(status_code=400, detail="manifest is required")

    env, home_dir, _ = _prepare_codex_env(payload.auth_json)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_codex_exec(_skill_summary_prompt(slug, manifest), env, timeout)
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        summary = _sanitize_skill_summary(stdout)
        ok = proc.returncode == 0 and summary != ""

        result = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            "codex_version": _codex_version(env),
        }
        if ok:
            result["summary"] = summary
            return result

        parts = [p for p in [stderr, stdout] if p]
        message = "\n".join(parts).strip()
        result["reason"] = message[:400] if message else "summary failed"
        return result
    finally:
        shutil.rmtree(home_dir, ignore_errors=True)


@app.post("/verify")
def verify(payload: VerifyRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _run_probe(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="probe timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/skills/summarize")
def summarize_skill_health():
    return {"status": "ok"}


@app.post("/skills/summarize")
def summarize_skill(payload: SkillSummaryRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _summarize_skill(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="summary timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
