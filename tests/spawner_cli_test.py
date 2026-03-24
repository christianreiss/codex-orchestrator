import unittest

import spawner


class SpawnerCliTest(unittest.TestCase):
    def test_build_codex_exec_command_includes_supported_exec_flags(self) -> None:
        options = spawner.CodexExecOptions(
            config_overrides=["model_provider=\"oss\""],
            enable_features=["foo"],
            disable_features=["bar"],
            images=["diagram.png"],
            oss=True,
            local_provider="ollama",
            profile="ops",
            bypass_approvals_and_sandbox=False,
            sandbox_mode="workspace-write",
            full_auto=True,
            add_dirs=["/tmp/shared"],
            ephemeral=True,
            output_schema="/tmp/schema.json",
            color="never",
            progress_cursor=True,
            json_output=True,
        )

        cmd = spawner.build_codex_exec_command(
            model="gpt-5.4",
            prompt="hello",
            output_file="/tmp/out.txt",
            options=options,
        )

        self.assertEqual(cmd[:2], ["codex", "exec"])
        self.assertIn("--config", cmd)
        self.assertIn("model_provider=\"oss\"", cmd)
        self.assertIn("--enable", cmd)
        self.assertIn("foo", cmd)
        self.assertIn("--disable", cmd)
        self.assertIn("bar", cmd)
        self.assertIn("--image", cmd)
        self.assertIn("diagram.png", cmd)
        self.assertIn("--oss", cmd)
        self.assertIn("--local-provider", cmd)
        self.assertIn("ollama", cmd)
        self.assertIn("--profile", cmd)
        self.assertIn("ops", cmd)
        self.assertIn("--sandbox", cmd)
        self.assertIn("workspace-write", cmd)
        self.assertIn("--full-auto", cmd)
        self.assertIn("--add-dir", cmd)
        self.assertIn("/tmp/shared", cmd)
        self.assertIn("--ephemeral", cmd)
        self.assertIn("--output-schema", cmd)
        self.assertIn("/tmp/schema.json", cmd)
        self.assertIn("--color", cmd)
        self.assertIn("never", cmd)
        self.assertIn("--progress-cursor", cmd)
        self.assertIn("--json", cmd)
        self.assertIn("-o", cmd)
        self.assertEqual(cmd[-1], "hello")

    def test_dangerous_bypass_remains_default_and_suppresses_conflicting_sandbox_flags(self) -> None:
        options = spawner.CodexExecOptions(
            bypass_approvals_and_sandbox=True,
            sandbox_mode="read-only",
            full_auto=True,
        )

        cmd = spawner.build_codex_exec_command(
            model="gpt-5.4",
            prompt="hello",
            output_file="/tmp/out.txt",
            options=options,
        )

        self.assertIn("--dangerously-bypass-approvals-and-sandbox", cmd)
        self.assertNotIn("--sandbox", cmd)
        self.assertNotIn("--full-auto", cmd)


if __name__ == "__main__":
    unittest.main()
