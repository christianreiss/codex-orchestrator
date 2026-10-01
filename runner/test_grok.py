import copy
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException

import app
import grok


def auth(seconds=1800):
    return {"grok_auth": {grok.DEFAULT_SCOPE: {
        "auth_mode": "oidc", "key": "test-subscription-access", "refresh_token": "never-spend",
        "oidc_issuer": grok.ISSUER, "oidc_client_id": grok.DEFAULT_SCOPE.split("::")[1],
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(),
    }}}


def test_runner_projects_only_selected_access_credential_and_sanitizes_environment():
    payload = auth()
    payload["grok_auth"]["unmanaged"] = {"refresh_token": "other-grant"}
    original = copy.deepcopy(payload)
    with patch.dict(os.environ, {"GROK_CONFIG": '{"auth":"unmanaged"}', "GROK_AUTH": "secret",
                                 "GROK_AUTH_PROVIDER_COMMAND": "unmanaged", "XAI_API_KEY": "metered"}):
        env, home, path = grok.prepare_env(payload, tempfile.gettempdir(), 900)
    try:
        native = json.load(open(path))
        assert list(native) == [grok.DEFAULT_SCOPE]
        assert "refresh_token" not in native[grok.DEFAULT_SCOPE]
        assert os.stat(path).st_mode & 0o777 == 0o600
        assert os.path.dirname(path) == env["GROK_HOME"]
        assert not {"GROK_CONFIG", "GROK_AUTH", "GROK_AUTH_PROVIDER_COMMAND", "XAI_API_KEY"} & env.keys()
        assert payload == original
    finally:
        shutil.rmtree(home)


@pytest.mark.parametrize("seconds", [0, 299, 899])
def test_requires_execution_lifetime_without_refreshing(seconds):
    with pytest.raises(HTTPException) as error:
        grok.prepare_env(auth(seconds), tempfile.gettempdir(), 900)
    assert error.value.status_code == 409


@pytest.mark.parametrize("mode", ["api_key", "web_login"])
def test_runtime_and_legacy_modes_cannot_be_canonical_runner_auth(mode):
    payload = auth()
    payload["grok_auth"][grok.DEFAULT_SCOPE]["auth_mode"] = mode
    with pytest.raises(HTTPException):
        grok.selected_credential(payload)


def test_static_probe_never_executes_or_returns_refresh_credentials():
    response = app.httpx.Response(200, json={"userId": "u", "subscriptionTier": "premium", "secret": "hidden"})
    with patch("grok.httpx.get", return_value=response) as request, patch("grok.version", return_value="1.0.46"):
        result = grok.verify(auth(), 5)
    assert request.call_args.args[0] == grok.USER_URL
    assert request.call_args.kwargs["follow_redirects"] is False
    assert result["status"] == "ok"
    assert "updated_auth" not in result
    assert result["provider_metadata"] == {"userId": "u", "subscriptionTier": "premium"}


def test_native_usage_cache_buckets_and_stop_reason_are_not_claude_shape():
    parsed = grok.parse_result(json.dumps({"text": "answer", "stopReason": "max_tokens", "usage": {
        "input_tokens": 20, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 10,
        "output_tokens": 5, "reasoning_tokens": 3}}))
    assert parsed["input_tokens"] == 70
    assert parsed["output_tokens"] == 5
    assert parsed["finish_reason"] == "length"
    assert parsed["usage_known"] is True
    assert grok.parse_result('{"result":"Claude text"}') is None


def test_absent_or_incomplete_usage_is_unknown():
    assert grok.parse_result('{"text":"answer","stopReason":"end_turn"}')["usage_known"] is False
    parsed = grok.parse_result(json.dumps({"text": "answer", "stopReason": "cancelled",
                                          "usage_is_incomplete": True, "usage": {"input_tokens": 1,
                                          "output_tokens": 1, "cache_read_input_tokens": 0,
                                          "cache_creation_input_tokens": 0}}))
    assert parsed["usage_known"] is False
    assert parsed["finish_reason"] is None


def test_exec_uses_protected_prompt_file_and_system_override():
    seen = {}

    def run(cmd, **kwargs):
        seen.update(cmd=cmd, env=kwargs["env"])
        path = cmd[cmd.index("--prompt-file") + 1]
        assert open(path).read() == "-this is a prompt, not flags"
        assert os.stat(path).st_mode & 0o777 == 0o600
        assert "--system-prompt-override" in cmd
        return subprocess.CompletedProcess(cmd, 0, '{"text":"ok","stopReason":"end_turn"}', "")

    with patch("app.subprocess.run", side_effect=run):
        result = app._exec_prompt(app.ExecRequest(auth_json=auth(), engine="grok", model="grok-4.6",
                                  prompt="-this is a prompt, not flags", system="Only text", timeout_seconds=30))
    assert result["status"] == "ok"
    assert result["output"] == "ok"
    assert result["usage_known"] is False
    assert not os.path.exists(seen["env"]["HOME"])


def test_controls_rejected_before_launch():
    with patch("app.subprocess.run") as run, pytest.raises(HTTPException) as error:
        app._exec_prompt(app.ExecRequest(auth_json=auth(), engine="grok", prompt="hi", temperature=0))
    assert error.value.status_code == 400
    run.assert_not_called()
