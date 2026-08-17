"""The runner must never claim an engine it cannot run.

The image this module guards used to install Claude Code with a trailing
`|| true`, and `/health` reported availability from `shutil.which("claude")`.
Between the two, an image could build green, boot, answer `{"claude":
{"available": true}}`, and fail every Claude verification — which the
orchestrator reads as "this credential is dead" and quarantines the fleet's
canonical auth.

So each state that lies is pinned here: binary absent, binary present but not
executable, `--version` failing, `--version` printing nothing parseable, and
the CLI reporting a different version than the image was built with.
"""

import subprocess
import unittest

import runner_engines
from runner_engines import EngineRuntime, RunnerStartupError


def _completed(stdout="", returncode=0, stderr=""):
    def run(cmd, **_kwargs):
        return subprocess.CompletedProcess(cmd, returncode, stdout, stderr)

    return run


def _raises(exc):
    def run(cmd, **_kwargs):
        raise exc

    return run


def _which(mapping):
    return lambda name: mapping.get(name)


class ParseVersionTest(unittest.TestCase):
    def test_reads_the_shapes_both_clis_print(self):
        self.assertEqual("0.144.1", runner_engines.parse_version("codex-cli 0.144.1"))
        self.assertEqual("2.1.233", runner_engines.parse_version("2.1.233 (Claude Code)"))
        self.assertEqual(
            "1.2.3-rc.1", runner_engines.parse_version("tool 1.2.3-rc.1 (build)")
        )

    def test_returns_none_when_there_is_no_version(self):
        self.assertIsNone(runner_engines.parse_version(""))
        self.assertIsNone(runner_engines.parse_version("command not found"))


class RequiredEnginesTest(unittest.TestCase):
    def test_unset_requires_nothing(self):
        self.assertEqual((), runner_engines.required_engines({}))
        self.assertEqual((), runner_engines.required_engines({"RUNNER_REQUIRED_ENGINES": "  "}))

    def test_parses_and_deduplicates_in_order(self):
        self.assertEqual(
            ("claude", "codex"),
            runner_engines.required_engines(
                {"RUNNER_REQUIRED_ENGINES": " Claude , codex ,claude "}
            ),
        )

    def test_unknown_engine_is_a_startup_error(self):
        with self.assertRaises(RunnerStartupError):
            runner_engines.required_engines({"RUNNER_REQUIRED_ENGINES": "codex,gemini"})


class ProbeEngineTest(unittest.TestCase):
    def test_missing_binary_is_unavailable(self):
        state = runner_engines.probe_engine("claude", {}, which=_which({}))
        self.assertFalse(state.available)
        self.assertIsNone(state.binary)
        self.assertEqual("not installed", state.detail)

    def test_binary_that_cannot_be_executed_is_unavailable(self):
        state = runner_engines.probe_engine(
            "claude",
            {},
            which=_which({"claude": "/usr/local/bin/claude"}),
            run=_raises(OSError(13, "Permission denied")),
        )
        self.assertFalse(state.available)
        self.assertIn("not executable", state.detail)

    def test_version_timeout_is_unavailable(self):
        state = runner_engines.probe_engine(
            "codex",
            {},
            which=_which({"codex": "/usr/local/bin/codex"}),
            run=_raises(subprocess.TimeoutExpired("codex", 5)),
        )
        self.assertFalse(state.available)
        self.assertEqual("version check timed out", state.detail)

    def test_nonzero_exit_is_unavailable(self):
        state = runner_engines.probe_engine(
            "codex",
            {},
            which=_which({"codex": "/usr/local/bin/codex"}),
            run=_completed(returncode=127),
        )
        self.assertFalse(state.available)
        self.assertIn("exited 127", state.detail)

    def test_unparseable_version_is_unavailable(self):
        state = runner_engines.probe_engine(
            "codex",
            {},
            which=_which({"codex": "/usr/local/bin/codex"}),
            run=_completed(stdout="codex\n"),
        )
        self.assertFalse(state.available)
        self.assertEqual("--version printed no version", state.detail)

    def test_version_on_stderr_still_counts(self):
        state = runner_engines.probe_engine(
            "claude",
            {},
            which=_which({"claude": "/usr/local/bin/claude"}),
            run=_completed(stdout="", stderr="2.1.233 (Claude Code)"),
        )
        self.assertTrue(state.available)
        self.assertEqual("2.1.233", state.version)

    def test_ready_when_version_matches_the_image(self):
        state = runner_engines.probe_engine(
            "claude",
            {"RUNNER_CLAUDE_VERSION": "2.1.233"},
            which=_which({"claude": "/usr/local/bin/claude"}),
            run=_completed(stdout="2.1.233 (Claude Code)"),
        )
        self.assertTrue(state.available)
        self.assertTrue(state.version_matches)
        self.assertEqual("ready", state.detail)

    def test_drifted_version_is_reported_and_not_ready(self):
        state = runner_engines.probe_engine(
            "claude",
            {"RUNNER_CLAUDE_VERSION": "2.1.233"},
            which=_which({"claude": "/usr/local/bin/claude"}),
            run=_completed(stdout="2.0.0 (Claude Code)"),
        )
        # It is installed and answering, so `available` stays true — but it is
        # not the CLI this image was verified with, and readiness says so.
        self.assertTrue(state.available)
        self.assertFalse(state.version_matches)
        self.assertIn("image was built with 2.1.233", state.detail)

    def test_unknown_engine_name_is_rejected(self):
        with self.assertRaises(ValueError):
            runner_engines.probe_engine("gemini", {})


class ReadinessTest(unittest.TestCase):
    def _snapshot(self, **states):
        return {name: state for name, state in states.items()}

    def _ready(self, engine, version="1.0.0"):
        return EngineRuntime(engine, f"/usr/local/bin/{engine}", version, version, "ready")

    def _missing(self, engine):
        return EngineRuntime(engine, None, None, None, "not installed")

    def test_ready_when_every_required_engine_is_present(self):
        snapshot = self._snapshot(codex=self._ready("codex"), claude=self._ready("claude"))
        payload = runner_engines.readiness_payload(snapshot, ("codex", "claude"))
        self.assertEqual("ok", payload["status"])
        self.assertEqual([], payload["problems"])
        self.assertEqual(["codex", "claude"], payload["required_engines"])
        self.assertTrue(payload["engines"]["claude"]["available"])

    def test_missing_required_engine_degrades_and_explains(self):
        snapshot = self._snapshot(codex=self._ready("codex"), claude=self._missing("claude"))
        payload = runner_engines.readiness_payload(snapshot, ("codex", "claude"))
        self.assertEqual("degraded", payload["status"])
        self.assertEqual(["claude: not installed"], payload["problems"])

    def test_an_engine_nobody_requires_does_not_degrade_the_runner(self):
        snapshot = self._snapshot(codex=self._ready("codex"), claude=self._missing("claude"))
        payload = runner_engines.readiness_payload(snapshot, ("codex",))
        self.assertEqual("ok", payload["status"])
        # …but it is still reported honestly rather than omitted.
        self.assertFalse(payload["engines"]["claude"]["available"])

    def test_drifted_required_engine_degrades(self):
        drifted = EngineRuntime(
            "claude", "/usr/local/bin/claude", "2.0.0", "2.1.233", "installed 2.0.0, image was built with 2.1.233"
        )
        payload = runner_engines.readiness_payload({"claude": drifted}, ("claude",))
        self.assertEqual("degraded", payload["status"])

    def test_assert_raises_only_when_a_required_engine_is_broken(self):
        ok = self._snapshot(codex=self._ready("codex"), claude=self._ready("claude"))
        runner_engines.assert_required_engines(ok, ("codex", "claude"))

        broken = self._snapshot(codex=self._ready("codex"), claude=self._missing("claude"))
        with self.assertRaises(RunnerStartupError) as caught:
            runner_engines.assert_required_engines(broken, ("codex", "claude"))
        self.assertIn("claude: not installed", str(caught.exception))

    def test_an_engine_that_was_never_probed_is_a_problem(self):
        payload = runner_engines.readiness_payload({}, ("codex",))
        self.assertEqual(["codex: not probed"], payload["problems"])
