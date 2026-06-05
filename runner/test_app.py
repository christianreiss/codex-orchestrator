import os
import shutil
import unittest

import app as runner_app


class RunnerAppTest(unittest.TestCase):
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
                "Reply Banana if this works.",
            ],
            captured["cmd"],
        )

    def test_build_claude_exec_cmd_uses_supported_print_flag(self):
        cmd = runner_app._build_claude_exec_cmd("Reply Banana.")

        self.assertEqual([runner_app.CLAUDE_CLI_PATH, "--print", "Reply Banana."], cmd)
        self.assertNotIn("--no-input", cmd)

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

    def test_anthropic_api_keys_use_x_api_key_header(self):
        self.assertEqual(
            {"x-api-key": "sk-ant-api03-test-token"},
            runner_app._anthropic_auth_headers("sk-ant-api03-test-token"),
        )

    def test_prepare_claude_env_writes_oauth_credentials_without_api_key_env(self):
        old_key = os.environ.get("ANTHROPIC_API_KEY")
        os.environ["ANTHROPIC_API_KEY"] = "ambient-key"
        try:
            env, home_dir, auth_path = runner_app._prepare_claude_env(
                {
                    "claudeAiOauth": {"accessToken": "sk-ant-oat01-test-token"},
                    "last_refresh": "2026-06-05T00:00:00Z",
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
        finally:
            shutil.rmtree(home_dir, ignore_errors=True)

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
        self.assertTrue(result["auth_limited"])
        self.assertEqual("sk-ant-api03-test-token", captured["headers"]["x-api-key"])
        self.assertNotIn("Authorization", captured["headers"])

    def test_claude_oauth_probe_uses_native_cli(self):
        class Payload:
            auth_json = {
                "claudeAiOauth": {"accessToken": "sk-ant-oat01-test-token"},
                "last_refresh": "2026-06-05T00:00:00Z",
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
            return Result(), 123

        runner_app._run_claude_exec = fake_exec
        runner_app._claude_version = lambda env=None: "1.0.0"
        try:
            result = runner_app._run_claude_probe(Payload())
        finally:
            runner_app._run_claude_exec = original_exec
            runner_app._claude_version = original_version

        self.assertEqual("ok", result["status"])
        self.assertTrue(result["native_oauth"])
        self.assertNotIn("ANTHROPIC_API_KEY", captured["env"])
        self.assertEqual("Reply Banana if this works.", captured["prompt"])


if __name__ == "__main__":
    unittest.main()
