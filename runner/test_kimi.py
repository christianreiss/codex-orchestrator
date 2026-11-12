import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import tomllib
from unittest.mock import patch

from fastapi import HTTPException
import httpx
import pytest

import app
import kimi


def auth(seconds=1800):
    return {"kimi_code": {"access_token": "test-access", "refresh_token": "never-spend",
                          "expires_at": time.time() + seconds, "expires_in": 1800},
            "device_id": "a" * 32, "base_url": "https://api.kimi.com/coding/v1"}


def test_access_only_projection_is_private_and_environment_is_allowlisted(tmp_path):
    original = auth()
    snapshot = copy.deepcopy(original)
    with patch.dict(os.environ, {"KIMI_MODEL_API_KEY": "metered", "KIMI_CODE_OAUTH_HOST": "unmanaged",
                                 "KIMI_CODE_HOME": "/operator", "RUNNER_SHARED_SECRET": "hidden"}):
        env, home, path = kimi.prepare_env(original, str(tmp_path), 900)
    try:
        assert json.loads(Path(path).read_text()) == {"access_token": "test-access", "refresh_token": "",
            "expires_at": 0, "expires_in": 0, "scope": "kimi-code", "token_type": "Bearer"}
        assert os.stat(path).st_mode & 0o777 == 0o600
        assert os.stat(home).st_mode & 0o777 == 0o700
        native = Path(env["KIMI_CODE_HOME"])
        assert (native / "device_id").read_text() == "a" * 32
        config = tomllib.loads((native / "config.toml").read_text())
        assert config["providers"]["managed:kimi-code"]["oauth"] == {"storage": "file", "key": "oauth/kimi-code", "oauth_host": "https://auth.kimi.com"}
        assert config["models"]["kimi-code/k3"]["model"] == "k3"
        assert config["permission"]["rules"] == [{"decision": "deny", "scope": "user", "pattern": "*"}]
        assert env["KIMI_DISABLE_TELEMETRY"] == env["KIMI_CODE_NO_AUTO_UPDATE"] == "1"
        assert not {"KIMI_MODEL_API_KEY", "KIMI_CODE_OAUTH_HOST", "RUNNER_SHARED_SECRET"} & env.keys()
        assert original == snapshot
    finally:
        shutil.rmtree(home)


@pytest.mark.parametrize("seconds", [0, 299, 899])
def test_insufficient_lifetime_requires_central_refresh(tmp_path, seconds):
    with pytest.raises(HTTPException) as exc:
        kimi.prepare_env(auth(seconds), str(tmp_path), 900)
    assert exc.value.status_code == 409
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("mutate", [lambda a: a.update(device_id="bad"),
    lambda a: a.update(base_url="https://attacker.invalid/v1"),
    lambda a: a["kimi_code"].update(access_token=""),
    lambda a: a["kimi_code"].update(expires_at=True)])
def test_invalid_canonical_credentials_fail_before_network(mutate):
    payload = auth(); mutate(payload)
    with patch("kimi.httpx.get") as get, pytest.raises(HTTPException):
        kimi.verify(payload, 5)
    get.assert_not_called()


@pytest.mark.parametrize("code,body,status,definitive", [
    (200, {"usages": {}}, "ok", True), (200, {}, "fail", False),
    (401, {}, "fail", True), (403, {}, "fail", True), (429, {}, "fail", False),
    (302, {}, "fail", False)])
def test_verify_access_only_never_refreshes_or_returns_auth(code, body, status, definitive):
    with patch("kimi.httpx.get", return_value=httpx.Response(code, json=body)) as get:
        result = kimi.verify(auth(), 5)
    assert result["status"] == status
    assert result["definitive"] is definitive
    assert result["auth_readback"] == "unchanged"
    assert "updated_auth" not in result
    assert get.call_args.args == ("https://api.kimi.com/coding/v1/usages",)
    assert get.call_args.kwargs["follow_redirects"] is False
    assert get.call_args.kwargs["headers"]["Authorization"] == "Bearer test-access"


def test_unreachable_metadata_is_not_definitive():
    with patch("kimi.httpx.get", side_effect=httpx.ConnectError("private diagnostic")):
        result = kimi.verify(auth(), 5)
    assert not result["reachable"] and not result["definitive"]
    assert "private diagnostic" not in json.dumps(result)


def test_real_253_stream_schema_has_no_usage_or_stop_reason():
    raw = '\n'.join(json.dumps(event) for event in [
        {"role": "meta", "type": "system.version", "version": "2.5.3"},
        {"role": "assistant", "content": "OK"},
        {"role": "meta", "type": "session.resume_hint", "session_id": "test", "content": "resume"}])
    assert kimi.parse_result(raw) == {"output": "OK", "usage_known": False,
                                    "finish_reason": None, "native_stop_reason": None}


@pytest.mark.parametrize("raw", ['not-json', '{}', '{"role":"meta","type":"system.version"}',
    '{"role":"assistant","content":5}', '{"type":"error","message":"bad"}',
    '{"role":"assistant","tool_calls":[{}]}', '{"role":"assistant","content":"ok"}\ntruncated'])
def test_rejects_invalid_or_tool_output(raw):
    assert kimi.parse_result(raw) is None


def test_exec_parses_output_and_always_cleans_home():
    seen = {}
    def run(cmd, **kwargs):
        seen.update(kwargs["env"])
        assert cmd[cmd.index("-p") + 1] == "-literal prompt"
        assert cmd[cmd.index("-m") + 1] == "kimi-code/k3"
        assert "--auto" not in cmd
        assert "tools: []" in Path(cmd[cmd.index("--agent-file") + 1]).read_text()
        assert Path(seen["KIMI_CODE_HOME"], "SYSTEM.md").read_text() == "Only text"
        return subprocess.CompletedProcess(cmd, 0, '{"role":"assistant","content":"OK"}', '')
    with patch("app.run_prompt_process", side_effect=run):
        result = app._exec_prompt(app.ExecRequest(engine="kimi", auth_json=auth(), prompt="-literal prompt", model="k3", system="Only text"))
    assert result["status"] == "ok" and result["output"] == "OK"
    assert result["usage_known"] is False and result["finish_reason"] is None
    assert not Path(seen["HOME"]).exists()


@pytest.mark.parametrize("control", [{"temperature": 0}, {"max_tokens": 1}, {"top_p": .5},
    {"top_k": 1}, {"stop_sequences": []}, {"images": [{"url": "https://example.com/x.png"}]}])
def test_unsupported_controls_rejected_before_launch(control):
    with patch("app.run_prompt_process") as run, pytest.raises(HTTPException) as exc:
        app._exec_prompt(app.ExecRequest(engine="kimi", auth_json=auth(), prompt="hi", **control))
    assert exc.value.status_code == 400
    run.assert_not_called()


def test_global_environment_uses_native_scoped_access_only_alias(tmp_path):
    payload = auth()
    payload.update(base_url="https://api.kimi.ai/coding/v1", oauth_host="https://auth.kimi.ai")
    env, home, path = kimi.prepare_env(payload, str(tmp_path), 900)
    try:
        native = Path(env["KIMI_CODE_HOME"])
        config = tomllib.loads((native / "config.toml").read_text())
        ref = config["providers"]["managed:kimi-code"]["oauth"]
        assert ref["key"].startswith("oauth/kimi-code-env-")
        scoped = native / "credentials" / (ref["key"].removeprefix("oauth/") + ".json")
        assert scoped.read_bytes() == Path(path).read_bytes()
        assert json.loads(scoped.read_text())["refresh_token"] == ""
        assert scoped.stat().st_mode & 0o777 == 0o600
    finally:
        shutil.rmtree(home)
