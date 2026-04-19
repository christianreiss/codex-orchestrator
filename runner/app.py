import base64
import binascii
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from typing import Literal, Optional
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

import httpx
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

app = FastAPI()

DEFAULT_TIMEOUT = 8.0
DEBUG_DUMP_AUTH = os.getenv("RUNNER_DEBUG_DUMP_AUTH") == "1"
ALLOW_SECRET_DUMP = os.getenv("RUNNER_ALLOW_SECRET_DUMP") == "1"
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
RUNNER_SHARED_SECRET = os.getenv("RUNNER_SHARED_SECRET", "").strip()
RUNNER_HOME_PARENT = os.getenv("RUNNER_HOME_PARENT", "/var/tmp").strip() or "/var/tmp"
DEBUG_DUMP_ENABLED = DEBUG_DUMP_AUTH and ALLOW_SECRET_DUMP and APP_ENV != "production"


_CODEX_AVAILABLE = shutil.which("codex") is not None
_CLAUDE_AVAILABLE = shutil.which("claude") is not None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "engines": {
            "codex": {"available": _CODEX_AVAILABLE},
            "claude": {"available": _CLAUDE_AVAILABLE},
        },
    }


class VerifyRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload to test")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the probe call (seconds)"
    )


class SkillSummaryRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    slug: str = Field(..., description="Skill slug")
    manifest: str = Field(..., description="SKILL.md contents to summarize")
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the summary call (seconds)"
    )


class SkillGenerateRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    prompt: str = Field(..., description="Free-text operator request for the skill")
    slug_hint: Optional[str] = Field(None, description="Optional slug hint from the UI")
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the generation call (seconds)"
    )


class SkillAssistMessage(BaseModel):
    role: str = Field(..., description="Conversation role (user or assistant)")
    content: str = Field(..., description="Conversation message content")


class SkillAssistDraft(BaseModel):
    slug: Optional[str] = Field(None, description="Current skill slug")
    display_name: Optional[str] = Field(None, description="Current skill name")
    description: Optional[str] = Field(None, description="Current skill description")
    tags: list[str] = Field(default_factory=list, description="Current skill tags")
    what: Optional[str] = Field(None, description="Current What-this-skill-does section")
    when: Optional[str] = Field(None, description="Current When-to-use section")
    steps: Optional[str] = Field(None, description="Current Step-by-step section")


class SkillAssistRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    messages: list[SkillAssistMessage] = Field(..., description="Conversation history")
    skill: SkillAssistDraft = Field(..., description="Current skill draft")
    mode: str = Field("new", description="Whether the skill is new or existing")
    slug_locked: bool = Field(False, description="Whether the slug must stay unchanged")
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the assist call (seconds)"
    )


class MemorySummaryRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    memory_key: str = Field(..., description="Memory key identifier")
    content: str = Field(..., description="Memory content to summarize")
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the summary call (seconds)"
    )


class ProjectAssistRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    slug: str = Field(..., description="Project slug")
    project: dict = Field(..., description="Current project snapshot for drafting")
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the assist call (seconds)"
    )


class JoplinSummarizeRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    note_id: str = Field(..., description="Joplin note ID")
    title: str = Field(..., description="Note title")
    body: str = Field(..., description="Note body content")
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the summarize call (seconds)"
    )


class JoplinQueryRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    question: str = Field(..., description="Question to answer from note content")
    notes: list[dict] = Field(..., description="List of notes with title and body fields")
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the query call (seconds)"
    )


class ExecImageInput(BaseModel):
    url: str = Field(..., description="Image URL or data URL to attach")
    detail: Optional[str] = Field(None, description="Requested image detail level")


DATA_URL_RE = re.compile(
    r"^data:(?P<mime>[-\w.+/]+)?(?:;charset=[^;,]+)?;base64,(?P<data>.+)$",
    re.IGNORECASE | re.DOTALL,
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
    try:
        home_dir = tempfile.mkdtemp(prefix="codex-runner-", dir=RUNNER_HOME_PARENT)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to create runner home: {exc}")
    env["HOME"] = home_dir
    tmp_dir = os.path.join(home_dir, "tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    env["TMPDIR"] = tmp_dir
    env["TMP"] = tmp_dir
    env["TEMP"] = tmp_dir
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


# ---------------------------------------------------------------------------
# Claude Code engine helpers
# ---------------------------------------------------------------------------

ANTHROPIC_API_BASE = os.getenv("ANTHROPIC_API_BASE", "https://api.anthropic.com").rstrip("/")
CLAUDE_CLI_PATH = shutil.which("claude") or "/usr/local/bin/claude"


def _extract_anthropic_token(auth_json: dict) -> Optional[str]:
    """Pull an Anthropic API key from the auth payload."""
    auths = auth_json.get("auths", {})
    if isinstance(auths, dict):
        anthropic_entry = auths.get("api.anthropic.com")
        if isinstance(anthropic_entry, dict):
            token = anthropic_entry.get("token")
            if isinstance(token, str) and token.strip():
                return token.strip()
    tokens = auth_json.get("tokens", {})
    if isinstance(tokens, dict):
        candidate = tokens.get("anthropic_api_key")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _claude_version(env: Optional[dict] = None) -> str:
    try:
        proc = subprocess.run(
            [CLAUDE_CLI_PATH, "--version"],
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode != 0:
            return "unknown"
        parts = proc.stdout.strip().split()
        return parts[-1] if parts else "unknown"
    except Exception:
        return "unavailable"


def _prepare_claude_env(auth_json: dict) -> tuple[dict, str, str]:
    """Set up a temp HOME with an Anthropic API key for the Claude CLI."""
    if DEBUG_DUMP_ENABLED:
        try:
            debug_path = "/tmp/last-claude-auth.json"
            with open(debug_path, "w", encoding="utf-8") as fh:
                json.dump(auth_json, fh, indent=2)
            os.chmod(debug_path, 0o600)
        except Exception:
            pass

    token = _extract_anthropic_token(auth_json)
    if token is None or token.strip() == "":
        raise HTTPException(status_code=400, detail="no usable Anthropic token in auth_json")

    env = os.environ.copy()
    try:
        home_dir = tempfile.mkdtemp(prefix="claude-runner-", dir=RUNNER_HOME_PARENT)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to create runner home: {exc}")
    env["HOME"] = home_dir
    tmp_dir = os.path.join(home_dir, "tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    env["TMPDIR"] = tmp_dir
    env["TMP"] = tmp_dir
    env["TEMP"] = tmp_dir

    # Claude Code reads the API key from the environment variable.
    env["ANTHROPIC_API_KEY"] = token

    # Store the token so callers can detect rotation (same pattern as Codex).
    claude_dir = os.path.join(home_dir, ".claude")
    os.makedirs(claude_dir, exist_ok=True)
    auth_path = os.path.join(claude_dir, "auth.json")
    try:
        with open(auth_path, "w", encoding="utf-8") as fh:
            json.dump(auth_json, fh)
        os.chmod(auth_path, 0o600)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to write auth.json: {exc}")

    return env, home_dir, auth_path


def _run_claude_probe(payload) -> dict:
    """Validate an Anthropic API key with a lightweight messages API call."""
    token = _extract_anthropic_token(payload.auth_json)
    if token is None or token.strip() == "":
        raise HTTPException(status_code=400, detail="no usable Anthropic token in auth_json")

    version = _claude_version()
    timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
    start = time.perf_counter()
    try:
        resp = httpx.post(
            f"{ANTHROPIC_API_BASE}/v1/messages",
            headers={
                "x-api-key": token,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "Reply Banana if this works."}],
            },
            timeout=timeout,
        )
        latency_ms = int((time.perf_counter() - start) * 1000)

        if resp.status_code == 200:
            body = resp.json()
            text = ""
            for block in body.get("content", []):
                if block.get("type") == "text":
                    text += block.get("text", "")
            ok = "banana" in text.lower()
            result = {
                "status": "ok" if ok else "fail",
                "latency_ms": latency_ms,
                "reachable": True,
                "claude_version": version,
            }
            if not ok:
                result["reason"] = f"unexpected response: {text[:200]}"
            return result

        latency_ms = int((time.perf_counter() - start) * 1000)
        error_text = resp.text[:400]
        return {
            "status": "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            "reason": f"HTTP {resp.status_code}: {error_text}",
            "claude_version": version,
        }
    except httpx.TimeoutException:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {
            "status": "fail",
            "latency_ms": latency_ms,
            "reachable": False,
            "reason": "timeout contacting Anthropic API",
            "claude_version": version,
        }
    except Exception as exc:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {
            "status": "fail",
            "latency_ms": latency_ms,
            "reachable": False,
            "reason": str(exc)[:400],
            "claude_version": version,
        }


def _build_claude_exec_cmd(
    prompt: str,
    model: Optional[str] = None,
    image_paths: Optional[list[str]] = None,
    system: Optional[str] = None,
    max_tokens: Optional[int] = None,
) -> list[str]:
    cmd = [CLAUDE_CLI_PATH, "--print", "--no-input"]
    if isinstance(model, str) and model.strip():
        cmd.extend(["--model", model.strip()])
    if isinstance(max_tokens, int) and max_tokens > 0:
        cmd.extend(["--max-tokens", str(max_tokens)])
    if isinstance(system, str) and system.strip():
        cmd.extend(["--system-prompt", system.strip()])
    # Claude Code CLI does not have an --image flag; embed file references in the prompt.
    effective_prompt = prompt
    if image_paths:
        image_notes = "\n".join(f"[Attached image: {p}]" for p in image_paths)
        effective_prompt = f"{prompt}\n\n{image_notes}"
    cmd.append(effective_prompt)
    return cmd


def _run_claude_exec(prompt: str, env: dict, timeout: float) -> tuple[subprocess.CompletedProcess[str], int]:
    cmd = _build_claude_exec_cmd(prompt)
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


def _run_engine_exec(prompt: str, env: dict, timeout: float, engine: str = "codex") -> tuple[subprocess.CompletedProcess[str], int]:
    """Dispatch to either Codex or Claude exec based on engine parameter."""
    if engine == "claude":
        return _run_claude_exec(prompt, env, timeout)
    return _run_codex_exec(prompt, env, timeout)


def _prepare_engine_env(auth_json: dict, engine: str = "codex") -> tuple[dict, str, str]:
    """Dispatch to either Codex or Claude env preparation."""
    if engine == "claude":
        return _prepare_claude_env(auth_json)
    return _prepare_codex_env(auth_json)


def _engine_version_key(engine: str) -> str:
    return "claude_version" if engine == "claude" else "codex_version"


def _engine_version(env: dict, engine: str) -> str:
    if engine == "claude":
        return _claude_version(env)
    return _codex_version(env)


def _run_codex_exec(prompt: str, env: dict, timeout: float, model: Optional[str] = None) -> tuple[subprocess.CompletedProcess[str], int]:
    cmd = _build_codex_exec_cmd(prompt, model)
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
        probe_model = os.getenv("RUNNER_CODEX_PROBE_MODEL", "gpt-5.4").strip() or None
        proc, latency_ms = _run_codex_exec("Reply Banana if this works.", env, timeout, probe_model)
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


def _sanitize_skill_line(value: str, *, max_len: int = 200) -> str:
    sanitized = " ".join(value.replace("\r", "\n").split()).strip(" \t\n\r`\"'-")
    if len(sanitized) > max_len:
        sanitized = sanitized[:max_len].rstrip(" ,;:.") + "..."
    return sanitized


def _sanitize_skill_section(value: str) -> str:
    lines = [line.rstrip() for line in value.replace("\r\n", "\n").split("\n")]
    while lines and lines[0] == "":
        lines.pop(0)
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines).strip()


def _sanitize_project_section(value: str, *, max_len: int = 4000) -> str:
    sanitized = _sanitize_skill_section(value)
    if len(sanitized) > max_len:
        sanitized = sanitized[: max_len - 3].rstrip(" \n\r\t") + "..."
    return sanitized


def _sanitize_skill_tags(value: object) -> list[str]:
    if not isinstance(value, list):
        return []

    tags: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        tag = _sanitize_skill_line(item, max_len=60)
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def _extract_json_payload(text: str) -> dict:
    candidate = text.strip()
    if candidate.startswith("```") and candidate.endswith("```"):
        lines = candidate.splitlines()
        if len(lines) >= 3:
            candidate = "\n".join(lines[1:-1]).strip()
    parsed = json.loads(candidate)
    if not isinstance(parsed, dict):
        raise ValueError("runner response was not a JSON object")
    return parsed


def _normalize_generated_skill(data: dict) -> dict:
    required_keys = ["slug", "display_name", "description", "what", "when", "steps"]
    for key in required_keys:
        if not isinstance(data.get(key), str) or not data[key].strip():
            raise ValueError(f"missing required field: {key}")

    return {
        "slug": _sanitize_skill_line(data["slug"], max_len=255),
        "display_name": _sanitize_skill_line(data["display_name"], max_len=120),
        "description": _sanitize_skill_line(data["description"], max_len=180),
        "tags": _sanitize_skill_tags(data.get("tags", [])),
        "what": _sanitize_skill_section(data["what"]),
        "when": _sanitize_skill_section(data["when"]),
        "steps": _sanitize_skill_section(data["steps"]),
    }


def _normalize_assisted_skill(data: dict) -> dict:
    normalized = _normalize_generated_skill(data)
    assistant_message = _sanitize_skill_line(data.get("assistant_message", ""), max_len=240)
    if not assistant_message:
        raise ValueError("missing required field: assistant_message")
    normalized["assistant_message"] = assistant_message
    return normalized


def _normalize_assisted_project(data: dict) -> dict:
    assistant_message = _sanitize_skill_line(data.get("assistant_message", ""), max_len=240)
    if not assistant_message:
        raise ValueError("missing required field: assistant_message")

    def _string_value(key: str) -> str:
        value = data.get(key, "")
        return value if isinstance(value, str) else ""

    return {
        "assistant_message": assistant_message,
        "title": _sanitize_skill_line(_string_value("title"), max_len=120),
        "name": _sanitize_skill_line(_string_value("name"), max_len=120),
        "description": _sanitize_skill_line(_string_value("description"), max_len=220),
        "roster_markdown": _sanitize_project_section(_string_value("roster_markdown"), max_len=4000),
    }


def _skill_summary_prompt(slug: str, manifest: str) -> str:
    return (
        "Summarize this Codex skill for an AGENTS.md skills inventory. "
        "Return exactly one plain sentence, no markdown, no quotes, max 18 words. "
        "Describe what the skill is used for, not implementation details.\n\n"
        f"Skill slug: {slug}\n\n"
        "SKILL.md:\n"
        f"{manifest}"
    )


def _memory_summary_prompt(memory_key: str, content: str) -> str:
    truncated = content[:4000]
    if len(content) > 4000:
        truncated += "\n... (truncated)"
    return (
        "Summarize this memory entry for an AGENTS.md memory inventory. "
        "Return exactly one plain sentence, no markdown, no quotes, max 18 words. "
        "Describe what information this memory contains.\n\n"
        f"Memory key: {memory_key}\n\n"
        "Content:\n"
        f"{truncated}"
    )


def _skill_generation_prompt(prompt: str, slug_hint: str) -> str:
    slug_hint_block = f"Existing slug hint: {slug_hint}\n\n" if slug_hint else ""
    return (
        "You are generating a Codex SKILL.md draft for an admin dashboard.\n"
        "Return exactly one JSON object and nothing else.\n"
        "Required keys: slug, display_name, description, tags, what, when, steps.\n"
        "Rules:\n"
        "- slug: lowercase letters/numbers/dot/underscore/dash only\n"
        "- display_name: short human label\n"
        "- description: one sentence for search/results\n"
        "- tags: short string array\n"
        "- what/when/steps: plain text sections, no markdown headings\n"
        "- steps should be concise operator instructions with guardrails and success signals\n\n"
        f"{slug_hint_block}"
        "Operator request:\n"
        f"{prompt}"
    )


def _skill_assist_prompt(payload: SkillAssistRequest) -> str:
    skill = {
        "slug": payload.skill.slug or "",
        "display_name": payload.skill.display_name or "",
        "description": payload.skill.description or "",
        "tags": payload.skill.tags or [],
        "what": payload.skill.what or "",
        "when": payload.skill.when or "",
        "steps": payload.skill.steps or "",
    }
    messages = [
        {"role": message.role, "content": message.content}
        for message in payload.messages
    ]
    slug_rule = (
        f'- Keep slug exactly "{skill["slug"]}" because it is locked.\n'
        if payload.slug_locked and skill["slug"]
        else "- Slug may change if the conversation requires it.\n"
    )
    return (
        "You are revising a Codex SKILL.md draft inside an admin dashboard.\n"
        "Return exactly one JSON object and nothing else.\n"
        "Required keys: assistant_message, slug, display_name, description, tags, what, when, steps.\n"
        "Rules:\n"
        "- assistant_message: short plain-text explanation of what changed\n"
        "- slug: lowercase letters/numbers/dot/underscore/dash only\n"
        "- display_name: short human label\n"
        "- description: one sentence for search/results\n"
        "- tags: short string array\n"
        "- what/when/steps: plain text sections, no markdown headings\n"
        "- steps should be concise operator instructions with guardrails and success signals\n"
        f'- Mode: {payload.mode}\n'
        f"- Slug locked: {'yes' if payload.slug_locked else 'no'}\n"
        f"{slug_rule}\n"
        "Current skill draft JSON:\n"
        f"{json.dumps(skill, ensure_ascii=False)}\n\n"
        "Conversation history JSON:\n"
        f"{json.dumps(messages, ensure_ascii=False)}"
    )


def _project_assist_prompt(payload: ProjectAssistRequest) -> str:
    snapshot = json.dumps(payload.project, ensure_ascii=False)
    return (
        "You are drafting safe autofill suggestions for an admin project workspace.\n"
        "Return exactly one JSON object and nothing else.\n"
        "Required keys: assistant_message, title, name, description, roster_markdown.\n"
        "Rules:\n"
        "- assistant_message: short plain-text summary of what you could infer\n"
        "- title: short human-facing project title; empty string if uncertain\n"
        "- name: short internal/project label; empty string if uncertain\n"
        "- description: one sentence describing what the project is doing and why; empty string if uncertain\n"
        "- roster_markdown: concise markdown bullets or short prose for ownership/handoff context; empty string if current context is too weak\n"
        "- Prefer conservative inference from the provided project snapshot only\n"
        "- Do not invent domains, systems, owners, or requirements not supported by the snapshot\n"
        "- If a current value is already strong and you would not improve it, repeat it or return an empty string\n\n"
        f"Project slug: {payload.slug}\n\n"
        "Current project snapshot JSON:\n"
        f"{snapshot}"
    )


def _joplin_summarize_prompt(title: str, body: str) -> str:
    truncated = body[:3000] + ("..." if len(body) > 3000 else "")
    return (
        'Summarize the following Joplin note in one concise sentence (max 200 characters). '
        'Return ONLY a JSON object with a single key "summary" containing the summary string. No other text.\n\n'
        f"Note title: {title}\n\n"
        f"Note content:\n{truncated}\n\n"
        'Return format: {"summary": "one sentence summary here"}'
    )


def _extract_joplin_json_key(raw: str, key: str, max_len: int = 0) -> str:
    """Parse a single string value from a JSON object in Codex output."""
    raw = raw.strip()
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            parsed = json.loads(raw[start:end])
            value = parsed.get(key, "")
            if isinstance(value, str) and value.strip():
                result = value.strip()
                return result[:max_len] if max_len else result
        except (json.JSONDecodeError, ValueError):
            pass
    return ""


def _extract_joplin_summary(raw: str) -> str:
    value = _extract_joplin_json_key(raw, "summary", max_len=200)
    if value:
        return value
    for line in raw.strip().splitlines():
        line = line.strip()
        if line and not line.startswith("{") and not line.startswith("}"):
            return line[:200]
    return ""


def _extract_joplin_answer(raw: str) -> str:
    return _extract_joplin_json_key(raw, "answer") or raw.strip()[:2000]


def _joplin_query_prompt(question: str, notes: list[dict]) -> str:
    parts = []
    for i, note in enumerate(notes[:5]):
        title = str(note.get("title", "Untitled"))
        body = str(note.get("body", ""))[:1500]
        parts.append(f"\n--- Note {i + 1}: {title} ---\n{body}\n")
    notes_text = "".join(parts)
    return (
        "Based on the following Joplin notes, answer the question. "
        'Return ONLY a JSON object with a single key "answer". No other text.\n\n'
        f"Question: {question}\n\n"
        f"Notes:\n{notes_text}\n\n"
        'Return format: {"answer": "your answer here"}'
    )


def _summarize_joplin_note(payload: JoplinSummarizeRequest) -> dict:
    note_id = payload.note_id.strip()
    title = payload.title.strip()
    if note_id == "":
        raise HTTPException(status_code=400, detail="note_id is required")

    engine = payload.engine
    env, home_dir, _ = _prepare_engine_env(payload.auth_json, engine)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_engine_exec(
            _joplin_summarize_prompt(title, payload.body), env, timeout, engine
        )
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        summary = _extract_joplin_summary(stdout)
        ok = proc.returncode == 0 and summary != ""

        result: dict = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            _engine_version_key(engine): _engine_version(env, engine),
        }
        if ok:
            result["note_id"] = note_id
            result["summary"] = summary
            return result

        parts = [p for p in [stderr, stdout] if p]
        message = "\n".join(parts).strip()
        result["reason"] = message[:400] if message else "summarize failed"
        return result
    finally:
        shutil.rmtree(home_dir, ignore_errors=True)


def _query_joplin_notes(payload: JoplinQueryRequest) -> dict:
    question = payload.question.strip()
    if question == "":
        raise HTTPException(status_code=400, detail="question is required")
    if not payload.notes:
        raise HTTPException(status_code=400, detail="notes are required")

    engine = payload.engine
    env, home_dir, _ = _prepare_engine_env(payload.auth_json, engine)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_engine_exec(
            _joplin_query_prompt(question, payload.notes), env, timeout, engine
        )
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        answer = _extract_joplin_answer(stdout)
        ok = proc.returncode == 0 and answer != ""

        result: dict = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            _engine_version_key(engine): _engine_version(env, engine),
        }
        if ok:
            result["question"] = question
            result["answer"] = answer
            return result

        parts = [p for p in [stderr, stdout] if p]
        message = "\n".join(parts).strip()
        result["reason"] = message[:400] if message else "query failed"
        return result
    finally:
        shutil.rmtree(home_dir, ignore_errors=True)


def _summarize_skill(payload: SkillSummaryRequest) -> dict:
    slug = payload.slug.strip()
    manifest = payload.manifest.strip()
    if slug == "":
        raise HTTPException(status_code=400, detail="slug is required")
    if manifest == "":
        raise HTTPException(status_code=400, detail="manifest is required")

    engine = payload.engine
    env, home_dir, _ = _prepare_engine_env(payload.auth_json, engine)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_engine_exec(_skill_summary_prompt(slug, manifest), env, timeout, engine)
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        summary = _sanitize_skill_summary(stdout)
        ok = proc.returncode == 0 and summary != ""

        result = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            _engine_version_key(engine): _engine_version(env, engine),
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


def _summarize_memory(payload: MemorySummaryRequest) -> dict:
    memory_key = payload.memory_key.strip()
    content = payload.content.strip()
    if memory_key == "":
        raise HTTPException(status_code=400, detail="memory_key is required")
    if content == "":
        raise HTTPException(status_code=400, detail="content is required")

    engine = payload.engine
    env, home_dir, _ = _prepare_engine_env(payload.auth_json, engine)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_engine_exec(_memory_summary_prompt(memory_key, content), env, timeout, engine)
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        summary = _sanitize_skill_summary(stdout)
        ok = proc.returncode == 0 and summary != ""

        result = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            _engine_version_key(engine): _engine_version(env, engine),
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


def _generate_skill(payload: SkillGenerateRequest) -> dict:
    prompt = payload.prompt.strip()
    slug_hint = (payload.slug_hint or "").strip()
    if prompt == "":
        raise HTTPException(status_code=400, detail="prompt is required")

    engine = payload.engine
    env, home_dir, _ = _prepare_engine_env(payload.auth_json, engine)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_engine_exec(_skill_generation_prompt(prompt, slug_hint), env, timeout, engine)
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()

        try:
            generated = _normalize_generated_skill(_extract_json_payload(stdout))
        except Exception as exc:
            generated = None
            parse_error = str(exc)
        else:
            parse_error = ""

        ok = proc.returncode == 0 and generated is not None
        result = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            _engine_version_key(engine): _engine_version(env, engine),
        }
        if ok and generated is not None:
            result.update(generated)
            return result

        parts = [p for p in [parse_error, stderr, stdout] if p]
        message = "\n".join(parts).strip()
        result["reason"] = message[:600] if message else "skill generation failed"
        return result
    finally:
        shutil.rmtree(home_dir, ignore_errors=True)


def _assist_skill(payload: SkillAssistRequest) -> dict:
    if not payload.messages:
        raise HTTPException(status_code=400, detail="messages are required")

    engine = payload.engine
    env, home_dir, _ = _prepare_engine_env(payload.auth_json, engine)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_engine_exec(_skill_assist_prompt(payload), env, timeout, engine)
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()

        try:
            assisted = _normalize_assisted_skill(_extract_json_payload(stdout))
        except Exception as exc:
            assisted = None
            parse_error = str(exc)
        else:
            parse_error = ""

        ok = proc.returncode == 0 and assisted is not None
        result = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            _engine_version_key(engine): _engine_version(env, engine),
        }
        if ok and assisted is not None:
            result.update(assisted)
            return result

        parts = [p for p in [parse_error, stderr, stdout] if p]
        message = "\n".join(parts).strip()
        result["reason"] = message[:600] if message else "skill assist failed"
        return result
    finally:
        shutil.rmtree(home_dir, ignore_errors=True)


def _assist_project(payload: ProjectAssistRequest) -> dict:
    slug = payload.slug.strip()
    if slug == "":
        raise HTTPException(status_code=400, detail="slug is required")
    if not isinstance(payload.project, dict) or not payload.project:
        raise HTTPException(status_code=400, detail="project is required")

    engine = payload.engine
    env, home_dir, _ = _prepare_engine_env(payload.auth_json, engine)
    try:
        timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
        proc, latency_ms = _run_engine_exec(_project_assist_prompt(payload), env, timeout, engine)
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()

        try:
            assisted = _normalize_assisted_project(_extract_json_payload(stdout))
        except Exception as exc:
            assisted = None
            parse_error = str(exc)
        else:
            parse_error = ""

        ok = proc.returncode == 0 and assisted is not None
        result = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            _engine_version_key(engine): _engine_version(env, engine),
        }
        if ok and assisted is not None:
            result.update(assisted)
            return result

        parts = [p for p in [parse_error, stderr, stdout] if p]
        message = "\n".join(parts).strip()
        result["reason"] = message[:600] if message else "project assist failed"
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


@app.post("/verify-claude")
def verify_claude(payload: VerifyRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _run_claude_probe(payload)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/skills/summarize")
def summarize_skill_health():
    return {"status": "ok"}


@app.get("/skills/generate")
def generate_skill_health():
    return {"status": "ok"}


@app.get("/skills/assist")
def assist_skill_health():
    return {"status": "ok"}


@app.get("/projects/assist")
def assist_project_health():
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


@app.post("/skills/generate")
def generate_skill(payload: SkillGenerateRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _generate_skill(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="skill generation timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/skills/assist")
def assist_skill(payload: SkillAssistRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _assist_skill(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="skill assist timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/projects/assist")
def assist_project(payload: ProjectAssistRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _assist_project(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="project assist timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/memories/summarize")
def summarize_memory_health():
    return {"status": "ok"}


@app.post("/memories/summarize")
def summarize_memory(payload: MemorySummaryRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _summarize_memory(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="summary timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


# --- OpenAI-compatible prompt execution ---


class ExecRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    prompt: str = Field(..., description="Prompt to execute")
    images: list[ExecImageInput] = Field(default_factory=list, description="Optional images to attach")
    model: Optional[str] = Field(None, description="Model to execute")
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    max_tokens: Optional[int] = Field(None, description="Maximum tokens for response")
    temperature: Optional[float] = Field(None, description="Sampling temperature")
    top_p: Optional[float] = Field(None, description="Nucleus sampling threshold")
    top_k: Optional[int] = Field(None, description="Top-k sampling")
    stop_sequences: Optional[list[str]] = Field(None, description="Stop sequences")
    system: Optional[str] = Field(None, description="System prompt")
    timeout_seconds: Optional[float] = Field(
        None, description="Timeout for the exec call (seconds)"
    )


def _guess_image_suffix(mime_type: Optional[str], source_url: str) -> str:
    mime = (mime_type or "").split(";", 1)[0].strip().lower()
    suffix = mimetypes.guess_extension(mime) if mime else None
    if suffix == ".jpe":
        suffix = ".jpg"
    if suffix:
        return suffix

    path = urllib_parse.urlparse(source_url).path
    guessed = os.path.splitext(path)[1]
    return guessed or ".img"


def _materialize_data_url_image(url: str, image_dir: str, index: int) -> str:
    match = DATA_URL_RE.match(url.strip())
    if not match:
        raise HTTPException(status_code=400, detail="invalid base64 image data URL")

    try:
        raw = base64.b64decode(match.group("data"), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid base64 image data URL: {exc}")

    if raw == b"":
        raise HTTPException(status_code=400, detail="image data URL is empty")

    suffix = _guess_image_suffix(match.group("mime"), url)
    path = os.path.join(image_dir, f"image-{index}{suffix}")
    with open(path, "wb") as fh:
        fh.write(raw)
    return path


def _materialize_remote_image(url: str, image_dir: str, index: int) -> str:
    parsed = urllib_parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="image URLs must use http, https, or data")

    try:
        req = urllib_request.Request(
            url,
            headers={"User-Agent": "codex-orchestrator-runner/1.0"},
        )
        with urllib_request.urlopen(req, timeout=15.0) as response:
            raw = response.read()
            mime_type = response.headers.get_content_type()
    except urllib_error.HTTPError as exc:
        raise HTTPException(status_code=400, detail=f"image download failed with HTTP {exc.code}")
    except urllib_error.URLError as exc:
        raise HTTPException(status_code=400, detail=f"image download failed: {exc.reason}")

    if raw == b"":
        raise HTTPException(status_code=400, detail="downloaded image is empty")

    suffix = _guess_image_suffix(mime_type, url)
    path = os.path.join(image_dir, f"image-{index}{suffix}")
    with open(path, "wb") as fh:
        fh.write(raw)
    return path


def _materialize_exec_images(images: list[ExecImageInput], home_dir: str) -> list[str]:
    if not images:
        return []

    image_dir = os.path.join(home_dir, "exec-images")
    os.makedirs(image_dir, exist_ok=True)

    paths = []
    for index, image in enumerate(images, start=1):
        url = image.url.strip()
        if url == "":
            raise HTTPException(status_code=400, detail="image url is required")

        if url.lower().startswith("data:"):
            paths.append(_materialize_data_url_image(url, image_dir, index))
        else:
            paths.append(_materialize_remote_image(url, image_dir, index))

    return paths


def _build_codex_exec_cmd(prompt: str, model: Optional[str], image_paths: Optional[list[str]] = None) -> list[str]:
    cmd = ["/usr/local/bin/codex", "exec"]
    if isinstance(model, str) and model.strip():
        cmd.extend(["--model", model.strip()])
    for image_path in image_paths or []:
        cmd.extend(["--image", image_path])
    cmd.extend([
        "-s",
        "read-only",
        "--skip-git-repo-check",
        prompt,
    ])
    return cmd


def _exec_prompt(payload: ExecRequest) -> dict:
    prompt = payload.prompt.strip()
    if prompt == "":
        raise HTTPException(status_code=400, detail="prompt is required")

    engine = payload.engine
    env, home_dir, auth_path = _prepare_engine_env(payload.auth_json, engine)
    try:
        timeout = payload.timeout_seconds or 30.0
        image_paths = _materialize_exec_images(payload.images or [], home_dir)
        if engine == "claude":
            cmd = _build_claude_exec_cmd(
                prompt,
                payload.model,
                image_paths=image_paths,
                system=payload.system,
                max_tokens=payload.max_tokens,
            )
        else:
            cmd = _build_codex_exec_cmd(prompt, payload.model, image_paths)
        start = time.perf_counter()
        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        latency_ms = int((time.perf_counter() - start) * 1000)
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()

        result: dict = {
            "latency_ms": latency_ms,
            "reachable": True,
        }

        try:
            with open(auth_path, "r", encoding="utf-8") as fh:
                updated_auth = json.load(fh)
        except Exception:
            updated_auth = None
        if isinstance(updated_auth, dict) and updated_auth != payload.auth_json:
            result["updated_auth"] = updated_auth

        if proc.returncode != 0:
            result["status"] = "fail"
            parts = [p for p in [stderr, stdout] if p]
            message = "\n".join(parts).strip()
            result["output"] = ""
            result["error"] = message[:500] if message else f"{engine} exec failed"
            return result

        result["status"] = "ok"
        result["output"] = stdout
        return result
    finally:
        shutil.rmtree(home_dir, ignore_errors=True)


@app.get("/exec")
def exec_health():
    return {"status": "ok"}


@app.post("/exec")
def exec_prompt(payload: ExecRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _exec_prompt(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="exec timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/joplin/summarize")
def joplin_summarize_health():
    return {"status": "ok"}


@app.post("/joplin/summarize")
def joplin_summarize(payload: JoplinSummarizeRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _summarize_joplin_note(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="summarize timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/joplin/query")
def joplin_query_health():
    return {"status": "ok"}


@app.post("/joplin/query")
def joplin_query(payload: JoplinQueryRequest, request: Request):
    if RUNNER_SHARED_SECRET:
        provided = request.headers.get("x-runner-auth", "")
        if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
            raise HTTPException(status_code=401, detail="unauthorized")

    try:
        return _query_joplin_notes(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="query timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
