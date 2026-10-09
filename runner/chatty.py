"""Bounded, inference-only Chatty transport. Product tools execute in the API."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
from pathlib import Path
from typing import Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field, ConfigDict

PROTOCOL = 1
MAX_OUTPUT = 262144


class TurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol: Literal[1]
    auth_json: dict
    engine: Literal["codex", "claude", "grok"]
    model: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=64000)
    timeout_seconds: int = Field(default=120, ge=1, le=120)


def commands(payload, home, claude_path, grok_module):
    """No inherited CLI customizations, tools, MCP, web search or subagents."""
    if payload.engine == "codex":
        output = os.path.join(home, "answer.txt")
        return ["/usr/local/bin/codex", "exec", "--model", payload.model,
                "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
                "-c", "features.shell_tool=false", "-c", "features.unified_exec=false",
                "-c", "features.multi_agent=false", "-c", "features.apply_patch_freeform=false",
                "-c", 'web_search="disabled"', "-c", "mcp_servers={}",
                "--output-last-message", output, "--", "-"], payload.prompt.encode(), output
    if payload.engine == "claude":
        config = os.path.join(home, "mcp.json")
        Path(config).write_text('{"mcpServers":{}}', encoding="utf-8")
        return [claude_path, "--print", "--model", payload.model, "--tools", "",
                "--strict-mcp-config", "--mcp-config", config, "--setting-sources", "",
                "--no-session-persistence", "--output-format", "json",
                "--max-turns", "1"], payload.prompt.encode(), None
    cmd = grok_module.build_command(payload.prompt, home, payload.model)
    cmd.extend(["--deny", "*"])
    return cmd, None, None


def validate_response(raw):
    """Reject malformed protocol output before it reaches the coordinator."""
    try:
        result = json.loads(raw)
    except (ValueError, TypeError):
        raise HTTPException(502, "chatty_invalid_output") from None
    if not isinstance(result, dict) or result.get("kind") not in ("answer", "tool_call", "question"):
        raise HTTPException(502, "chatty_invalid_output")
    return result


async def bounded_read(stream):
    result = bytearray()
    while True:
        chunk = await stream.read(8192)
        if not chunk:
            return bytes(result)
        result.extend(chunk)
        if len(result) > MAX_OUTPUT:
            raise HTTPException(502, "chatty_output_too_large")


async def stop_process(proc):
    if proc.returncode is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        await asyncio.wait_for(proc.wait(), 2)
    except asyncio.TimeoutError:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()
    except ProcessLookupError:
        pass


def register_chatty(app, require_auth, prepare_env, claude_path, grok_module, runtime):
    # Dedicated slots keep Chatty off the synchronous verification thread pool.
    slots = asyncio.Semaphore(2)

    @app.get("/chatty/capabilities")
    async def capabilities(request: Request):
        require_auth(request)
        return {"protocol": PROTOCOL, "engines": [name for name, state in runtime.items() if state.available]}

    @app.post("/chatty/turn")
    async def turn(payload: TurnRequest, request: Request):
        require_auth(request)
        if slots.locked():
            raise HTTPException(429, "chatty_runner_busy")
        async with slots:
            env, home, _ = prepare_env(payload.auth_json, payload.engine)
            # The preparations add only engine-specific auth to os.environ.
            # Do not pass deployment secrets or unrelated provider credentials.
            allowed = {"PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"}
            allowed.update({"CODEX_HOME", "OPENAI_API_KEY"} if payload.engine == "codex" else
                           {"CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"} if payload.engine == "claude" else {"GROK_HOME"})
            env = {k: v for k, v in env.items() if k in allowed}
            proc = None
            tasks = []
            try:
                cmd, stdin, output_file = commands(payload, home, claude_path, grok_module)
                proc = await asyncio.create_subprocess_exec(*cmd, cwd=home, env=env,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, start_new_session=True)
                async def execute():
                    proc.stdin.write(stdin or b"")
                    await proc.stdin.drain()
                    proc.stdin.close()
                    stdout, _ = await asyncio.gather(bounded_read(proc.stdout), bounded_read(proc.stderr))
                    await proc.wait()
                    if proc.returncode:
                        # Native stderr can contain prompts or credential material.
                        raise HTTPException(502, "chatty_provider_failed")
                    raw = stdout.decode("utf-8", errors="replace")
                    if output_file:
                        if not Path(output_file).exists() or Path(output_file).stat().st_size > MAX_OUTPUT:
                            raise HTTPException(502, "chatty_invalid_output")
                        raw = Path(output_file).read_text(encoding="utf-8")
                    elif payload.engine == "claude":
                        parsed = json.loads(raw)
                        if parsed.get("is_error"):
                            raise HTTPException(502, "chatty_provider_failed")
                        raw = parsed.get("result", "")
                    else:
                        parsed = grok_module.parse_result(raw)
                        if not parsed or parsed.get("native_stop_reason") != "end_turn":
                            raise HTTPException(502, "chatty_provider_failed")
                        raw = parsed["output"]
                    return {"protocol": PROTOCOL, "response": validate_response(raw)}
                async def disconnected():
                    while not await request.is_disconnected():
                        await asyncio.sleep(0.2)
                    raise HTTPException(499, "chatty_cancelled")
                tasks = [asyncio.create_task(execute()), asyncio.create_task(disconnected())]
                done, _ = await asyncio.wait(tasks, timeout=payload.timeout_seconds, return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    raise HTTPException(504, "chatty_timeout")
                return await next(iter(done))
            except (ValueError, KeyError, TypeError):
                raise HTTPException(502, "chatty_invalid_output") from None
            finally:
                for task in tasks:
                    task.cancel()
                if proc:
                    await stop_process(proc)
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                shutil.rmtree(home, ignore_errors=True)
