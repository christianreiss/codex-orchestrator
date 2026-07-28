import asyncio
import inspect
import os
import json
import re
import shutil
import subprocess
import typing
import unittest

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

    def test_codex_success_reports_unreadable_post_probe_credentials(self):
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
        self.assertEqual("error", result["auth_readback"])
        self.assertIn("FileNotFoundError", result["auth_readback_error"])

    def test_claude_success_reports_malformed_post_probe_credentials(self):
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
        self.assertEqual("error", result["auth_readback"])
        self.assertIn("JSON object", result["auth_readback_error"])

    def test_native_probe_timeouts_return_changed_credentials_for_both_engines(self):
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

        for result in (codex_result, claude_result):
            self.assertEqual("fail", result["status"])
            self.assertFalse(result["definitive"])
            self.assertEqual("updated", result["auth_readback"])
            self.assertIn("updated_auth", result)

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
        self.assertEqual(
            {
                "claudeAiOauth": {
                    "accessToken": "sk-ant-oat01-test-token",
                    "refreshToken": "test-refresh-token",
                }
            },
            captured["credentials"],
        )
        self.assertEqual("unchanged", result["auth_readback"])
        self.assertNotIn("updated_auth", result)

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
    """docs/auth-runner.md is the only description of this HTTP surface.

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
    """

    # Verdict fields every /verify and /verify-claude body carries.
    VERDICT_KEYS = frozenset({"status", "reachable", "definitive", "latency_ms", "auth_readback"})

    CODEX_VERIFY_OK_KEYS = VERDICT_KEYS | {"codex_version", "updated_auth"}
    CODEX_VERIFY_REJECTED_KEYS = VERDICT_KEYS | {"codex_version", "reason", "auth_readback_error"}
    CODEX_VERIFY_TIMEOUT_KEYS = VERDICT_KEYS | {"codex_version", "reason", "updated_auth"}

    CLAUDE_VERIFY_OK_KEYS = VERDICT_KEYS | {"claude_version", "updated_auth"}
    CLAUDE_VERIFY_REJECTED_KEYS = VERDICT_KEYS | {"claude_version", "reason", "auth_readback_error"}
    CLAUDE_VERIFY_TIMEOUT_KEYS = VERDICT_KEYS | {"claude_version", "reason", "updated_auth"}

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
        runner_app.RUNNER_SHARED_SECRET = "runner-secret"

    def tearDown(self):
        runner_app.RUNNER_SHARED_SECRET = self._original_secret
        runner_app.subprocess.run = self._original_run
        runner_app.httpx.post = self._original_post

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


if __name__ == "__main__":
    unittest.main()
