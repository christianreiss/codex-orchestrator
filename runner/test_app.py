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


if __name__ == "__main__":
    unittest.main()
