import ast
import asyncio
import base64
import inspect
import os
import json
import re
import shutil
import socket
import stat
import subprocess
import tempfile
import typing
import unittest
from email.message import Message

from fastapi import HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import BaseModel

import app as runner_app

# These tests are synchronous, but pytest plugins that happen to be installed in
# the ambient environment run autouse fixtures around every test and some of
# them call asyncio.get_event_loop(). On Python 3.12+ that no longer creates a
# loop implicitly, so every test errors out during setup with "There is no
# current event loop in thread 'MainThread'". Give the main thread a loop.
asyncio.set_event_loop(asyncio.new_event_loop())


class RunnerAppTest(unittest.TestCase):
    def test_codex_version_probe_is_bounded(self):
        captured = {}

        def timeout_version(cmd, env, capture_output, text, timeout):
            captured["timeout"] = timeout
            raise subprocess.TimeoutExpired(cmd, timeout)

        original_run = runner_app.subprocess.run
        runner_app.subprocess.run = timeout_version
        try:
            version = runner_app._codex_version({"HOME": "/tmp/runner-version-test"})
        finally:
            runner_app.subprocess.run = original_run

        self.assertEqual("unavailable", version)
        self.assertEqual(5, captured["timeout"])

    def test_build_codex_exec_cmd_places_options_before_prompt(self):
        cmd = runner_app._build_codex_exec_cmd(
            "Describe the image.",
            "gpt-5.4",
            ["/tmp/image-1.png"],
        )

        self.assertEqual(
            [
                "/usr/local/bin/codex",
                "exec",
                "--model",
                "gpt-5.4",
                "--image",
                "/tmp/image-1.png",
                "-s",
                "read-only",
                "--skip-git-repo-check",
                "--",
                "Describe the image.",
            ],
            cmd,
        )

    def test_run_codex_exec_uses_probe_model(self):
        captured = {}

        def fake_run(cmd, env, capture_output, text, timeout):
            captured["cmd"] = cmd
            captured["env"] = env
            captured["capture_output"] = capture_output
            captured["text"] = text
            captured["timeout"] = timeout

            class Result:
                stdout = "Banana"
                stderr = ""
                returncode = 0

            return Result()

        original_run = runner_app.subprocess.run
        runner_app.subprocess.run = fake_run
        try:
            runner_app._run_codex_exec("Reply Banana if this works.", {"HOME": "/tmp/home"}, 2.0, "gpt-5.4")
        finally:
            runner_app.subprocess.run = original_run

        self.assertEqual(
            [
                "/usr/local/bin/codex",
                "exec",
                "--model",
                "gpt-5.4",
                "-s",
                "read-only",
                "--skip-git-repo-check",
                "--",
                "Reply Banana if this works.",
            ],
            captured["cmd"],
        )

    def test_build_claude_exec_cmd_uses_supported_print_flag(self):
        cmd = runner_app._build_claude_exec_cmd("Reply Banana.")

        self.assertEqual([runner_app.CLAUDE_CLI_PATH, "--print", "--", "Reply Banana."], cmd)
        self.assertNotIn("--no-input", cmd)

    def test_build_claude_exec_cmd_drops_unsupported_max_tokens_flag(self):
        # Claude Code CLI has no --max-tokens flag; passing it makes the
        # subprocess exit non-zero on every request that sets max_tokens
        # (i.e. virtually every real Anthropic client request) — confirmed
        # live via "error: unknown option '--max-tokens'".
        cmd = runner_app._build_claude_exec_cmd("Reply Banana.", max_tokens=512)

        self.assertNotIn("--max-tokens", cmd)
        self.assertEqual([runner_app.CLAUDE_CLI_PATH, "--print", "--", "Reply Banana."], cmd)

    def test_build_claude_exec_cmd_appends_output_format_flag(self):
        cmd = runner_app._build_claude_exec_cmd("hi", output_format="json")

        self.assertEqual(
            [runner_app.CLAUDE_CLI_PATH, "--print", "--output-format", "json", "--", "hi"],
            cmd,
        )

    def test_prepare_codex_env_uses_non_tmp_home_and_sets_tmpdir(self):
        env, home_dir, auth_path = runner_app._prepare_codex_env(
            {"tokens": {"access_token": "tok_test_12345678901234567890"}}
        )

        try:
            self.assertTrue(os.path.isdir(home_dir))
            self.assertFalse(home_dir.startswith("/tmp/"))
            self.assertEqual(home_dir, env["HOME"])
            self.assertTrue(os.path.isfile(auth_path))
            self.assertEqual(os.path.join(home_dir, "tmp"), env["TMPDIR"])
            self.assertEqual(env["TMPDIR"], env["TMP"])
            self.assertEqual(env["TMPDIR"], env["TEMP"])
        finally:
            shutil.rmtree(home_dir, ignore_errors=True)

    def test_extract_anthropic_token_accepts_claude_oauth_credentials(self):
        token = runner_app._extract_anthropic_token(
            {"claudeAiOauth": {"accessToken": "sk-ant-oat01-test-token"}}
        )

        self.assertEqual("sk-ant-oat01-test-token", token)

    def test_extract_openai_token_matches_native_codex_auth_mode_selection(self):
        oauth = "ey-native-chatgpt-access-token"
        api_key = "sk-native-openai-api-key"

        self.assertEqual(
            api_key,
            runner_app._extract_openai_token(
                {
                    "OPENAI_API_KEY": api_key,
                    "tokens": {"access_token": oauth},
                    "auths": {"api.openai.com": {"token": oauth}},
                }
            ),
        )
        self.assertEqual(
            oauth,
            runner_app._extract_openai_token(
                {
                    "auth_mode": "chatgpt",
                    "OPENAI_API_KEY": api_key,
                    "tokens": {"access_token": oauth},
                }
            ),
        )
        self.assertEqual(
            api_key,
            runner_app._extract_openai_token(
                {
                    "auth_mode": "apikey",
                    "OPENAI_API_KEY": api_key,
                    "tokens": {"access_token": oauth},
                }
            ),
        )

    def test_extract_openai_token_rejects_non_native_and_unsupported_fallbacks(self):
        self.assertIsNone(
            runner_app._extract_openai_token(
                {"auths": {"api.openai.com": {"token": "legacy-auths-only"}}}
            )
        )
        self.assertIsNone(
            runner_app._extract_openai_token(
                {"tokens": {"openai_api_key": "legacy-nested-only"}}
            )
        )
        self.assertIsNone(
            runner_app._extract_openai_token(
                {
                    "auth_mode": "headers",
                    "OPENAI_API_KEY": "sk-shadow-key",
                    "tokens": {"access_token": "shadow-oauth"},
                }
            )
        )
        self.assertIsNone(
            runner_app._extract_openai_token(
                {
                    "personal_access_token": "pat-selects-unsupported-mode",
                    "OPENAI_API_KEY": "sk-shadow-key",
                }
            )
        )

    def test_extract_anthropic_token_uses_runtime_credential_precedence(self):
        oauth = runner_app._extract_anthropic_token(
            {
                "claudeAiOauth": {"accessToken": "sk-ant-oat01-oauth-winner"},
                "api_key": "sk-ant-api03-api-key-loser",
                "auths": {
                    "api.anthropic.com": {"token": "sk-ant-api03-auths-loser"}
                },
            }
        )
        api_key = runner_app._extract_anthropic_token(
            {
                "api_key": "sk-ant-api03-api-key-winner",
                "anthropic_api_key": "sk-ant-api03-secondary-loser",
                "auths": {
                    "api.anthropic.com": {"token": "sk-ant-api03-auths-loser"}
                },
            }
        )

        self.assertEqual("sk-ant-oat01-oauth-winner", oauth)
        self.assertEqual("sk-ant-api03-api-key-winner", api_key)

    def test_extract_anthropic_token_rejects_auths_only_oauth_projection(self):
        token = runner_app._extract_anthropic_token(
            {
                "auths": {
                    "api.anthropic.com": {
                        "token": "sk-ant-oat01-derived-without-native-oauth"
                    }
                }
            }
        )

        self.assertIsNone(token)

    def test_extract_anthropic_token_rejects_oauth_projection_in_api_key_fields(self):
        credentials = (
            {"api_key": "sk-ant-oat01-top-level-projection"},
            {"anthropic_api_key": "sk-ant-oat01-top-level-projection"},
            {"ANTHROPIC_API_KEY": "sk-ant-oat01-top-level-projection"},
            {"tokens": {"anthropic_api_key": "sk-ant-oat01-nested-projection"}},
            {"tokens": {"ANTHROPIC_API_KEY": "sk-ant-oat01-nested-projection"}},
        )

        for credential in credentials:
            with self.subTest(credential=credential):
                self.assertIsNone(runner_app._extract_anthropic_token(credential))

    def test_anthropic_api_keys_use_x_api_key_header(self):
        self.assertEqual(
            {"x-api-key": "sk-ant-api03-test-token"},
            runner_app._anthropic_auth_headers("sk-ant-api03-test-token"),
        )

    def test_cli_auth_rejection_classifier_is_narrow(self):
        self.assertTrue(
            runner_app._is_definitive_auth_rejection(
                "refresh token has already been used; run codex login"
            )
        )
        self.assertTrue(
            runner_app._is_definitive_auth_rejection(
                "OAuth token has expired. Please run /login"
            )
        )
        self.assertTrue(
            runner_app._is_definitive_auth_rejection(
                "Failed to authenticate: OAuth session expired and could not be refreshed"
            )
        )
        self.assertFalse(
            runner_app._is_definitive_auth_rejection(
                "service unavailable while contacting provider"
            )
        )
        self.assertFalse(
            runner_app._is_definitive_auth_rejection(
                "model is overloaded; retry later"
            )
        )

    def test_prepare_claude_env_writes_oauth_credentials_without_api_key_env(self):
        old_key = os.environ.get("ANTHROPIC_API_KEY")
        os.environ["ANTHROPIC_API_KEY"] = "ambient-key"
        oauth = {
            "accessToken": "sk-ant-oat01-test-token",
            "refreshToken": "test-refresh-token",
            "expiresAt": 123456789,
            "scopes": ["user:inference"],
        }
        try:
            env, home_dir, auth_path = runner_app._prepare_claude_env(
                {
                    "claudeAiOauth": oauth,
                    "last_refresh": "2026-06-05T00:00:00Z",
                    "auths": {
                        "api.anthropic.com": {
                            "token": "sk-ant-oat01-test-token",
                            "token_type": "bearer",
                        }
                    },
                }
            )
        finally:
            if old_key is None:
                os.environ.pop("ANTHROPIC_API_KEY", None)
            else:
                os.environ["ANTHROPIC_API_KEY"] = old_key

        try:
            self.assertNotIn("ANTHROPIC_API_KEY", env)
            self.assertTrue(auth_path.endswith(os.path.join(".claude", ".credentials.json")))
            self.assertTrue(os.path.isfile(auth_path))
            with open(auth_path, "r", encoding="utf-8") as fh:
                written = json.load(fh)
            self.assertEqual({"claudeAiOauth": oauth}, written)
        finally:
            shutil.rmtree(home_dir, ignore_errors=True)

    def test_codex_probe_readback_stays_unchanged_when_cli_removes_probe_file(self):
        # Probe HOMEs carry a blanked refresh token, so the CLI cannot rotate
        # the shared grant; a deleted temp file therefore carries no lineage
        # and must never surface as a readback error.
        class Payload:
            auth_json = {
                "tokens": {"access_token": "sk-openai-valid-test-token"},
                "last_refresh": "2026-06-05T00:00:00Z",
            }
            timeout_seconds = 2.0

        class Result:
            stdout = "Banana"
            stderr = ""
            returncode = 0

        original_exec = runner_app._run_codex_exec
        original_version = runner_app._codex_version

        def fake_exec(prompt, env, timeout, model):
            os.unlink(os.path.join(env["HOME"], ".codex", "auth.json"))
            return Result(), 12

        runner_app._run_codex_exec = fake_exec
        runner_app._codex_version = lambda env: "1.0.0"
        try:
            result = runner_app._run_probe(Payload())
        finally:
            runner_app._run_codex_exec = original_exec
            runner_app._codex_version = original_version

        self.assertEqual("ok", result["status"])
        self.assertEqual("unchanged", result["auth_readback"])
        self.assertNotIn("updated_auth", result)
        self.assertNotIn("auth_readback_error", result)

    def test_claude_probe_readback_stays_unchanged_when_cli_mangles_probe_file(self):
        # Probe HOMEs carry no refresh material, so the CLI cannot rotate the
        # shared grant; a mangled temp file therefore carries no lineage and
        # must never surface as a readback error or replacement credentials.
        class Payload:
            auth_json = {
                "claudeAiOauth": {"accessToken": "sk-ant-oat01-valid-test-token"},
                "last_refresh": "2026-06-05T00:00:00Z",
            }
            timeout_seconds = 2.0

        class Result:
            stdout = "Banana"
            stderr = ""
            returncode = 0

        original_exec = runner_app._run_claude_exec
        original_version = runner_app._claude_version

        def fake_exec(prompt, env, timeout):
            path = os.path.join(env["HOME"], ".claude", ".credentials.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("[]")
            return Result(), 12

        runner_app._run_claude_exec = fake_exec
        runner_app._claude_version = lambda env=None: "1.0.0"
        try:
            result = runner_app._run_claude_probe(Payload())
        finally:
            runner_app._run_claude_exec = original_exec
            runner_app._claude_version = original_version

        self.assertEqual("ok", result["status"])
        self.assertEqual("unchanged", result["auth_readback"])
        self.assertNotIn("updated_auth", result)
        self.assertNotIn("auth_readback_error", result)

    def test_native_probe_timeouts_report_readback_per_engine(self):
        codex_payload = type(
            "CodexPayload",
            (),
            {
                "auth_json": {
                    "tokens": {"access_token": "sk-openai-old-valid-token"},
                    "last_refresh": "2026-06-05T00:00:00Z",
                },
                "timeout_seconds": 0.01,
            },
        )()
        claude_payload = type(
            "ClaudePayload",
            (),
            {
                "auth_json": {
                    "claudeAiOauth": {"accessToken": "sk-ant-oat01-old-valid-token"},
                    "last_refresh": "2026-06-05T00:00:00Z",
                },
                "timeout_seconds": 0.01,
            },
        )()
        original_codex_exec = runner_app._run_codex_exec
        original_claude_exec = runner_app._run_claude_exec
        original_codex_version = runner_app._codex_version
        original_claude_version = runner_app._claude_version

        def timeout_codex(prompt, env, timeout, model):
            path = os.path.join(env["HOME"], ".codex", "auth.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"tokens": {"access_token": "sk-openai-new-valid-token"}}, fh)
            raise subprocess.TimeoutExpired("codex", timeout)

        def timeout_claude(prompt, env, timeout):
            path = os.path.join(env["HOME"], ".claude", ".credentials.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"claudeAiOauth": {"accessToken": "sk-ant-oat01-new-valid-token"}}, fh)
            raise subprocess.TimeoutExpired("claude", timeout)

        runner_app._run_codex_exec = timeout_codex
        runner_app._run_claude_exec = timeout_claude
        runner_app._codex_version = lambda env: "1.0.0"
        runner_app._claude_version = lambda env=None: "1.0.0"
        try:
            codex_result = runner_app._run_probe(codex_payload)
            claude_result = runner_app._run_claude_probe(claude_payload)
        finally:
            runner_app._run_codex_exec = original_codex_exec
            runner_app._run_claude_exec = original_claude_exec
            runner_app._codex_version = original_codex_version
            runner_app._claude_version = original_claude_version

        # Probes for both engines run without spendable refresh material and
        # therefore never report a rotated lineage, even on timeout.
        for result in (codex_result, claude_result):
            self.assertEqual("fail", result["status"])
            self.assertFalse(result["definitive"])
            self.assertEqual("unchanged", result["auth_readback"])
            self.assertNotIn("updated_auth", result)

    def test_claude_probe_treats_rate_limit_as_valid_auth(self):
        class Payload:
            auth_json = {"api_key": "sk-ant-api03-test-token"}
            timeout_seconds = 2.0

        class Response:
            status_code = 429
            text = '{"error":{"type":"rate_limit_error","message":"Error"}}'

            def json(self):
                return {"error": {"type": "rate_limit_error", "message": "Error"}}

        original_post = runner_app.httpx.post
        original_version = runner_app._claude_version
        captured = {}

        def fake_post(url, headers, json, timeout):
            captured["headers"] = headers
            return Response()

        runner_app.httpx.post = fake_post
        runner_app._claude_version = lambda: "1.0.0"
        try:
            result = runner_app._run_claude_probe(Payload())
        finally:
            runner_app.httpx.post = original_post
            runner_app._claude_version = original_version

        self.assertEqual("ok", result["status"])
        self.assertTrue(result["definitive"])
        self.assertTrue(result["auth_limited"])
        self.assertEqual("sk-ant-api03-test-token", captured["headers"]["x-api-key"])
        self.assertNotIn("Authorization", captured["headers"])

    def test_claude_api_probe_only_marks_auth_rejections_definitive(self):
        class Payload:
            auth_json = {"api_key": "sk-ant-api03-test-token"}
            timeout_seconds = 2.0

        class Response:
            def __init__(self, status_code, error_type):
                self.status_code = status_code
                self.error_type = error_type
                self.text = '{"error":{"type":"%s","message":"Error"}}' % error_type

            def json(self):
                return {"error": {"type": self.error_type, "message": "Error"}}

        original_post = runner_app.httpx.post
        original_version = runner_app._claude_version
        runner_app._claude_version = lambda: "1.0.0"
        try:
            for status_code, error_type, expected in (
                (401, "authentication_error", True),
                (403, "permission_error", False),
                (500, "api_error", False),
                (529, "overloaded_error", False),
                (400, "invalid_request_error", False),
            ):
                with self.subTest(status_code=status_code, error_type=error_type):
                    runner_app.httpx.post = (
                        lambda *args, _status=status_code, _type=error_type, **kwargs:
                        Response(_status, _type)
                    )
                    result = runner_app._run_claude_probe(Payload())
                    self.assertEqual("fail", result["status"])
                    self.assertEqual(expected, result["definitive"])
        finally:
            runner_app.httpx.post = original_post
            runner_app._claude_version = original_version

    def test_claude_oauth_probe_uses_native_cli(self):
        class Payload:
            auth_json = {
                "claudeAiOauth": {
                    "accessToken": "sk-ant-oat01-test-token",
                    "refreshToken": "test-refresh-token",
                },
                "last_refresh": "2026-06-05T00:00:00Z",
                "auths": {
                    "api.anthropic.com": {
                        "token": "sk-ant-oat01-test-token",
                        "token_type": "bearer",
                    }
                },
            }
            timeout_seconds = 2.0

        class Result:
            stdout = "Banana"
            stderr = ""
            returncode = 0

        original_exec = runner_app._run_claude_exec
        original_version = runner_app._claude_version
        captured = {}

        def fake_exec(prompt, env, timeout):
            captured["prompt"] = prompt
            captured["env"] = env
            captured["timeout"] = timeout
            with open(
                os.path.join(env["HOME"], ".claude", ".credentials.json"),
                "r",
                encoding="utf-8",
            ) as fh:
                captured["credentials"] = json.load(fh)
            return Result(), 123

        runner_app._run_claude_exec = fake_exec
        version_calls = []
        runner_app._claude_version = lambda env=None: version_calls.append(env) or "1.0.0"
        try:
            result = runner_app._run_claude_probe(Payload())
        finally:
            runner_app._run_claude_exec = original_exec
            runner_app._claude_version = original_version

        self.assertEqual("ok", result["status"])
        self.assertTrue(result["definitive"])
        self.assertTrue(result["native_oauth"])
        self.assertEqual(1, len(version_calls))
        self.assertIsNotNone(version_calls[0])
        self.assertNotIn("ANTHROPIC_API_KEY", captured["env"])
        self.assertEqual("Reply Banana if this works.", captured["prompt"])
        # The probe HOME must carry no refresh material: a verification probe
        # that could refresh would race host-side native refreshes of the same
        # rotating grant and get the whole token family revoked.
        self.assertEqual(
            {"claudeAiOauth": {"accessToken": "sk-ant-oat01-test-token"}},
            captured["credentials"],
        )
        self.assertEqual("unchanged", result["auth_readback"])
        self.assertNotIn("updated_auth", result)

    def test_codex_probe_auth_blanks_refresh_token_only(self):
        source = {
            "last_refresh": "2026-06-05T00:00:00Z",
            "auth_mode": "chatgpt",
            "tokens": {
                "id_token": "id-jwt",
                "access_token": "access-jwt",
                "refresh_token": "refresh-secret",
                "account_id": "acct-1",
            },
        }
        projected = runner_app._codex_probe_auth(source)
        # The key must stay present (codex's TokenData refuses to parse a
        # ChatGPT token block without it) but hold nothing spendable.
        self.assertEqual("", projected["tokens"]["refresh_token"])
        self.assertEqual("id-jwt", projected["tokens"]["id_token"])
        self.assertEqual("access-jwt", projected["tokens"]["access_token"])
        self.assertEqual("acct-1", projected["tokens"]["account_id"])
        # The input payload is never mutated.
        self.assertEqual("refresh-secret", source["tokens"]["refresh_token"])
        # API-key payloads (no tokens block) pass through unmodified.
        api_key = {"OPENAI_API_KEY": "sk-openai-x"}
        self.assertIs(api_key, runner_app._codex_probe_auth(api_key))

    def test_prepare_codex_env_probe_only_writes_blanked_refresh_token(self):
        env, home_dir, auth_path = runner_app._prepare_codex_env(
            {
                "last_refresh": "2026-06-05T00:00:00Z",
                "tokens": {
                    "access_token": "sk-openai-test-access",
                    "refresh_token": "sk-openai-test-refresh",
                },
            },
            probe_only=True,
        )
        try:
            with open(auth_path, "r", encoding="utf-8") as fh:
                written = json.load(fh)
            self.assertEqual("", written["tokens"]["refresh_token"])
            self.assertEqual("sk-openai-test-access", written["tokens"]["access_token"])
        finally:
            shutil.rmtree(home_dir, ignore_errors=True)

    def test_claude_probe_credentials_strips_only_refresh_material(self):
        projected = runner_app._claude_probe_credentials(
            {
                "claudeAiOauth": {
                    "accessToken": "sk-ant-oat01-test-token",
                    "refreshToken": "test-refresh-token",
                    "refreshTokenExpiresAt": 123,
                    "expiresAt": 456,
                    "scopes": ["user:inference"],
                    "subscriptionType": "max",
                },
                "last_refresh": "2026-06-05T00:00:00Z",
            }
        )
        self.assertEqual(
            {
                "claudeAiOauth": {
                    "accessToken": "sk-ant-oat01-test-token",
                    "expiresAt": 456,
                    "scopes": ["user:inference"],
                    "subscriptionType": "max",
                }
            },
            projected,
        )
        # Exec environments keep the full native credential untouched.
        full = runner_app._claude_native_credentials(
            {"claudeAiOauth": {"accessToken": "a", "refreshToken": "r"}}
        )
        self.assertEqual({"claudeAiOauth": {"accessToken": "a", "refreshToken": "r"}}, full)
        # Non-OAuth envelopes (genuine API keys) pass through unmodified.
        self.assertEqual(
            {"api_key": "sk-ant-api03-x"},
            runner_app._claude_probe_credentials({"api_key": "sk-ant-api03-x"}),
        )

    def test_claude_oauth_transient_cli_failure_is_not_definitive(self):
        class Payload:
            auth_json = {
                "claudeAiOauth": {"accessToken": "sk-ant-oat01-test-token"},
                "last_refresh": "2026-06-05T00:00:00Z",
            }
            timeout_seconds = 2.0

        class Result:
            stdout = ""
            stderr = "provider overloaded; retry later"
            returncode = 1

        original_exec = runner_app._run_claude_exec
        original_version = runner_app._claude_version
        runner_app._run_claude_exec = lambda prompt, env, timeout: (Result(), 123)
        runner_app._claude_version = lambda env=None: "1.0.0"
        try:
            result = runner_app._run_claude_probe(Payload())
        finally:
            runner_app._run_claude_exec = original_exec
            runner_app._claude_version = original_version

        self.assertEqual("fail", result["status"])
        self.assertFalse(result["definitive"])


def _request_body_model(endpoint):
    """Return the Pydantic body model a handler declares, or None."""
    for parameter in inspect.signature(endpoint).parameters.values():
        annotation = parameter.annotation
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            return annotation
    return None


def _minimal_field_value(annotation):
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return _minimal_request_body(annotation)
    origin = typing.get_origin(annotation) or annotation
    if origin is list:
        return []
    if origin is dict:
        return {}
    if origin is str:
        return "auth-guard-probe"
    raise AssertionError(f"no minimal request value known for body field type {annotation!r}")


def _minimal_request_body(model):
    """Build the smallest body that passes validation for `model`.

    FastAPI validates the body before the handler runs, so probing a route with
    an empty body would answer 422 without ever reaching the guard.
    """
    if model is None:
        return {}
    return {
        name: _minimal_field_value(field.annotation)
        for name, field in model.model_fields.items()
        if field.is_required()
    }


class RunnerRouteAuthTest(unittest.TestCase):
    """X-Runner-Auth is the runner's only access control on the compose network."""

    VERIFY_BODY = {"auth_json": {"tokens": {"access_token": "sk-openai-test-token"}}}

    # Routes that answer without the shared secret by design: the container
    # healthcheck and the GET readiness hints, none of which touch credentials.
    # Every other route the app declares must enforce the guard, so a new
    # unauthenticated route has to be added here deliberately.
    UNAUTHENTICATED_ROUTES = frozenset(
        {
            ("GET", "/health"),
            ("GET", "/skills/summarize"),
            ("GET", "/skills/generate"),
            ("GET", "/skills/assist"),
            ("GET", "/projects/assist"),
            ("GET", "/memories/summarize"),
            ("GET", "/exec"),
        }
    )

    def setUp(self):
        self.client = TestClient(runner_app.app)
        self.probe_payloads = []
        self._original_secret = runner_app.RUNNER_SHARED_SECRET
        self._original_probe = runner_app._run_probe
        runner_app._run_probe = lambda payload: (
            self.probe_payloads.append(payload) or {"status": "ok", "reachable": True}
        )

    def tearDown(self):
        runner_app.RUNNER_SHARED_SECRET = self._original_secret
        runner_app._run_probe = self._original_probe

    def test_health_needs_no_secret(self):
        runner_app.RUNNER_SHARED_SECRET = ""

        response = self.client.get("/health")

        self.assertEqual(200, response.status_code)
        self.assertEqual("ok", response.json()["status"])

    def test_verify_fails_closed_when_secret_is_unset(self):
        runner_app.RUNNER_SHARED_SECRET = ""

        for headers in ({}, {"x-runner-auth": ""}, {"x-runner-auth": "any-guess"}):
            with self.subTest(headers=headers):
                response = self.client.post("/verify", json=self.VERIFY_BODY, headers=headers)

                self.assertEqual(500, response.status_code)
                self.assertEqual(
                    "RUNNER_SHARED_SECRET is not configured", response.json()["detail"]
                )

        self.assertEqual([], self.probe_payloads)

    def test_verify_rejects_missing_or_wrong_secret(self):
        runner_app.RUNNER_SHARED_SECRET = "runner-secret"

        for headers in (
            {},
            {"x-runner-auth": ""},
            {"x-runner-auth": "runner-secre"},
            {"x-runner-auth": "runner-secret-extra"},
            {"x-runner-auth": "RUNNER-SECRET"},
        ):
            with self.subTest(headers=headers):
                response = self.client.post("/verify", json=self.VERIFY_BODY, headers=headers)

                self.assertEqual(401, response.status_code)
                self.assertEqual("unauthorized", response.json()["detail"])

        self.assertEqual([], self.probe_payloads)

    def test_verify_with_correct_secret_reaches_the_handler(self):
        runner_app.RUNNER_SHARED_SECRET = "runner-secret"

        response = self.client.post(
            "/verify",
            json=self.VERIFY_BODY,
            headers={"x-runner-auth": "runner-secret"},
        )

        self.assertEqual(200, response.status_code)
        self.assertEqual({"status": "ok", "reachable": True}, response.json())
        self.assertEqual(1, len(self.probe_payloads))
        self.assertEqual(self.VERIFY_BODY["auth_json"], self.probe_payloads[0].auth_json)

    def guarded_routes(self):
        """Enumerate the app's own routes, minus the allowlist, with a valid body.

        Reading the router instead of a hand-written path list is the point: a
        handler added without _require_runner_auth, or one whose guard line is
        deleted, has to show up here.
        """
        routes = []
        for route in runner_app.app.routes:
            # Skip FastAPI's own /docs and /openapi.json plumbing.
            if not isinstance(route, APIRoute):
                continue
            for method in sorted(route.methods):
                if (method, route.path) in self.UNAUTHENTICATED_ROUTES:
                    continue
                self.assertEqual(
                    "POST",
                    method,
                    f"{method} {route.path} is neither guarded nor allowlisted",
                )
                routes.append(
                    (method, route.path, _minimal_request_body(_request_body_model(route.endpoint)))
                )

        self.assertNotEqual([], routes)
        return routes

    def test_every_mutating_route_rejects_missing_or_wrong_secret(self):
        runner_app.RUNNER_SHARED_SECRET = "runner-secret"

        for method, path, body in self.guarded_routes():
            for headers in (
                {},
                {"x-runner-auth": ""},
                {"x-runner-auth": "runner-secre"},
                {"x-runner-auth": "runner-secret-extra"},
                {"x-runner-auth": "RUNNER-SECRET"},
            ):
                with self.subTest(path=path, headers=headers):
                    response = self.client.request(method, path, json=body, headers=headers)

                    self.assertEqual(401, response.status_code)
                    self.assertEqual("unauthorized", response.json()["detail"])

        self.assertEqual([], self.probe_payloads)

    def test_every_mutating_route_fails_closed_when_secret_is_unset(self):
        runner_app.RUNNER_SHARED_SECRET = ""

        for method, path, body in self.guarded_routes():
            for headers in ({}, {"x-runner-auth": ""}, {"x-runner-auth": "any-guess"}):
                with self.subTest(path=path, headers=headers):
                    response = self.client.request(method, path, json=body, headers=headers)

                    self.assertEqual(500, response.status_code)
                    self.assertEqual(
                        "RUNNER_SHARED_SECRET is not configured", response.json()["detail"]
                    )

        self.assertEqual([], self.probe_payloads)

    def test_get_on_post_only_routes_returns_readiness_hint(self):
        runner_app.RUNNER_SHARED_SECRET = "runner-secret"

        for path in ("/skills/summarize", "/exec"):
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual(200, response.status_code)
                self.assertEqual({"status": "ok"}, response.json())


DOC_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "docs", "auth-runner.md"
)

# Matches a documented route written as a single backticked `METHOD /path`.
# Matching the pair, not the bare path, keeps `POST /verify` from vouching for
# `/verify-claude` (or any other route it happens to be a prefix of).
DOCUMENTED_ROUTE_RE = re.compile(r"`(GET|POST|PUT|PATCH|DELETE) (/[^`\s]*)`")


class RunnerDocSurfaceTest(unittest.TestCase):
    """docs/auth-runner.md is the API-side description of this HTTP surface.

    API and wrapper authors read the doc, not the router, so a route that
    exists here and nowhere in the doc is a route nobody knows to call — or,
    worse, one nobody knows to guard with the shared secret.
    """

    def test_every_registered_route_is_documented(self):
        with open(DOC_PATH, encoding="utf-8") as fh:
            documented = set(DOCUMENTED_ROUTE_RE.findall(fh.read()))

        undocumented = []
        registered = 0
        for route in runner_app.app.routes:
            # Skip FastAPI's own /docs and /openapi.json plumbing.
            if not isinstance(route, APIRoute):
                continue
            for method in sorted(route.methods):
                registered += 1
                if (method, route.path) not in documented:
                    undocumented.append(f"{method} {route.path}")

        self.assertNotEqual(0, registered)
        self.assertEqual(
            [],
            undocumented,
            f"missing from docs/auth-runner.md: {', '.join(undocumented)}",
        )


README_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "README.md")


class RunnerReadmeSurfaceTest(unittest.TestCase):
    """runner/README.md is the operator-facing description of the same surface.

    It drifted from the router once already — five registered routes went
    unmentioned and the shared-secret list left out /exec — so this checks both
    directions: the README has to name every registered route, and every
    `METHOD /path` it names has to be a route the runner actually serves.
    """

    def readme_routes(self):
        with open(README_PATH, encoding="utf-8") as fh:
            return set(DOCUMENTED_ROUTE_RE.findall(fh.read()))

    def registered_routes(self):
        return {
            (method, route.path)
            for route in runner_app.app.routes
            # Skip FastAPI's own /docs and /openapi.json plumbing.
            if isinstance(route, APIRoute)
            for method in route.methods
        }

    def test_every_registered_route_is_in_the_readme(self):
        registered = self.registered_routes()
        self.assertNotEqual(set(), registered)

        undocumented = sorted(
            f"{method} {path}" for method, path in registered - self.readme_routes()
        )

        self.assertEqual(
            [],
            undocumented,
            f"missing from runner/README.md: {', '.join(undocumented)}",
        )

    def test_every_readme_route_is_registered(self):
        # A backticked `METHOD /path` in the README claims a route on this
        # runner; endpoints owned by Anthropic or the API service are written
        # without a method so they cannot be mistaken for one.
        unregistered = sorted(
            f"{method} {path}"
            for method, path in self.readme_routes() - self.registered_routes()
        )

        self.assertEqual(
            [],
            unregistered,
            f"documented in runner/README.md but not registered: {', '.join(unregistered)}",
        )


class _FakeCompletedProcess:
    """Stand-in for subprocess.CompletedProcess; the runner reads only these."""

    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _codex_auth_path(env):
    return os.path.join(env["HOME"], ".codex", "auth.json")


def _claude_auth_path(env):
    return os.path.join(env["HOME"], ".claude", ".credentials.json")


def _write_credentials(path, credentials):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(credentials, fh)


class RunnerResponseContractTest(unittest.TestCase):
    """Response bodies must keep every key the API reads off them.

    api/src/services/runner-client.ts is the consumer: its send() spreads the
    whole runner body into RunnerVerifyResult and reads `status`, `reachable`,
    `definitive`, `reason` and `latency_ms` by name; canonical-auth-store.ts then
    reads `auth_readback`, `auth_readback_error` and `updated_auth` off that
    result, and the /exec adapters beside it (adapters/runner-openai.ts,
    adapters/runner-claude.ts) read `output` plus the token counts. The API suite
    mocks the runner, so renaming one of these keys in runner/app.py leaves both
    suites green while the API silently loses rotated credential bytes or token
    accounting. These tests drive the real handlers and require each body to stay
    a superset of the key sets below.

    The LLM-draft endpoints are read the same way by api/src/services/
    skill-drafts.ts and project-drafts.ts, and every one of their bodies carries
    the engine-dependent version key from _engine_version_key(), so each draft
    contract below is asserted for engine=codex and engine=claude.
    """

    # Verdict fields every /verify and /verify-claude body carries.
    VERDICT_KEYS = frozenset({"status", "reachable", "definitive", "latency_ms", "auth_readback"})

    # Codex CLI probes run with a blanked refresh token and can never rotate
    # the shared grant, so their responses deliberately carry no updated_auth
    # or readback-error keys — auth_readback is always "unchanged".
    CODEX_VERIFY_OK_KEYS = VERDICT_KEYS | {"codex_version"}
    CODEX_VERIFY_REJECTED_KEYS = VERDICT_KEYS | {"codex_version", "reason"}
    CODEX_VERIFY_TIMEOUT_KEYS = VERDICT_KEYS | {"codex_version", "reason"}

    # Claude CLI probes run from a refresh-stripped HOME and can never rotate
    # the shared grant, so their responses deliberately carry no updated_auth
    # or readback-error keys — auth_readback is always "unchanged".
    CLAUDE_VERIFY_OK_KEYS = VERDICT_KEYS | {"claude_version"}
    CLAUDE_VERIFY_REJECTED_KEYS = VERDICT_KEYS | {"claude_version", "reason"}
    CLAUDE_VERIFY_TIMEOUT_KEYS = VERDICT_KEYS | {"claude_version", "reason"}

    # The Anthropic HTTP probe replaces the CLI for genuine API keys, and is the
    # only path that reports auth_limited.
    CLAUDE_HTTP_OK_KEYS = VERDICT_KEYS | {"claude_version"}
    CLAUDE_HTTP_FAIL_KEYS = CLAUDE_HTTP_OK_KEYS | {"reason"}
    CLAUDE_HTTP_LIMITED_KEYS = CLAUDE_HTTP_FAIL_KEYS | {"auth_limited"}

    EXEC_OK_KEYS = frozenset({"status", "output", "latency_ms", "reachable", "updated_auth"})
    EXEC_FAILED_KEYS = frozenset({"status", "output", "error", "latency_ms", "reachable"})
    # An exec timeout answers 504 with FastAPI's {"detail": ...}, which send()
    # lifts into `reason`.
    EXEC_TIMEOUT_KEYS = frozenset({"detail"})
    EXEC_CLAUDE_OK_KEYS = EXEC_OK_KEYS | {
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    }

    # Fields every draft body carries, next to the engine's `*_version` key.
    DRAFT_KEYS = frozenset({"status", "latency_ms", "reachable"})
    # Every draft handler reports its failure the same way.
    DRAFT_FAIL_KEYS = DRAFT_KEYS | {"reason"}

    SUMMARY_OK_KEYS = DRAFT_KEYS | {"summary"}
    SKILL_DRAFT_KEYS = frozenset(
        {"slug", "display_name", "description", "tags", "what", "when", "steps"}
    )
    SKILL_GENERATE_OK_KEYS = DRAFT_KEYS | SKILL_DRAFT_KEYS
    SKILL_ASSIST_OK_KEYS = SKILL_GENERATE_OK_KEYS | {"assistant_message"}
    PROJECT_ASSIST_OK_KEYS = DRAFT_KEYS | {
        "assistant_message",
        "title",
        "name",
        "description",
        "roster_markdown",
    }

    GENERATED_SKILL = {
        "slug": "banana-drill",
        "display_name": "Banana Drill",
        "description": "Runs the banana drill.",
        "tags": ["banana"],
        "what": "Runs the banana drill end to end.",
        "when": "When an operator asks for a banana drill.",
        "steps": "1. Peel the banana.\n2. Drill.",
    }
    ASSISTED_SKILL = {**GENERATED_SKILL, "assistant_message": "Drafted the banana drill."}
    ASSISTED_PROJECT = {
        "assistant_message": "Filled in what the snapshot supports.",
        "title": "Banana Drill",
        "name": "banana-drill",
        "description": "Keeps the banana drill running.",
        "roster_markdown": "- Owner: the banana team",
    }

    CODEX_AUTH = {"tokens": {"access_token": "sk-openai-test-token"}}
    ROTATED_CODEX_AUTH = {"tokens": {"access_token": "sk-openai-rotated-token"}}
    CLAUDE_AUTH = {"claudeAiOauth": {"accessToken": "sk-ant-oat01-test-token"}}
    ROTATED_CLAUDE_AUTH = {"claudeAiOauth": {"accessToken": "sk-ant-oat01-rotated-token"}}
    CLAUDE_API_KEY_AUTH = {"api_key": "sk-ant-api03-test-token"}

    def setUp(self):
        self.client = TestClient(runner_app.app)
        self._original_secret = runner_app.RUNNER_SHARED_SECRET
        self._original_run = runner_app.subprocess.run
        self._original_post = runner_app.httpx.post
        self._original_engine_exec = runner_app._run_engine_exec
        runner_app.RUNNER_SHARED_SECRET = "runner-secret"

    def tearDown(self):
        runner_app.RUNNER_SHARED_SECRET = self._original_secret
        runner_app.subprocess.run = self._original_run
        runner_app.httpx.post = self._original_post
        runner_app._run_engine_exec = self._original_engine_exec

    def stub_subprocess(self, on_exec):
        """Answer every spawned process: the version probes, then `on_exec(env)`."""

        def fake_run(cmd, env=None, capture_output=False, text=False, timeout=None):
            if "--version" in cmd:
                return _FakeCompletedProcess(0, stdout="1.2.3")
            return on_exec(env)

        runner_app.subprocess.run = fake_run

    def stub_anthropic(self, outcome):
        """Answer the Anthropic HTTP probe with `outcome`, or raise it."""

        def fake_post(url, headers, json, timeout):
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        runner_app.httpx.post = fake_post

    def stub_engine_exec(self, returncode, stdout):
        """Answer the drafting exec with `stdout`; the version probe stays stubbed."""

        def no_cli(env):
            raise AssertionError("the drafting call must go through _run_engine_exec")

        self.stub_subprocess(no_cli)

        def fake_engine_exec(prompt, env, timeout, engine="codex"):
            return _FakeCompletedProcess(returncode, stdout=stdout), 12

        runner_app._run_engine_exec = fake_engine_exec

    def post(self, path, body):
        return self.client.post(path, json=body, headers={"x-runner-auth": "runner-secret"})

    def assertBodyCarries(self, response, expected_keys, status_code=200):
        self.assertEqual(status_code, response.status_code, response.text)
        missing = sorted(set(expected_keys) - set(response.json()))
        self.assertEqual(
            [],
            missing,
            f"runner/app.py dropped response keys the API reads: {missing}",
        )

    def assertDraftContract(self, path, body, ok_stdout, ok_keys):
        """Drive a draft endpoint on both engines, once per exec outcome.

        A failed drafting exec still answers 200 with `reason`, so both outcomes
        are pinned against the same engine-specific version key.
        """
        for engine, auth in (("codex", self.CODEX_AUTH), ("claude", self.CLAUDE_AUTH)):
            version_key = f"{engine}_version"
            for label, returncode, stdout, expected in (
                ("ok", 0, ok_stdout, ok_keys),
                ("non-zero exit", 1, "", self.DRAFT_FAIL_KEYS),
            ):
                with self.subTest(engine=engine, call=label):
                    self.stub_engine_exec(returncode, stdout)

                    response = self.post(
                        path,
                        {
                            **body,
                            "auth_json": auth,
                            "engine": engine,
                            "timeout_seconds": 2.0,
                        },
                    )

                    self.assertBodyCarries(response, expected | {version_key})

    def test_verify_body_carries_every_key_the_api_reads(self):
        def ok(env):
            _write_credentials(_codex_auth_path(env), self.ROTATED_CODEX_AUTH)
            return _FakeCompletedProcess(0, stdout="Banana")

        def rejected(env):
            # An unreadable credential file is the only source of
            # auth_readback_error.
            os.unlink(_codex_auth_path(env))
            return _FakeCompletedProcess(1, stderr="Authentication failed: unauthorized")

        def timed_out(env):
            _write_credentials(_codex_auth_path(env), self.ROTATED_CODEX_AUTH)
            raise subprocess.TimeoutExpired("codex", 2.0)

        for label, on_exec, expected in (
            ("ok", ok, self.CODEX_VERIFY_OK_KEYS),
            ("non-zero exit", rejected, self.CODEX_VERIFY_REJECTED_KEYS),
            ("timeout", timed_out, self.CODEX_VERIFY_TIMEOUT_KEYS),
        ):
            with self.subTest(probe=label):
                self.stub_subprocess(on_exec)

                response = self.post(
                    "/verify",
                    {"auth_json": self.CODEX_AUTH, "timeout_seconds": 2.0},
                )

                self.assertBodyCarries(response, expected)

    def test_verify_claude_cli_body_carries_every_key_the_api_reads(self):
        def ok(env):
            _write_credentials(_claude_auth_path(env), self.ROTATED_CLAUDE_AUTH)
            return _FakeCompletedProcess(0, stdout="Banana")

        def rejected(env):
            os.unlink(_claude_auth_path(env))
            return _FakeCompletedProcess(1, stderr="Authentication failed: unauthorized")

        def timed_out(env):
            _write_credentials(_claude_auth_path(env), self.ROTATED_CLAUDE_AUTH)
            raise subprocess.TimeoutExpired("claude", 2.0)

        for label, on_exec, expected in (
            ("ok", ok, self.CLAUDE_VERIFY_OK_KEYS),
            ("non-zero exit", rejected, self.CLAUDE_VERIFY_REJECTED_KEYS),
            ("timeout", timed_out, self.CLAUDE_VERIFY_TIMEOUT_KEYS),
        ):
            with self.subTest(probe=label):
                self.stub_subprocess(on_exec)

                response = self.post(
                    "/verify-claude",
                    {"auth_json": self.CLAUDE_AUTH, "timeout_seconds": 2.0},
                )

                self.assertBodyCarries(response, expected)

    def test_verify_claude_http_body_carries_every_key_the_api_reads(self):
        class Response:
            def __init__(self, status_code, payload):
                self.status_code = status_code
                self.payload = payload
                self.text = json.dumps(payload)

            def json(self):
                return self.payload

        def no_cli(env):
            raise AssertionError("the API-key probe must not launch the Claude CLI")

        for label, outcome, expected in (
            ("ok", Response(200, {"content": [{"type": "text", "text": "Banana"}]}), self.CLAUDE_HTTP_OK_KEYS),
            (
                "rate limited",
                Response(429, {"error": {"type": "rate_limit_error", "message": "slow down"}}),
                self.CLAUDE_HTTP_LIMITED_KEYS,
            ),
            (
                "rejected",
                Response(401, {"error": {"type": "authentication_error", "message": "bad key"}}),
                self.CLAUDE_HTTP_FAIL_KEYS,
            ),
            ("timeout", runner_app.httpx.TimeoutException("probe timed out"), self.CLAUDE_HTTP_FAIL_KEYS),
        ):
            with self.subTest(probe=label):
                self.stub_subprocess(no_cli)
                self.stub_anthropic(outcome)

                response = self.post(
                    "/verify-claude",
                    {"auth_json": self.CLAUDE_API_KEY_AUTH, "timeout_seconds": 2.0},
                )

                self.assertBodyCarries(response, expected)

    def test_exec_body_carries_every_key_the_api_reads(self):
        def ok(env):
            _write_credentials(_codex_auth_path(env), self.ROTATED_CODEX_AUTH)
            return _FakeCompletedProcess(0, stdout="Banana")

        def failed(env):
            return _FakeCompletedProcess(1, stderr="codex exec failed")

        def timed_out(env):
            raise subprocess.TimeoutExpired("codex", 2.0)

        for label, on_exec, expected, status_code in (
            ("ok", ok, self.EXEC_OK_KEYS, 200),
            ("non-zero exit", failed, self.EXEC_FAILED_KEYS, 200),
            ("timeout", timed_out, self.EXEC_TIMEOUT_KEYS, 504),
        ):
            with self.subTest(call=label):
                self.stub_subprocess(on_exec)

                response = self.post(
                    "/exec",
                    {
                        "auth_json": self.CODEX_AUTH,
                        "prompt": "Reply Banana if this works.",
                        "timeout_seconds": 2.0,
                    },
                )

                self.assertBodyCarries(response, expected, status_code)

    def test_claude_exec_body_carries_token_accounting(self):
        result = {
            "result": "Banana",
            "usage": {
                "input_tokens": 11,
                "output_tokens": 3,
                "cache_creation_input_tokens": 5,
                "cache_read_input_tokens": 7,
            },
        }

        def ok(env):
            _write_credentials(_claude_auth_path(env), self.ROTATED_CLAUDE_AUTH)
            return _FakeCompletedProcess(0, stdout=json.dumps(result))

        self.stub_subprocess(ok)

        response = self.post(
            "/exec",
            {
                "auth_json": self.CLAUDE_AUTH,
                "prompt": "Reply Banana if this works.",
                "engine": "claude",
                "timeout_seconds": 2.0,
            },
        )

        self.assertBodyCarries(response, self.EXEC_CLAUDE_OK_KEYS)

    def test_skill_summary_body_carries_every_key_a_consumer_reads(self):
        """No caller under api/src posts here yet (docs/auth-runner.md records
        that), so this body's shape — `summary` on ok, `reason` on failure,
        beside the engine version key — is pinned here for whoever posts to it.
        """
        self.assertDraftContract(
            "/skills/summarize",
            {"slug": "banana-drill", "manifest": "# Banana Drill\n\nPeel, then drill."},
            "Runs the banana drill for operators who ask for one.",
            self.SUMMARY_OK_KEYS,
        )

    def test_memory_summary_body_carries_every_key_a_consumer_reads(self):
        """Same shape as /skills/summarize and, like it, without an api/src
        caller today; the key set is pinned so the two stay interchangeable.
        """
        self.assertDraftContract(
            "/memories/summarize",
            {"memory_key": "banana-drill", "content": "Peel the banana before drilling."},
            "Records how the banana drill is run.",
            self.SUMMARY_OK_KEYS,
        )

    def test_skill_generate_body_carries_every_key_the_api_reads(self):
        """SkillDraftsService.generate (api/src/services/skill-drafts.ts) reads
        `status`, `reason`, `latency_ms`, `reachable` and `codex_version` off
        this body and hands the whole thing to normalizeSkillDraft, which reads
        `slug`, `display_name`, `description`, `tags`, `what`, `when` and
        `steps`.
        """
        self.assertDraftContract(
            "/skills/generate",
            {"prompt": "Draft a skill for the banana drill."},
            json.dumps(self.GENERATED_SKILL),
            self.SKILL_GENERATE_OK_KEYS,
        )

    def test_skill_assist_body_carries_every_key_the_api_reads(self):
        """SkillDraftsService.assist (api/src/services/skill-drafts.ts) reads the
        generate keys field by field off this body and additionally requires
        `assistant_message`; an absent one is a 502 runner_invalid_payload.
        """
        self.assertDraftContract(
            "/skills/assist",
            {
                "messages": [{"role": "user", "content": "Draft a banana drill skill."}],
                "skill": {},
                "mode": "new",
            },
            json.dumps(self.ASSISTED_SKILL),
            self.SKILL_ASSIST_OK_KEYS,
        )

    def test_project_assist_body_carries_every_key_the_api_reads(self):
        """ProjectDraftsService.assist (api/src/services/project-drafts.ts) reads
        `status`, `reason`, `latency_ms`, `reachable`, `codex_version` and
        `assistant_message`, then buildDraftPayload beside it reads `title`,
        `name`, `description` and `roster_markdown` to decide changed_fields.
        """
        self.assertDraftContract(
            "/projects/assist",
            {"slug": "banana-drill", "project": {"title": "Banana Drill"}},
            json.dumps(self.ASSISTED_PROJECT),
            self.PROJECT_ASSIST_OK_KEYS,
        )


class _FakeImageResponse:
    """Stand-in for urllib's response object; the runner reads only these."""

    def __init__(self, body=b"", status=200, content_type="image/png"):
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self._body = body
        self._offset = 0

    def read(self, size):
        chunk = self._body[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class _FakeOpener:
    """Stand-in for _NO_REDIRECT_OPENER that records the request it was given."""

    def __init__(self, response):
        self.response = response
        self.calls = []

    def open(self, req, timeout=None):
        self.calls.append((req.full_url, timeout))
        return self.response


class RunnerExecImageGuardTest(unittest.TestCase):
    """/exec images are the only caller-controlled fetch the runner makes.

    _assert_public_host is what stops an /exec caller from aiming an image URL
    at 127.0.0.1, an RFC1918 host or the 169.254.169.254 metadata endpoint and
    reading the answer back out of the model's output; the fetch beside it
    refuses redirects (each hop would need its own revalidation), caps the body
    at MAX_REMOTE_IMAGE_BYTES and rejects empty downloads. Nothing here may
    touch real DNS or the network: getaddrinfo and the opener are stubbed.
    """

    PUBLIC_ADDR = "93.184.216.34"

    def setUp(self):
        self._original_getaddrinfo = runner_app.socket.getaddrinfo
        self._original_opener = runner_app._NO_REDIRECT_OPENER
        self._original_b64decode = runner_app.base64.b64decode
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.image_dir = self._tmp.name

    def tearDown(self):
        runner_app.socket.getaddrinfo = self._original_getaddrinfo
        runner_app._NO_REDIRECT_OPENER = self._original_opener
        runner_app.base64.b64decode = self._original_b64decode

    def stub_getaddrinfo(self, addresses):
        """Resolve every host to `addresses`, or raise it; never hit real DNS."""
        self.resolved = []

        def fake_getaddrinfo(host, port, *args, **kwargs):
            self.resolved.append(host)
            if isinstance(addresses, Exception):
                raise addresses
            # The runner reads only sockaddr[0] off each answer.
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (addr, 0)) for addr in addresses]

        runner_app.socket.getaddrinfo = fake_getaddrinfo

    def refuse_getaddrinfo(self):
        """Fail the test if the host is resolved at all."""

        def no_dns(host, port, *args, **kwargs):
            raise AssertionError(f"resolution must not be attempted for {host!r}")

        runner_app.socket.getaddrinfo = no_dns

    def stub_opener(self, response):
        """Answer the single fetch _materialize_remote_image makes."""
        opener = _FakeOpener(response)
        runner_app._NO_REDIRECT_OPENER = opener
        return opener

    def assertRejects(self, detail, callable_, *args):
        with self.assertRaises(HTTPException) as caught:
            callable_(*args)
        self.assertEqual(400, caught.exception.status_code)
        self.assertEqual(detail, caught.exception.detail)
        return caught.exception

    def test_assert_public_host_rejects_every_non_public_resolution(self):
        for kind, addr in (
            ("loopback", "127.0.0.1"),
            ("ipv6 loopback", "::1"),
            ("private", "10.11.12.13"),
            ("private", "192.168.1.7"),
            ("link-local metadata", "169.254.169.254"),
            ("scoped ipv6 link-local", "fe80::1%eth0"),
            ("multicast", "224.0.0.1"),
            ("reserved", "240.0.0.1"),
            ("unspecified", "0.0.0.0"),
        ):
            with self.subTest(kind=kind, addr=addr):
                self.stub_getaddrinfo([addr])

                self.assertRejects(
                    "image host is not allowed",
                    runner_app._assert_public_host,
                    "images.example.com",
                )

    def test_assert_public_host_rejects_a_host_whose_second_answer_is_private(self):
        """Every answer is checked: one public A record must not clear the host."""
        self.stub_getaddrinfo([self.PUBLIC_ADDR, "127.0.0.1"])

        self.assertRejects(
            "image host is not allowed",
            runner_app._assert_public_host,
            "images.example.com",
        )

    def test_assert_public_host_rejects_an_unresolvable_host(self):
        self.stub_getaddrinfo(socket.gaierror("Name or service not known"))

        exc = self.assertRejects(
            "could not resolve image host: Name or service not known",
            runner_app._assert_public_host,
            "no-such-host.example.com",
        )
        self.assertEqual(400, exc.status_code)

    def test_assert_public_host_rejects_an_empty_resolution(self):
        self.stub_getaddrinfo([])

        self.assertRejects(
            "could not resolve image host",
            runner_app._assert_public_host,
            "images.example.com",
        )

    def test_assert_public_host_rejects_a_missing_host_without_resolving(self):
        for hostname in (None, ""):
            with self.subTest(hostname=hostname):
                self.refuse_getaddrinfo()

                self.assertRejects(
                    "image URL is missing a host",
                    runner_app._assert_public_host,
                    hostname,
                )

    def test_assert_public_host_allows_a_public_address(self):
        self.stub_getaddrinfo([self.PUBLIC_ADDR])

        runner_app._assert_public_host("images.example.com")

        self.assertEqual(["images.example.com"], self.resolved)

    def test_materialize_remote_image_rejects_non_http_schemes(self):
        for url in ("file:///etc/passwd", "ftp://example.com/pic.png", "gopher://example.com/pic"):
            with self.subTest(url=url):
                self.refuse_getaddrinfo()
                opener = self.stub_opener(_FakeImageResponse(b"banana"))

                self.assertRejects(
                    "image URLs must use http, https, or data",
                    runner_app._materialize_remote_image,
                    url,
                    self.image_dir,
                    1,
                )
                self.assertEqual([], opener.calls)

    def test_materialize_remote_image_refuses_redirects(self):
        for status in (301, 302, 307):
            with self.subTest(status=status):
                self.stub_getaddrinfo([self.PUBLIC_ADDR])
                self.stub_opener(_FakeImageResponse(b"banana", status=status))

                self.assertRejects(
                    "image download redirects are not allowed",
                    runner_app._materialize_remote_image,
                    "https://images.example.com/pic.png",
                    self.image_dir,
                    1,
                )
                self.assertEqual([], os.listdir(self.image_dir))

    def test_materialize_remote_image_caps_the_download_size(self):
        self.stub_getaddrinfo([self.PUBLIC_ADDR])
        self.stub_opener(_FakeImageResponse(b"\0" * (runner_app.MAX_REMOTE_IMAGE_BYTES + 1)))

        self.assertRejects(
            "downloaded image exceeds maximum allowed size",
            runner_app._materialize_remote_image,
            "https://images.example.com/pic.png",
            self.image_dir,
            1,
        )
        self.assertEqual([], os.listdir(self.image_dir))

    def test_materialize_remote_image_rejects_an_empty_body(self):
        self.stub_getaddrinfo([self.PUBLIC_ADDR])
        self.stub_opener(_FakeImageResponse(b""))

        self.assertRejects(
            "downloaded image is empty",
            runner_app._materialize_remote_image,
            "https://images.example.com/pic.png",
            self.image_dir,
            1,
        )
        self.assertEqual([], os.listdir(self.image_dir))

    def test_materialize_remote_image_writes_the_body_with_the_mime_suffix(self):
        body = b"\x89PNG\r\n\x1a\n" + b"banana" * 20000
        self.stub_getaddrinfo([self.PUBLIC_ADDR])
        opener = self.stub_opener(_FakeImageResponse(body, content_type="image/png"))

        path = runner_app._materialize_remote_image(
            "https://images.example.com/pic",
            self.image_dir,
            3,
        )

        self.assertEqual(os.path.join(self.image_dir, "image-3.png"), path)
        with open(path, "rb") as fh:
            self.assertEqual(body, fh.read())
        self.assertEqual([("https://images.example.com/pic", 15.0)], opener.calls)

    def test_materialize_data_url_image_rejects_a_malformed_data_url(self):
        for url in (
            "data:image/png,QUJD",
            "data:image/png;base64,",
            "data:base64,QUJD",
            "notdata:image/png;base64,QUJD",
        ):
            with self.subTest(url=url):
                self.assertRejects(
                    "invalid base64 image data URL",
                    runner_app._materialize_data_url_image,
                    url,
                    self.image_dir,
                    1,
                )

    def test_materialize_data_url_image_rejects_invalid_base64(self):
        with self.assertRaises(HTTPException) as caught:
            runner_app._materialize_data_url_image(
                "data:image/png;base64,not valid base64!!",
                self.image_dir,
                1,
            )

        self.assertEqual(400, caught.exception.status_code)
        self.assertTrue(
            caught.exception.detail.startswith("invalid base64 image data URL:"),
            caught.exception.detail,
        )
        self.assertEqual([], os.listdir(self.image_dir))

    def test_materialize_data_url_image_rejects_an_empty_payload(self):
        # Padding-only payloads decode to b"" on the runner's Python 3.12 image
        # but are refused outright by newer strict b64 validation, so the empty
        # guard is pinned by stubbing the decode rather than by a literal URL.
        runner_app.base64.b64decode = lambda data, validate=False: b""

        self.assertRejects(
            "image data URL is empty",
            runner_app._materialize_data_url_image,
            "data:image/png;base64,=",
            self.image_dir,
            1,
        )
        self.assertEqual([], os.listdir(self.image_dir))

    def test_materialize_data_url_image_writes_the_decoded_bytes(self):
        raw = b"\x89PNG\r\n\x1a\nbanana"
        url = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")

        path = runner_app._materialize_data_url_image(url, self.image_dir, 2)

        self.assertEqual(os.path.join(self.image_dir, "image-2.png"), path)
        with open(path, "rb") as fh:
            self.assertEqual(raw, fh.read())

    def test_guess_image_suffix_prefers_the_mime_type(self):
        for mime, expected in (
            ("image/png", ".png"),
            ("image/jpeg", ".jpg"),
            ("image/jpeg; charset=binary", ".jpg"),
            ("IMAGE/WEBP", ".webp"),
        ):
            with self.subTest(mime=mime):
                self.assertEqual(
                    expected,
                    runner_app._guess_image_suffix(mime, "https://images.example.com/pic"),
                )

    def test_guess_image_suffix_falls_back_to_the_url_then_img(self):
        self.assertEqual(
            ".gif",
            runner_app._guess_image_suffix(None, "https://images.example.com/pic.gif?v=2"),
        )
        self.assertEqual(
            ".img",
            runner_app._guess_image_suffix("", "https://images.example.com/pic"),
        )

    def test_materialize_exec_images_rejects_a_blank_url(self):
        self.assertRejects(
            "image url is required",
            runner_app._materialize_exec_images,
            [runner_app.ExecImageInput(url="   ")],
            self.image_dir,
        )

    def test_materialize_exec_images_routes_data_urls_and_remote_urls(self):
        calls = []

        def fake_data_url(url, image_dir, index):
            calls.append(("data", url, image_dir, index))
            return f"/data-{index}.png"

        def fake_remote(url, image_dir, index):
            calls.append(("remote", url, image_dir, index))
            return f"/remote-{index}.png"

        original_data_url = runner_app._materialize_data_url_image
        original_remote = runner_app._materialize_remote_image
        runner_app._materialize_data_url_image = fake_data_url
        runner_app._materialize_remote_image = fake_remote
        try:
            paths = runner_app._materialize_exec_images(
                [
                    runner_app.ExecImageInput(url="DATA:image/png;base64,QUJD"),
                    runner_app.ExecImageInput(url="  https://images.example.com/pic.png  "),
                ],
                self.image_dir,
            )
        finally:
            runner_app._materialize_data_url_image = original_data_url
            runner_app._materialize_remote_image = original_remote

        expected_dir = os.path.join(self.image_dir, "exec-images")
        self.assertEqual(["/data-1.png", "/remote-2.png"], paths)
        self.assertEqual(
            [
                ("data", "DATA:image/png;base64,QUJD", expected_dir, 1),
                ("remote", "https://images.example.com/pic.png", expected_dir, 2),
            ],
            calls,
        )
        self.assertTrue(os.path.isdir(expected_dir))


class RunnerSkillDraftSanitizerTest(unittest.TestCase):
    """The draft sanitizers are the only thing between a model's JSON and the
    columns the api writes it to.

    Each max_len passed to _sanitize_skill_line is a column width, not a
    suggestion: the slug call site passes 255 because skills.slug is
    varchar(255), so a return value of max_len + len("...") characters is a row
    MySQL truncates or rejects.
    """

    GENERATED_DRAFT = {
        "slug": "deploy-crane",
        "display_name": "Deploy crane",
        "description": "How to ship the api to crane.",
        "tags": ["deploy", "crane"],
        "what": "\n\nWhat it does  \n",
        "when": "When to reach for it",
        "steps": "1. build\n2. ship",
    }

    def test_sanitize_skill_line_bounds_its_default_max_len(self):
        line = runner_app._sanitize_skill_line("z" * 500)

        self.assertEqual(200, len(line))
        self.assertTrue(line.endswith("..."))

    def test_sanitize_skill_line_never_exceeds_max_len_at_any_call_site(self):
        # 60 tags, 120 display_name/title/name, 180 description, 220 project
        # description, 240 assistant_message, 255 slug.
        for max_len in (60, 120, 180, 220, 240, 255):
            for label, value in (
                ("one under", "a" * (max_len - 1)),
                ("exactly max_len", "a" * max_len),
                ("one over", "a" * (max_len + 1)),
                ("far over", "a" * (max_len * 3)),
                ("punctuated tail", "b" * (max_len - 8) + " ,;:." * 20),
                ("whitespace to collapse", "  " + "c \n" * (max_len * 2) + "  "),
            ):
                with self.subTest(max_len=max_len, value=label):
                    self.assertLessEqual(
                        len(runner_app._sanitize_skill_line(value, max_len=max_len)),
                        max_len,
                    )

    def test_sanitize_skill_line_leaves_short_values_untruncated(self):
        self.assertEqual(
            "Deploy the api to crane",
            runner_app._sanitize_skill_line("  `Deploy the\n api   to crane`  "),
        )

    def test_sanitize_skill_section_trims_blank_edges_and_trailing_space(self):
        section = runner_app._sanitize_skill_section(
            "\r\n\n  \n1. build  \r\n\n2. ship\t\n\n   \n"
        )

        self.assertEqual("1. build\n\n2. ship", section)

    def test_sanitize_skill_tags_ignores_anything_that_is_not_a_list(self):
        for value in ("deploy", {"tags": ["deploy"]}, None, 7):
            with self.subTest(value=value):
                self.assertEqual([], runner_app._sanitize_skill_tags(value))

    def test_sanitize_skill_tags_drops_non_strings_dedupes_and_caps_each_tag(self):
        tags = runner_app._sanitize_skill_tags(
            ["deploy", 7, None, {"tag": "x"}, "  deploy  ", "", "-", "x" * 90, ["crane"]]
        )

        self.assertEqual(["deploy", "x" * 57 + "..."], tags)
        self.assertTrue(all(len(tag) <= 60 for tag in tags))

    def test_extract_json_payload_unwraps_a_fenced_block(self):
        self.assertEqual(
            {"slug": "deploy", "steps": 2},
            runner_app._extract_json_payload('  ```json\n{"slug": "deploy", "steps": 2}\n```  '),
        )

    def test_extract_json_payload_reads_a_bare_object(self):
        self.assertEqual(
            {"slug": "deploy"},
            runner_app._extract_json_payload('\n{"slug": "deploy"}\n'),
        )

    def test_extract_json_payload_rejects_json_that_is_not_an_object(self):
        for label, text in (("array", "[1, 2]"), ("string", '"deploy"'), ("number", "12")):
            with self.subTest(payload=label):
                with self.assertRaises(ValueError) as caught:
                    runner_app._extract_json_payload(text)
                self.assertEqual("runner response was not a JSON object", str(caught.exception))

    def test_normalize_generated_skill_requires_every_field(self):
        for key in ("slug", "display_name", "description", "what", "when", "steps"):
            for label, replacement in (("missing", None), ("blank", "   "), ("non-string", 7)):
                with self.subTest(key=key, value=label):
                    data = dict(self.GENERATED_DRAFT)
                    if replacement is None:
                        data.pop(key)
                    else:
                        data[key] = replacement

                    with self.assertRaises(ValueError) as caught:
                        runner_app._normalize_generated_skill(data)
                    self.assertEqual(f"missing required field: {key}", str(caught.exception))

    def test_normalize_generated_skill_returns_the_skill_keys(self):
        normalized = runner_app._normalize_generated_skill(dict(self.GENERATED_DRAFT))

        self.assertEqual(
            {"slug", "display_name", "description", "tags", "what", "when", "steps"},
            set(normalized),
        )
        self.assertEqual("deploy-crane", normalized["slug"])
        self.assertEqual(["deploy", "crane"], normalized["tags"])
        self.assertEqual("What it does", normalized["what"])

    def test_normalize_generated_skill_keeps_the_slug_inside_the_column_width(self):
        normalized = runner_app._normalize_generated_skill(
            {**self.GENERATED_DRAFT, "slug": "s" * 400}
        )

        # skills.slug is varchar('slug', { length: 255 }).
        self.assertLessEqual(len(normalized["slug"]), 255)

    def test_normalize_assisted_skill_requires_an_assistant_message(self):
        for label, data in (
            ("missing", dict(self.GENERATED_DRAFT)),
            ("blank", {**self.GENERATED_DRAFT, "assistant_message": "  `` "}),
        ):
            with self.subTest(value=label):
                with self.assertRaises(ValueError) as caught:
                    runner_app._normalize_assisted_skill(data)
                self.assertEqual(
                    "missing required field: assistant_message", str(caught.exception)
                )

    def test_normalize_assisted_skill_still_requires_the_skill_fields(self):
        data = {**self.GENERATED_DRAFT, "assistant_message": "Drafted it."}
        data.pop("slug")

        with self.assertRaises(ValueError) as caught:
            runner_app._normalize_assisted_skill(data)
        self.assertEqual("missing required field: slug", str(caught.exception))

    def test_normalize_assisted_skill_adds_assistant_message_to_the_skill_keys(self):
        normalized = runner_app._normalize_assisted_skill(
            {**self.GENERATED_DRAFT, "assistant_message": "Drafted the skill."}
        )

        self.assertEqual(
            {
                "slug",
                "display_name",
                "description",
                "tags",
                "what",
                "when",
                "steps",
                "assistant_message",
            },
            set(normalized),
        )
        self.assertEqual("Drafted the skill.", normalized["assistant_message"])

    def test_normalize_assisted_project_requires_an_assistant_message(self):
        for label, data in (("missing", {}), ("blank", {"assistant_message": " '' "})):
            with self.subTest(value=label):
                with self.assertRaises(ValueError) as caught:
                    runner_app._normalize_assisted_project(data)
                self.assertEqual(
                    "missing required field: assistant_message", str(caught.exception)
                )

    def test_normalize_assisted_project_returns_the_project_keys(self):
        normalized = runner_app._normalize_assisted_project(
            {
                "assistant_message": "Drafted the project.",
                "title": "Crane rollout",
                "name": None,
                "description": 7,
                "roster_markdown": "\n\n- alice\n- bob  \n\n",
            }
        )

        self.assertEqual(
            {"assistant_message", "title", "name", "description", "roster_markdown"},
            set(normalized),
        )
        self.assertEqual("Crane rollout", normalized["title"])
        # Non-string fields are optional, so they fall back to empty rather than
        # failing the whole draft.
        self.assertEqual("", normalized["name"])
        self.assertEqual("", normalized["description"])
        self.assertEqual("- alice\n- bob", normalized["roster_markdown"])


class RunnerClaudeExecResultTest(unittest.TestCase):
    """A claude exec that didn't answer the requested JSON shape must fail closed.

    The claude engine always spawns the CLI with `--output-format json`, so
    _parse_claude_json_result is the only thing between an unexpected stdout and
    a raw JSON blob reaching the caller as the assistant's reply (see its
    docstring). Its None returns, the is_error it lifts out of a 0-exit result
    and the message it recovers from a non-zero exit are each a separate /exec
    branch, so the parser and every branch it feeds are pinned here.
    """

    CLAUDE_AUTH = {"claudeAiOauth": {"accessToken": "sk-ant-oat01-test-token"}}

    # What the CLI prints for a successful `--print --output-format json` run.
    CLAUDE_RESULT = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "duration_ms": 2431,
        "result": "Banana",
        "total_cost_usd": 0.0123,
        "usage": {
            "input_tokens": 11,
            "output_tokens": 3,
            "cache_creation_input_tokens": 5,
            "cache_read_input_tokens": 7,
        },
    }
    ERRORED_RESULT = {
        **CLAUDE_RESULT,
        "subtype": "error_during_execution",
        "is_error": True,
        "result": "Credit balance is too low",
    }

    ZERO_USAGE = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }

    def setUp(self):
        self.client = TestClient(runner_app.app)
        self._original_secret = runner_app.RUNNER_SHARED_SECRET
        self._original_run = runner_app.subprocess.run
        runner_app.RUNNER_SHARED_SECRET = "runner-secret"

    def tearDown(self):
        runner_app.RUNNER_SHARED_SECRET = self._original_secret
        runner_app.subprocess.run = self._original_run

    def stub_exec(self, returncode, stdout="", stderr=""):
        """Answer the one process /exec spawns with the given CLI outcome."""

        def fake_run(cmd, env=None, capture_output=False, text=False, timeout=None):
            return _FakeCompletedProcess(returncode, stdout=stdout, stderr=stderr)

        runner_app.subprocess.run = fake_run

    def exec_claude(self):
        response = self.client.post(
            "/exec",
            json={
                "auth_json": self.CLAUDE_AUTH,
                "prompt": "Reply Banana if this works.",
                "engine": "claude",
                "timeout_seconds": 2.0,
            },
            headers={"x-runner-auth": "runner-secret"},
        )
        self.assertEqual(200, response.status_code, response.text)
        return response.json()

    def test_parse_claude_json_result_rejects_stdout_that_is_not_json(self):
        for label, stdout in (
            ("empty", ""),
            ("prose", "Banana"),
            ("truncated object", '{"result": "Banana"'),
            ("log line before the object", 'starting claude\n{"result": "Banana"}'),
        ):
            with self.subTest(stdout=label):
                self.assertIsNone(runner_app._parse_claude_json_result(stdout))

    def test_parse_claude_json_result_rejects_json_without_a_result_field(self):
        for label, payload in (
            ("empty object", {}),
            ("error envelope", {"type": "result", "is_error": True, "error": "boom"}),
            ("usage only", {"usage": {"input_tokens": 11}}),
        ):
            with self.subTest(payload=label):
                self.assertIsNone(runner_app._parse_claude_json_result(json.dumps(payload)))

    def test_parse_claude_json_result_rejects_json_that_is_not_an_object(self):
        for label, stdout in (
            ("array", '[{"result": "Banana"}]'),
            ("string", '"Banana"'),
            ("number", "12"),
            ("null", "null"),
            ("boolean", "true"),
        ):
            with self.subTest(payload=label):
                self.assertIsNone(runner_app._parse_claude_json_result(stdout))

    def test_parse_claude_json_result_counts_missing_or_non_numeric_usage_as_zero(self):
        for label, payload in (
            ("no usage key", {"result": "Banana"}),
            ("usage is null", {"result": "Banana", "usage": None}),
            ("usage is not an object", {"result": "Banana", "usage": [11, 3]}),
            ("members absent", {"result": "Banana", "usage": {"server_tool_use": {}}}),
            (
                "members are not numbers",
                {
                    "result": "Banana",
                    "usage": {
                        "input_tokens": "11",
                        "output_tokens": None,
                        "cache_creation_input_tokens": {"ephemeral_5m_input_tokens": 5},
                        "cache_read_input_tokens": [7],
                    },
                },
            ),
        ):
            with self.subTest(usage=label):
                parsed = runner_app._parse_claude_json_result(json.dumps(payload))

                self.assertEqual("Banana", parsed["output"])
                self.assertEqual(self.ZERO_USAGE, {key: parsed[key] for key in self.ZERO_USAGE})

    def test_parse_claude_json_result_reads_the_reply_and_every_usage_total(self):
        parsed = runner_app._parse_claude_json_result(json.dumps(self.CLAUDE_RESULT))

        self.assertEqual(
            {
                "output": "Banana",
                "is_error": False,
                "input_tokens": 11,
                "output_tokens": 3,
                "cache_creation_input_tokens": 5,
                "cache_read_input_tokens": 7,
            },
            parsed,
        )

    def test_parse_claude_json_result_lifts_is_error_out_of_a_result(self):
        parsed = runner_app._parse_claude_json_result(json.dumps(self.ERRORED_RESULT))

        self.assertTrue(parsed["is_error"])
        self.assertEqual("Credit balance is too low", parsed["output"])

    def test_exec_fails_closed_when_a_zero_exit_claude_prints_another_shape(self):
        """Raw stdout must not reach the caller as the assistant's reply."""
        for label, stdout in (
            ("prose", "Banana"),
            ("array", '[{"result": "Banana"}]'),
            ("object without result", '{"type": "result", "is_error": false}'),
        ):
            with self.subTest(stdout=label):
                self.stub_exec(0, stdout=stdout)

                body = self.exec_claude()

                self.assertEqual("fail", body["status"])
                self.assertEqual(
                    "claude exec returned an unexpected output format", body["error"]
                )
                self.assertEqual("", body["output"])

    def test_exec_fails_when_a_zero_exit_result_is_flagged_is_error(self):
        self.stub_exec(0, stdout=json.dumps(self.ERRORED_RESULT))

        body = self.exec_claude()

        self.assertEqual("fail", body["status"])
        self.assertEqual("Credit balance is too low", body["error"])
        self.assertEqual("", body["output"])

    def test_exec_prefers_the_parsed_message_over_stderr_on_a_non_zero_exit(self):
        for label, stdout, expected in (
            ("json result", json.dumps(self.ERRORED_RESULT), "Credit balance is too low"),
            ("no parsable result", "", "claude: command failed"),
        ):
            with self.subTest(stdout=label):
                self.stub_exec(1, stdout=stdout, stderr="claude: command failed")

                body = self.exec_claude()

                self.assertEqual("fail", body["status"])
                self.assertEqual(expected, body["error"])
                self.assertEqual("", body["output"])


class RunnerSubprocessEnvIsolationTest(unittest.TestCase):
    """Pin the allowlist that keeps runner secrets out of agent subprocesses.

    _minimal_subprocess_env is the only thing between the runner's own process
    environment -- which holds RUNNER_SHARED_SECRET and the AUTH_RUNNER_* values
    it shares with the API -- and a model-driven codex/claude process. An
    `os.environ.copy()` here, or one extra allow-listed name, would hand that
    secret to the agent, so the allowlist and both env preparers built on it are
    asserted against _SUBPROCESS_ENV_ALLOWLIST itself.
    """

    # Secrets and unrelated operational variables that must never cross over.
    AMBIENT_SECRETS = {
        "RUNNER_SHARED_SECRET": "runner-shared-secret",
        "AUTH_RUNNER_SHARED_SECRET": "auth-runner-shared-secret",
        "AUTH_RUNNER_URL": "https://runner.example.invalid",
        "DATABASE_URL": "postgres://orchestrator:password@db/orchestrator",
    }
    # Only part of the allowlist is set, so the unset names cover the other half
    # of _minimal_subprocess_env: absent variables are omitted, not set empty.
    AMBIENT_ALLOWLISTED = {
        "PATH": "/usr/local/bin:/usr/bin",
        "LANG": "C.UTF-8",
        "TZ": "UTC",
    }

    # Names each preparer sets itself, on top of what the allowlist let through.
    CODEX_OWN_KEYS = {
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "CODEX_SYNC_BASE_URL",
        "CODEX_SYNC_OPTIONAL",
        "CODEX_SYNC_BAKED",
    }
    CLAUDE_OWN_KEYS = {"HOME", "TMPDIR", "TMP", "TEMP", "ANTHROPIC_API_KEY"}

    def setUp(self):
        self._home_parent = tempfile.mkdtemp(prefix="runner-env-isolation-")
        self._original_home_parent = runner_app.RUNNER_HOME_PARENT
        runner_app.RUNNER_HOME_PARENT = self._home_parent
        self._original_environ = dict(os.environ)
        os.environ.clear()
        os.environ.update(self.AMBIENT_SECRETS)
        os.environ.update(self.AMBIENT_ALLOWLISTED)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._original_environ)
        runner_app.RUNNER_HOME_PARENT = self._original_home_parent
        shutil.rmtree(self._home_parent, ignore_errors=True)

    def assertNoSecrets(self, env, allowed):
        self.assertEqual(set(), set(env) - allowed)
        for name in self.AMBIENT_SECRETS:
            self.assertNotIn(name, env)

    def test_minimal_subprocess_env_passes_only_set_allowlisted_names(self):
        env = runner_app._minimal_subprocess_env()

        self.assertNoSecrets(env, set(runner_app._SUBPROCESS_ENV_ALLOWLIST))
        # Set allow-listed names keep their ambient value; unset ones are dropped.
        self.assertEqual(self.AMBIENT_ALLOWLISTED, env)

    def test_prepare_codex_env_adds_nothing_but_its_own_names(self):
        env, home_dir, _auth_path = runner_app._prepare_codex_env(
            {"tokens": {"access_token": "sk-openai-valid-test-token"}}
        )

        try:
            self.assertNoSecrets(
                env, set(runner_app._SUBPROCESS_ENV_ALLOWLIST) | self.CODEX_OWN_KEYS
            )
            self.assertEqual(self.AMBIENT_ALLOWLISTED["PATH"], env["PATH"])
        finally:
            shutil.rmtree(home_dir, ignore_errors=True)

    def test_prepare_claude_env_adds_nothing_but_its_own_names(self):
        env, home_dir, _auth_path = runner_app._prepare_claude_env(
            {"claudeAiOauth": {"accessToken": "sk-ant-oat01-test-token"}}
        )

        try:
            self.assertNoSecrets(
                env, set(runner_app._SUBPROCESS_ENV_ALLOWLIST) | self.CLAUDE_OWN_KEYS
            )
            self.assertEqual(self.AMBIENT_ALLOWLISTED["PATH"], env["PATH"])
        finally:
            shutil.rmtree(home_dir, ignore_errors=True)


APP_SOURCE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.py")


class RunnerCredentialReadbackTest(unittest.TestCase):
    """_credential_readback is the runner's half of the auth self-heal handshake.

    canonical-auth-store.ts reads `auth_readback` and the `updated_auth` blob to
    decide whether a probe rewrote the native credential file: 'error', or an
    'updated' with no replacement bytes, becomes runner_updated_auth_invalid,
    while 'unchanged' must never carry a replacement lineage. Each post-probe
    state is asserted against a real file on disk, including the 400-character
    cap that keeps a runaway exception message out of the verdict, and the state
    names themselves are pinned against every literal app.py assigns.
    """

    ORIGINAL = {
        "claudeAiOauth": {
            "accessToken": "sk-ant-oat01-original-token",
            "refreshToken": "sk-ant-ort01-original-token",
            "expiresAt": 1893456000000,
        }
    }
    # The states canonical-auth-store.ts branches on; 'not_applicable' is what
    # the probe paths that never write a credential file report.
    KNOWN_STATES = {"unchanged", "updated", "error", "not_applicable"}

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.auth_path = os.path.join(self._tmp.name, ".credentials.json")

    def write_credentials(self, text):
        with open(self.auth_path, "w", encoding="utf-8") as fh:
            fh.write(text)

    def readback(self, path=None):
        return runner_app._credential_readback(path or self.auth_path, self.ORIGINAL)

    def assertReadbackError(self, result, expected_error=None):
        """An error verdict never doubles as a replacement lineage."""
        self.assertEqual("error", result["auth_readback"])
        self.assertNotIn("updated_auth", result)
        error = result["auth_readback_error"]
        self.assertNotEqual("", error)
        self.assertLessEqual(len(error), 400)
        if expected_error is not None:
            self.assertEqual(expected_error, error)
        return error

    def test_missing_credential_file_is_an_error_naming_the_exception(self):
        # The file the probe was meant to leave behind is simply not there.
        error = self.assertReadbackError(self.readback())

        self.assertIn("FileNotFoundError", error)

    def test_unparsable_credential_file_is_an_error_naming_the_exception(self):
        self.write_credentials('{"claudeAiOauth": ')

        error = self.assertReadbackError(self.readback())

        self.assertIn("JSONDecodeError", error)

    def test_long_exception_message_is_truncated_to_400_characters(self):
        # A missing path is reported verbatim, so a long enough one is the
        # cheapest way to produce an over-length exception message.
        long_path = os.path.join(self._tmp.name, *["d" * 120] * 5, ".credentials.json")

        error = self.assertReadbackError(self.readback(long_path))

        self.assertEqual(400, len(error))
        self.assertTrue(error.startswith("FileNotFoundError: "), error)
        # Truncated, not merely short: the tail of the path did not survive.
        self.assertNotIn(long_path, error)

    def test_non_object_json_is_an_error_rather_than_a_replacement(self):
        for label, contents in [
            ("empty array", "[]"),
            ("array of objects", '[{"accessToken": "sk-ant-oat01-rotated"}]'),
            ("number", "42"),
            ("string", '"sk-ant-oat01-rotated"'),
            ("null", "null"),
        ]:
            with self.subTest(contents=label):
                self.write_credentials(contents)

                self.assertReadbackError(
                    self.readback(), "credential file did not contain a JSON object"
                )

    def test_identical_object_is_unchanged_with_no_replacement_bytes(self):
        # Comparison is on the parsed object, so a CLI that rewrites the same
        # credentials with different formatting is still 'unchanged'.
        for label, contents in [
            ("as written", json.dumps(self.ORIGINAL)),
            ("reserialized", json.dumps(self.ORIGINAL, indent=2, sort_keys=True)),
        ]:
            with self.subTest(contents=label):
                self.write_credentials(contents)

                self.assertEqual({"auth_readback": "unchanged"}, self.readback())

    def test_differing_object_is_updated_and_carries_the_files_contents(self):
        rotated = {
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-rotated-token",
                "refreshToken": "sk-ant-ort01-rotated-token",
                "expiresAt": 1893542400000,
            }
        }
        for label, updated in [
            ("rotated tokens", rotated),
            # Claude clearing its credential file is a change like any other:
            # the API decides what an empty object means, the runner reports it.
            ("emptied file", {}),
        ]:
            with self.subTest(contents=label):
                self.write_credentials(json.dumps(updated))

                self.assertEqual(
                    {"auth_readback": "updated", "updated_auth": updated}, self.readback()
                )

    def test_every_auth_readback_literal_in_app_is_a_known_state(self):
        with open(APP_SOURCE_PATH, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())

        def is_auth_readback_key(node):
            return isinstance(node, ast.Constant) and node.value == "auth_readback"

        assigned = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values):
                    if is_auth_readback_key(key) and isinstance(value, ast.Constant):
                        assigned.add(value.value)
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if (
                        isinstance(target, ast.Subscript)
                        and is_auth_readback_key(target.slice)
                        and isinstance(node.value, ast.Constant)
                    ):
                        assigned.add(node.value.value)

        self.assertNotEqual(set(), assigned)
        self.assertEqual(
            set(),
            assigned - self.KNOWN_STATES,
            f"app.py reports auth_readback states the API does not handle: "
            f"{sorted(assigned - self.KNOWN_STATES, key=repr)}",
        )


class RunnerCredentialFileTest(unittest.TestCase):
    """Pin how the runner lands a live credential on disk for a CLI to read.

    Both _prepare_*_env write a secret into a throwaway HOME, so the file has to
    stay inside that HOME and stay mode 0600. Codex gets the posted auth.json
    verbatim, but Claude gets only the _claude_native_credentials projection:
    current Claude versions rewrite a non-native envelope (the orchestrator's
    last_refresh/auths metadata) to an empty object, which _credential_readback
    then reports to the API as a destructive token rotation.
    """

    CODEX_AUTH = {
        "OPENAI_API_KEY": None,
        "tokens": {
            "access_token": "ey-chatgpt-access-token",
            "refresh_token": "ey-chatgpt-refresh-token",
            "account_id": "acct-test-1234",
        },
        "last_refresh": "2026-07-29T00:00:00Z",
        "auths": {
            "api.openai.com": {
                "token": "ey-chatgpt-access-token",
                "token_type": "bearer",
            }
        },
    }
    CLAUDE_OAUTH_AUTH = {
        "claudeAiOauth": {
            "accessToken": "sk-ant-oat01-test-token",
            "refreshToken": "sk-ant-ort01-test-token",
            "expiresAt": 123456789,
            "scopes": ["user:inference"],
        },
        "last_refresh": "2026-07-29T00:00:00Z",
        "auths": {
            "api.anthropic.com": {
                "token": "sk-ant-oat01-test-token",
                "token_type": "bearer",
            }
        },
    }
    # An api-key envelope carries no OAuth block, so the projection is already
    # the native shape; what it still has to pin is that the write adds nothing.
    CLAUDE_API_KEY_AUTH = {"api_key": "sk-ant-api03-test-key"}

    def setUp(self):
        self._home_parent = tempfile.mkdtemp(prefix="runner-credential-file-")
        self._original_home_parent = runner_app.RUNNER_HOME_PARENT
        runner_app.RUNNER_HOME_PARENT = self._home_parent

    def tearDown(self):
        runner_app.RUNNER_HOME_PARENT = self._original_home_parent
        shutil.rmtree(self._home_parent, ignore_errors=True)

    def prepare(self, prepare_env, auth_json):
        _env, home_dir, auth_path = prepare_env(auth_json)
        self.addCleanup(shutil.rmtree, home_dir, ignore_errors=True)
        return home_dir, auth_path

    def assertPrivateCredential(self, home_dir, auth_path):
        home_real = os.path.realpath(home_dir)
        auth_real = os.path.realpath(auth_path)
        self.assertEqual(home_real, os.path.commonpath([home_real, auth_real]))
        self.assertNotEqual(home_real, auth_real)
        self.assertEqual(0o600, stat.S_IMODE(os.stat(auth_path).st_mode))

    def read_credential(self, auth_path):
        with open(auth_path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def test_codex_credential_file_is_private_and_verbatim(self):
        home_dir, auth_path = self.prepare(runner_app._prepare_codex_env, self.CODEX_AUTH)

        self.assertEqual(os.path.join(home_dir, ".codex", "auth.json"), auth_path)
        self.assertPrivateCredential(home_dir, auth_path)
        self.assertEqual(self.CODEX_AUTH, self.read_credential(auth_path))

    def test_claude_credential_file_is_private_and_native_only(self):
        for label, auth_json in (
            ("oauth", self.CLAUDE_OAUTH_AUTH),
            ("api key", self.CLAUDE_API_KEY_AUTH),
        ):
            with self.subTest(credential=label):
                home_dir, auth_path = self.prepare(runner_app._prepare_claude_env, auth_json)

                self.assertEqual(
                    os.path.join(home_dir, ".claude", ".credentials.json"), auth_path
                )
                self.assertPrivateCredential(home_dir, auth_path)
                written = self.read_credential(auth_path)
                self.assertEqual(runner_app._claude_native_credentials(auth_json), written)
                self.assertNotIn("last_refresh", written)
                self.assertNotIn("auths", written)


if __name__ == "__main__":
    unittest.main()
