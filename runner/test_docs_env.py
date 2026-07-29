import ast
import os
import re
import unittest

# Same section/bullet parsing the route-inventory test uses, so both doc tests
# read docs/auth-runner.md the same way.
from test_docs_surface import AUTH_RUNNER_DOC_PATH, _bullet_lines, _section_lines

RUNNER_DIR = os.path.dirname(os.path.abspath(__file__))
APP_PATH = os.path.join(RUNNER_DIR, "app.py")

CONFIG_HEADING = "## Configuration quick reference"
PROBE_HEADING = "## Probe lifecycle (runner/app.py)"

# Marks a quick-reference entry as a knob of the runner container rather than of
# the API process.
RUNNER_CONTAINER_MARKER = "(runner container)"

# A backticked env name, optionally written with its value (`APP_ENV=production`).
# Requiring the whole backticked span to be one SHOUTING_NAME keeps route paths,
# header names and defaults out of the documented set.
ENV_NAME_RE = re.compile(r"`([A-Z][A-Z0-9_]*)(?:=[^`]*)?`")

# The one allowlist: env names the quick reference documents that runner/app.py
# never reads. Every `AUTH_RUNNER_*` knob is API-side config that lives in the
# same list, so it is deliberately absent from the runner-container entries.
# Nothing else is excused — any other delta is fixed by correcting the document
# (or app.py), not by growing this.
API_ONLY_PREFIX = "AUTH_RUNNER_"


def _app_tree():
    with open(APP_PATH, encoding="utf-8") as fh:
        return ast.parse(fh.read())


def _reads_env(func):
    """True for the `os.getenv` / `os.environ.get` call targets."""
    if not isinstance(func, ast.Attribute):
        return False
    if func.attr == "getenv":
        return isinstance(func.value, ast.Name) and func.value.id == "os"
    if func.attr == "get":
        environ = func.value
        return (
            isinstance(environ, ast.Attribute)
            and environ.attr == "environ"
            and isinstance(environ.value, ast.Name)
            and environ.value.id == "os"
        )
    return False


def _env_names_app_reads():
    names = set()
    for node in ast.walk(_app_tree()):
        if not (isinstance(node, ast.Call) and _reads_env(node.func) and node.args):
            continue
        name = node.args[0]
        # `os.environ.get(key)` in the subprocess-env allowlist loop reads a
        # loop variable, not a container knob.
        if isinstance(name, ast.Constant) and isinstance(name.value, str):
            names.add(name.value)
    return names


def _codex_exec_flags():
    """Every literal flag `_build_codex_exec_cmd` can put on the command line."""
    for node in ast.walk(_app_tree()):
        if isinstance(node, ast.FunctionDef) and node.name == "_build_codex_exec_cmd":
            return {
                child.value
                for child in ast.walk(node)
                if isinstance(child, ast.Constant)
                and isinstance(child.value, str)
                and child.value.startswith("-")
            }
    raise AssertionError("runner/app.py no longer defines _build_codex_exec_cmd")


def _config_entries():
    """The quick reference's bullets, each joined into a single string."""
    entries = []
    for line in _bullet_lines(_section_lines(AUTH_RUNNER_DOC_PATH, CONFIG_HEADING)):
        if line.startswith("-"):
            entries.append(line)
        else:
            entries[-1] += " " + line.strip()
    return entries


def _env_names_in(entries):
    return {name for entry in entries for name in ENV_NAME_RE.findall(entry)}


def _probe_command_line():
    lines = [
        line
        for line in _section_lines(AUTH_RUNNER_DOC_PATH, PROBE_HEADING)
        if "/usr/local/bin/codex exec" in line
    ]

    if len(lines) != 1:
        raise AssertionError(
            f"expected exactly one '/usr/local/bin/codex exec' step under "
            f"'{PROBE_HEADING}', found {len(lines)}"
        )
    return lines[0]


def _command_tokens(line):
    return {token.strip("`\"'") for token in line.split()}


class RunnerDocsEnvTest(unittest.TestCase):
    """docs/auth-runner.md is what operators are pointed at for the container.

    Its two derived facts are pinned here: every runner-container knob comes
    from an env literal in `runner/app.py`, and every flag in the documented
    probe command comes from `_build_codex_exec_cmd`. Both drifted silently
    before, because `test_docs_surface.py` only checks the route inventory.
    """

    def setUp(self):
        self.app_env_names = _env_names_app_reads()
        self.assertNotEqual(set(), self.app_env_names)

        entries = _config_entries()
        self.documented = _env_names_in(entries)
        self.runner_documented = _env_names_in(
            [entry for entry in entries if RUNNER_CONTAINER_MARKER in entry]
        )
        self.assertNotEqual(set(), self.runner_documented)

    def test_every_env_app_reads_is_a_runner_container_entry(self):
        missing = sorted(
            name
            for name in self.app_env_names - self.runner_documented
            if not name.startswith(API_ONLY_PREFIX)
        )

        self.assertEqual(
            [],
            missing,
            f"read by runner/app.py but missing from docs/auth-runner.md's "
            f"'{RUNNER_CONTAINER_MARKER}' entries: {', '.join(missing)}",
        )

    def test_the_quick_reference_names_no_env_the_runner_ignores(self):
        stale = sorted(
            name
            for name in self.documented - self.app_env_names
            if not name.startswith(API_ONLY_PREFIX)
        )

        self.assertEqual(
            [],
            stale,
            f"documented in '{CONFIG_HEADING}' but read nowhere in runner/app.py: "
            f"{', '.join(stale)}",
        )

    def test_the_probe_command_names_every_codex_exec_flag(self):
        line = _probe_command_line()
        tokens = _command_tokens(line)

        # `--image` is reachable only from /exec; the step says so rather than
        # putting it in the probe invocation itself.
        missing = sorted(_codex_exec_flags() - tokens)

        self.assertEqual(
            [],
            missing,
            f"emitted by _build_codex_exec_cmd but absent from the documented "
            f"probe command: {', '.join(missing)}",
        )
