import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from typing import Literal, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

import runner_engines
from images import ImageLimits, ImagePolicyError, materialize_images

app = FastAPI()

DEFAULT_TIMEOUT = 8.0
DEBUG_DUMP_AUTH = os.getenv("RUNNER_DEBUG_DUMP_AUTH") == "1"
ALLOW_SECRET_DUMP = os.getenv("RUNNER_ALLOW_SECRET_DUMP") == "1"
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
RUNNER_SHARED_SECRET = os.getenv("RUNNER_SHARED_SECRET", "").strip()
RUNNER_HOME_PARENT = os.getenv("RUNNER_HOME_PARENT", "/var/tmp").strip() or "/var/tmp"
DEBUG_DUMP_ENABLED = DEBUG_DUMP_AUTH and ALLOW_SECRET_DUMP and APP_ENV != "production"


# Probed once at import: the binaries cannot appear or change version inside a
# running container, and re-shelling out to two CLIs on every healthcheck would
# put a 10-second worst case in front of the orchestrator's liveness probe.
# Resolved at import: an unparseable RUNNER_MAX_* override is a startup error,
# not a silent fall back to the default bound.
IMAGE_LIMITS = ImageLimits.from_environment()

_ENGINE_RUNTIME = runner_engines.runtime_snapshot()
_REQUIRED_ENGINES = runner_engines.required_engines()

# Fail closed at import, before uvicorn binds a port. A runner that answers
# /verify-claude without a `claude` binary reports every valid Claude credential
# as broken, and the orchestrator quarantines the fleet's canonical auth on it.
runner_engines.assert_required_engines(_ENGINE_RUNTIME, _REQUIRED_ENGINES)


@app.get("/health")
def health():
    return runner_engines.readiness_payload(_ENGINE_RUNTIME, _REQUIRED_ENGINES)


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


class ExecImageInput(BaseModel):
    url: str = Field(..., description="Image URL or data URL to attach")
    detail: Optional[str] = Field(None, description="Requested image detail level")


def _extract_openai_token(auth_json: dict) -> Optional[str]:
    """Resolve the credential exactly as native Codex AuthDotJson does."""
    mode = auth_json.get("auth_mode")
    tokens = auth_json.get("tokens", {})

    if mode is not None:
        if mode == "apikey":
            candidate = auth_json.get("OPENAI_API_KEY")
        elif mode in ("chatgpt", "chatgptAuthTokens"):
            candidate = tokens.get("access_token") if isinstance(tokens, dict) else None
        else:
            return None
        return candidate.strip() if isinstance(candidate, str) and candidate.strip() else None

    # AuthDotJson::resolved_mode infers PAT and Bedrock before API key, then
    # defaults to ChatGPT. Those non-fleet modes are deliberately unsupported.
    if auth_json.get("personal_access_token") is not None:
        return None
    if auth_json.get("bedrock_api_key") is not None:
        return None
    if auth_json.get("OPENAI_API_KEY") is not None:
        candidate = auth_json.get("OPENAI_API_KEY")
        return candidate.strip() if isinstance(candidate, str) and candidate.strip() else None

    candidate = tokens.get("access_token") if isinstance(tokens, dict) else None
    return candidate.strip() if isinstance(candidate, str) and candidate.strip() else None


def _codex_version(env: dict) -> str:
    try:
        proc = subprocess.run(
            ["/usr/local/bin/codex", "--version"],
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return "unavailable"
    if proc.returncode != 0:
        return "unknown"
    parts = proc.stdout.strip().split()
    return parts[-1] if parts else "unknown"


# Non-secret operational variables that agent subprocesses (codex/claude) may
# legitimately need. The full runner process environment (which contains
# RUNNER_SHARED_SECRET and other operational secrets) is never copied into
# agent subprocesses -- only these allow-listed keys are passed through.
_SUBPROCESS_ENV_ALLOWLIST = (
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "TZ",
)


def _minimal_subprocess_env() -> dict:
    """Build a minimal env for codex/claude subprocesses (no inherited secrets)."""
    env = {}
    for key in _SUBPROCESS_ENV_ALLOWLIST:
        value = os.environ.get(key)
        if value is not None:
            env[key] = value
    return env


def _codex_probe_auth(auth_json: dict) -> dict:
    """auth.json copy with nothing spendable, for verification probes.

    Same rationale as _claude_probe_credentials: the canonical grant is shared
    with every host's own codex CLI, OpenAI rotates the refresh token per use,
    and a replayed spent token is a terminal "refresh token already used". The
    refresh token is blanked rather than deleted — codex's TokenData needs the
    key present to parse the ChatGPT token block at all (verified live: a
    deleted key makes codex send no auth header, an empty value probes fine).
    """
    tokens = auth_json.get("tokens")
    if not isinstance(tokens, dict) or "refresh_token" not in tokens:
        return auth_json
    stripped = dict(auth_json)
    stripped["tokens"] = {**tokens, "refresh_token": ""}
    return stripped


def _prepare_codex_env(auth_json: dict) -> tuple[dict, str, str]:
    # Every temp HOME this runner writes is refresh-incapable: no endpoint —
    # verify, exec, or the skills/memories drafts — may ever spend the fleet's
    # rotating refresh token (see _codex_probe_auth).
    auth_json = _codex_probe_auth(auth_json)
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

    env = _minimal_subprocess_env()
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
    """Resolve the same effective Claude credential the wrapper will use."""
    oauth = auth_json.get("claudeAiOauth", {})
    if isinstance(oauth, dict):
        candidate = oauth.get("accessToken")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    for key in ("api_key", "anthropic_api_key", "ANTHROPIC_API_KEY"):
        candidate = auth_json.get(key)
        if isinstance(candidate, str) and candidate.strip():
            resolved = candidate.strip()
            return None if resolved.lower().startswith("sk-ant-oat") else resolved
    tokens = auth_json.get("tokens", {})
    if isinstance(tokens, dict):
        for key in ("anthropic_api_key", "ANTHROPIC_API_KEY"):
            candidate = tokens.get(key)
            if isinstance(candidate, str) and candidate.strip():
                resolved = candidate.strip()
                return None if resolved.lower().startswith("sk-ant-oat") else resolved
    auths = auth_json.get("auths", {})
    if isinstance(auths, dict):
        anthropic_entry = auths.get("api.anthropic.com")
        if isinstance(anthropic_entry, dict):
            token = anthropic_entry.get("token")
            if isinstance(token, str) and token.strip():
                resolved = token.strip()
                return None if resolved.lower().startswith("sk-ant-oat") else resolved
    return None


def _has_claude_oauth(auth_json: dict) -> bool:
    oauth = auth_json.get("claudeAiOauth", {})
    if isinstance(oauth, dict):
        candidate = oauth.get("accessToken")
        return isinstance(candidate, str) and candidate.strip() != ""
    return False


def _claude_native_credentials(auth_json: dict) -> dict:
    """Project an orchestrator envelope onto Claude Code's native file shape."""
    oauth = auth_json.get("claudeAiOauth", {})
    if isinstance(oauth, dict):
        candidate = oauth.get("accessToken")
        if isinstance(candidate, str) and candidate.strip():
            return {"claudeAiOauth": dict(oauth)}
    return auth_json


def _claude_probe_credentials(auth_json: dict) -> dict:
    """Native projection minus refresh material, for verification probes.

    The canonical OAuth grant is shared with every host's own Claude Code, and
    Anthropic rotates the refresh token on every refresh: a probe-side refresh
    spends a token a host may hold a sibling of, and a replayed spent token gets
    the whole grant family revoked. A probe must therefore never be able to
    refresh — it validates the access token it was given, nothing more.
    """
    native = _claude_native_credentials(auth_json)
    oauth = native.get("claudeAiOauth")
    if isinstance(oauth, dict):
        stripped = {
            key: value
            for key, value in oauth.items()
            if key not in ("refreshToken", "refreshTokenExpiresAt")
        }
        return {"claudeAiOauth": stripped}
    return native


def _is_definitive_auth_rejection(message: str) -> bool:
    """Classify only credential-specific CLI failures as definitive.

    A CLI subprocess exiting non-zero proves that the probe failed, but not why:
    provider outages, quota/model errors, and local CLI failures all use the same
    exit channel. Keep those failures retryable unless the output explicitly
    identifies an authentication rejection.
    """
    text = " ".join((message or "").lower().split())
    if not text:
        return False
    phrases = (
        "refresh token already used",
        "refresh token has already been used",
        "refresh token was already used",
        "refresh token has been revoked",
        "invalid refresh token",
        "refresh token is invalid",
        "invalid_grant",
        "access token expired",
        "access token has expired",
        "access token has been revoked",
        "oauth token expired",
        "oauth token has expired",
        "oauth session expired",
        "oauth session has expired",
        "oauth session could not be refreshed",
        "failed to refresh oauth session",
        "authentication token is invalid",
        "authentication failed",
        "authentication_error",
        "invalid credentials",
        "credentials are invalid",
        "not logged in",
        "please run /login",
        "please log in",
        "please login",
    )
    if any(phrase in text for phrase in phrases):
        return True
    if "unauthorized" in text:
        return True
    if re.search(r"refresh token.{0,40}used.{0,20}already", text):
        return True
    if re.search(r"refresh token.{0,40}already.{0,20}used", text):
        return True
    return re.search(r"\b(?:api error|http|status|error)\s*[:=]?\s*401\b", text) is not None


def _anthropic_auth_headers(token: str) -> dict:
    if token.startswith("sk-ant-oat"):
        return {"Authorization": f"Bearer {token}"}
    return {"x-api-key": token}


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
        text = proc.stdout.strip()
        match = re.search(r"\b\d+\.\d+\.\d+\b", text)
        if match:
            return match.group(0)
        parts = text.split()
        return parts[0] if parts else "unknown"
    except Exception:
        return "unavailable"


def _prepare_claude_env(auth_json: dict) -> tuple[dict, str, str]:
    """Set up a temp HOME for Claude CLI validation/execution.

    Always writes refresh-stripped credentials: no runner endpoint may ever
    rotate the shared OAuth grant (see _claude_probe_credentials).
    """
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

    env = _minimal_subprocess_env()
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

    # Store the credentials so callers can detect rotation (same pattern as Codex).
    # Native Claude Code account-login credentials are *not* public Anthropic API
    # keys. The orchestrator envelope also carries last_refresh/auths metadata;
    # never put those wrapper/server fields in Claude's native credential file.
    # Current Claude versions may rewrite a non-native envelope to an empty
    # object, which looks like a destructive token rotation to the API.
    claude_dir = os.path.join(home_dir, ".claude")
    os.makedirs(claude_dir, exist_ok=True)
    auth_path = os.path.join(claude_dir, ".credentials.json")
    credentials = _claude_probe_credentials(auth_json)
    try:
        with open(auth_path, "w", encoding="utf-8") as fh:
            json.dump(credentials, fh)
        os.chmod(auth_path, 0o600)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to write credentials.json: {exc}")

    if _has_claude_oauth(auth_json) or token.startswith("sk-ant-oat"):
        env.pop("ANTHROPIC_API_KEY", None)
    else:
        env["ANTHROPIC_API_KEY"] = token

    return env, home_dir, auth_path


def _credential_readback(auth_path: str, original_auth: dict) -> dict:
    """Return an explicit post-probe state for the native credential file."""
    try:
        with open(auth_path, "r", encoding="utf-8") as fh:
            updated_auth = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        return {
            "auth_readback": "error",
            "auth_readback_error": f"{type(exc).__name__}: {exc}"[:400],
        }
    if not isinstance(updated_auth, dict):
        return {
            "auth_readback": "error",
            "auth_readback_error": "credential file did not contain a JSON object",
        }
    if updated_auth == original_auth:
        return {"auth_readback": "unchanged"}
    return {"auth_readback": "updated", "updated_auth": updated_auth}


def _run_claude_probe(payload) -> dict:
    """Validate Claude credentials.

    Genuine Anthropic API keys can use a lightweight HTTP probe. Claude Code
    OAuth credentials must be validated through the native Claude CLI, because
    their access token is not accepted as a public Anthropic API key.
    """
    token = _extract_anthropic_token(payload.auth_json)
    if token is None or token.strip() == "":
        raise HTTPException(status_code=400, detail="no usable Anthropic token in auth_json")

    timeout = payload.timeout_seconds or DEFAULT_TIMEOUT
    if _has_claude_oauth(payload.auth_json) or token.startswith("sk-ant-oat"):
        env, home_dir, auth_path = _prepare_claude_env(payload.auth_json)
        try:
            probe_started = time.perf_counter()
            try:
                proc, latency_ms = _run_claude_exec("Reply Banana if this works.", env, timeout)
            except subprocess.TimeoutExpired:
                result = {
                    "status": "fail",
                    "latency_ms": int((time.perf_counter() - probe_started) * 1000),
                    "reachable": False,
                    "definitive": False,
                    "claude_version": _claude_version(env),
                    "native_oauth": True,
                    "reason": "Claude CLI probe timed out",
                    # Probe HOMEs carry no refresh material, so the submitted
                    # credential lineage cannot have been consumed or rotated.
                    "auth_readback": "unchanged",
                }
                return result
            stdout = (proc.stdout or "").strip()
            stderr = (proc.stderr or "").strip()
            ok = proc.returncode == 0 and "banana" in stdout.lower()
            parts = [p for p in [stderr, stdout] if p]
            message = "\n".join(parts).strip()
            result = {
                "status": "ok" if ok else "fail",
                "latency_ms": latency_ms,
                "reachable": True,
                "definitive": ok or _is_definitive_auth_rejection(message),
                "claude_version": _claude_version(env),
                "native_oauth": True,
                # See above: rotation is impossible without a refresh token, so
                # any CLI rewrite of the stripped probe file carries no lineage.
                "auth_readback": "unchanged",
            }
            if not ok:
                result["reason"] = message[:400] if message else "probe failed"
            return result
        finally:
            shutil.rmtree(home_dir, ignore_errors=True)

    # API-key probes do not launch the native CLI, so collect its fleet
    # telemetry once here. OAuth probes collect the version from their isolated
    # HOME after the probe; doing both could consume two five-second version
    # budgets and overrun the API's bounded readback grace.
    version = _claude_version()
    start = time.perf_counter()
    try:
        resp = httpx.post(
            f"{ANTHROPIC_API_BASE}/v1/messages",
            headers={
                **_anthropic_auth_headers(token),
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
                "definitive": ok,
                "auth_readback": "not_applicable",
                "claude_version": version,
            }
            if not ok:
                result["reason"] = f"unexpected response: {text[:200]}"
            return result

        latency_ms = int((time.perf_counter() - start) * 1000)
        error_text = resp.text[:400]
        error_type = ""
        try:
            error_body = resp.json()
            if isinstance(error_body, dict):
                error = error_body.get("error")
                if isinstance(error, dict):
                    error_type = str(error.get("type") or "")
        except Exception:
            error_type = ""
        if resp.status_code == 429 and error_type == "rate_limit_error":
            return {
                "status": "ok",
                "latency_ms": latency_ms,
                "reachable": True,
                "definitive": True,
                "auth_limited": True,
                "auth_readback": "not_applicable",
                "reason": "Anthropic accepted the credential but returned rate_limit_error",
                "claude_version": version,
            }
        # A permission error can be model/account policy (the probe model may
        # be unavailable) rather than bad credentials. Only Anthropic's
        # authentication_error/401 is safe to turn into a fleet-wide auth
        # failure.
        auth_rejected = resp.status_code == 401 or (
            400 <= resp.status_code < 500 and error_type == "authentication_error"
        )
        return {
            "status": "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            "definitive": auth_rejected,
            "auth_readback": "not_applicable",
            "reason": f"HTTP {resp.status_code}: {error_text}",
            "claude_version": version,
        }
    except httpx.TimeoutException:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {
            "status": "fail",
            "latency_ms": latency_ms,
            "reachable": False,
            "definitive": False,
            "auth_readback": "not_applicable",
            "reason": "timeout contacting Anthropic API",
            "claude_version": version,
        }
    except Exception as exc:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {
            "status": "fail",
            "latency_ms": latency_ms,
            "reachable": False,
            "definitive": False,
            "auth_readback": "not_applicable",
            "reason": str(exc)[:400],
            "claude_version": version,
        }


def _build_claude_exec_cmd(
    prompt: str,
    model: Optional[str] = None,
    image_paths: Optional[list[str]] = None,
    system: Optional[str] = None,
    max_tokens: Optional[int] = None,
    output_format: Optional[str] = None,
) -> list[str]:
    cmd = [CLAUDE_CLI_PATH, "--print"]
    if isinstance(model, str) and model.strip():
        cmd.extend(["--model", model.strip()])
    # Claude Code CLI has no --max-tokens flag (confirmed live: the process
    # exits non-zero with "error: unknown option '--max-tokens'"). There is
    # currently no CLI-level way to cap output length on this path, so
    # max_tokens is accepted for wire-format validation but not forwarded.
    if isinstance(system, str) and system.strip():
        cmd.extend(["--system-prompt", system.strip()])
    if isinstance(output_format, str) and output_format.strip():
        cmd.extend(["--output-format", output_format.strip()])
    # Claude Code CLI does not have an --image flag; embed file references in the prompt.
    effective_prompt = prompt
    if image_paths:
        image_notes = "\n".join(f"[Attached image: {p}]" for p in image_paths)
        effective_prompt = f"{prompt}\n\n{image_notes}"
    # "--" prevents a prompt that begins with "-" from being parsed as a CLI flag.
    cmd.append("--")
    cmd.append(effective_prompt)
    return cmd


def _parse_claude_json_result(stdout: str) -> Optional[dict]:
    """Parse `claude --print --output-format json` stdout into output+usage.

    Returns None if `stdout` isn't the expected shape at all (unparseable, or
    valid JSON missing a `result` field). The caller must NOT fall back to
    treating raw `stdout` as reply text in that case: since this backend
    always requests `--output-format json` for the claude engine, a 0-exit
    process that didn't produce that shape is untrustworthy — passing it
    through as-is risks dumping a raw JSON blob to the caller as if it were
    the assistant's reply, which is worse than the bug this exists to fix.
    Fail closed instead (see call site).
    """
    try:
        parsed = json.loads(stdout)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict) or "result" not in parsed:
        return None
    usage = parsed.get("usage") if isinstance(parsed.get("usage"), dict) else {}

    def _num(key: str) -> int:
        v = usage.get(key)
        if isinstance(v, (int, float)):
            return int(v)
        return 0

    return {
        "output": parsed.get("result") or "",
        "is_error": bool(parsed.get("is_error")),
        "input_tokens": _num("input_tokens"),
        "output_tokens": _num("output_tokens"),
        "cache_creation_input_tokens": _num("cache_creation_input_tokens"),
        "cache_read_input_tokens": _num("cache_read_input_tokens"),
    }


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
        probe_model = os.getenv("RUNNER_CODEX_PROBE_MODEL", "gpt-6-astra").strip() or None
        probe_started = time.perf_counter()
        try:
            proc, latency_ms = _run_codex_exec("Reply Banana if this works.", env, timeout, probe_model)
        except subprocess.TimeoutExpired:
            result = {
                "status": "fail",
                "latency_ms": int((time.perf_counter() - probe_started) * 1000),
                "reachable": False,
                "definitive": False,
                "codex_version": _codex_version(env),
                "reason": "Codex CLI probe timed out",
                # Probe HOMEs carry a blanked refresh token, so the submitted
                # credential lineage cannot have been consumed or rotated.
                "auth_readback": "unchanged",
            }
            return result
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()

        ok = proc.returncode == 0 and "banana" in stdout.lower()
        parts = [p for p in [stderr, stdout] if p]
        message = "\n".join(parts).strip()
        result = {
            "status": "ok" if ok else "fail",
            "latency_ms": latency_ms,
            "reachable": True,
            "definitive": ok or _is_definitive_auth_rejection(message),
            "codex_version": _codex_version(env),
            # See above: rotation is impossible with a blanked refresh token.
            "auth_readback": "unchanged",
        }
        if not ok:
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
        sanitized = sanitized[: max_len - 3].rstrip(" ,;:.") + "..."
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


def _require_runner_auth(request: Request) -> None:
    """Fail closed: an unset RUNNER_SHARED_SECRET must reject requests, not skip auth."""
    if not RUNNER_SHARED_SECRET:
        raise HTTPException(status_code=500, detail="RUNNER_SHARED_SECRET is not configured")
    provided = request.headers.get("x-runner-auth", "")
    if not secrets.compare_digest(provided, RUNNER_SHARED_SECRET):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.post("/verify")
def verify(payload: VerifyRequest, request: Request):
    _require_runner_auth(request)

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
    _require_runner_auth(request)

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
    _require_runner_auth(request)

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
    _require_runner_auth(request)

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
    _require_runner_auth(request)

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
    _require_runner_auth(request)

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
    _require_runner_auth(request)

    try:
        return _summarize_memory(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="summary timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


# --- OpenAI-compatible prompt execution ---


#: Every field an /exec caller controls needs a ceiling, because each one is a
#: byte count this process holds in memory and then hands to a subprocess. The
#: prompt bound is generous — a megabyte is far past any real prompt — but a
#: bound that exists is the difference between a rejected request and a runner
#: OOM-killed mid-probe, taking the fleet's credential verification with it.
MAX_PROMPT_CHARS = 1_000_000
MAX_SYSTEM_PROMPT_CHARS = 100_000
MAX_MODEL_CHARS = 200
MIN_EXEC_TIMEOUT_SECONDS = 1.0
MAX_EXEC_TIMEOUT_SECONDS = 600.0


class ExecRequest(BaseModel):
    auth_json: dict = Field(..., description="auth.json payload used for Codex auth")
    prompt: str = Field(..., description="Prompt to execute", max_length=MAX_PROMPT_CHARS)
    images: list[ExecImageInput] = Field(default_factory=list, description="Optional images to attach")
    model: Optional[str] = Field(None, description="Model to execute", max_length=MAX_MODEL_CHARS)
    engine: Literal["codex", "claude"] = Field("codex", description="AI engine to use")
    max_tokens: Optional[int] = Field(None, description="Maximum tokens for response", ge=1)
    temperature: Optional[float] = Field(None, description="Sampling temperature", ge=0.0, le=2.0)
    top_p: Optional[float] = Field(None, description="Nucleus sampling threshold", ge=0.0, le=1.0)
    top_k: Optional[int] = Field(None, description="Top-k sampling", ge=1)
    stop_sequences: Optional[list[str]] = Field(
        None, description="Stop sequences", max_length=16
    )
    system: Optional[str] = Field(
        None, description="System prompt", max_length=MAX_SYSTEM_PROMPT_CHARS
    )
    timeout_seconds: Optional[float] = Field(
        None,
        description="Timeout for the exec call (seconds)",
        ge=MIN_EXEC_TIMEOUT_SECONDS,
        le=MAX_EXEC_TIMEOUT_SECONDS,
    )


def _materialize_exec_images(images: list[ExecImageInput], home_dir: str) -> list[str]:
    """Write the request's images into the isolated home, under `images.py` bounds.

    The per-image cap, the aggregate cap, the image-count cap, the decoded-size
    check performed *before* a data URL is decoded, the MIME allowlist with
    magic-byte confirmation, and the DNS-rebinding-safe download all live in
    `images.py` / `network_policy.py`. This function is the FastAPI boundary:
    it turns a policy refusal into a 400 and nothing else.
    """
    if not images:
        return []

    try:
        return materialize_images(
            [image.url for image in images],
            os.path.join(home_dir, "exec-images"),
            IMAGE_LIMITS,
        )
    except ImagePolicyError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


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
        # "--" prevents a prompt that begins with "-" from being parsed as a CLI flag.
        "--",
        prompt,
    ])
    return cmd


def _exec_prompt(payload: ExecRequest) -> dict:
    prompt = payload.prompt.strip()
    if prompt == "":
        raise HTTPException(status_code=400, detail="prompt is required")

    engine = payload.engine
    env, home_dir, _auth_path = _prepare_engine_env(payload.auth_json, engine)
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
                output_format="json",
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

        # No credential readback: exec HOMEs carry no spendable refresh
        # material, so the CLI cannot rotate the shared grant and any temp-file
        # rewrite carries no lineage worth returning.

        parsed = _parse_claude_json_result(stdout) if engine == "claude" else None

        if proc.returncode != 0:
            result["status"] = "fail"
            parts = [p for p in [stderr, stdout] if p]
            message = "\n".join(parts).strip()
            result["output"] = ""
            # `--output-format json` can still carry a usable error message.
            if parsed is not None and parsed["output"]:
                message = parsed["output"]
            result["error"] = message[:500] if message else f"{engine} exec failed"
            return result

        if engine == "claude":
            if parsed is None:
                # 0-exit but not the JSON shape we always request — see
                # _parse_claude_json_result docstring for why this must not
                # fall back to raw stdout as reply text.
                result["status"] = "fail"
                result["output"] = ""
                result["error"] = "claude exec returned an unexpected output format"
                return result
            # Claude Code CLI can report an application-level failure
            # (is_error) inside a 0-exit JSON result, distinct from a
            # nonzero process exit.
            if parsed["is_error"]:
                result["status"] = "fail"
                result["output"] = ""
                result["error"] = (parsed["output"] or "claude exec failed")[:500]
                return result
            result["status"] = "ok"
            result["output"] = parsed["output"]
            result["input_tokens"] = parsed["input_tokens"]
            result["output_tokens"] = parsed["output_tokens"]
            result["cache_creation_input_tokens"] = parsed["cache_creation_input_tokens"]
            result["cache_read_input_tokens"] = parsed["cache_read_input_tokens"]
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
    _require_runner_auth(request)

    try:
        return _exec_prompt(payload)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="exec timeout")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
