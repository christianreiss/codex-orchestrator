"""`.github/workflows/runner.yml` has to fire on everything this suite reads.

The workflow used to trigger on `runner/**` and itself, but the suite reaches
outside that tree: `test_docs_surface.py` and `test_app.py` both open
`../docs/auth-runner.md` and assert it names exactly the routes the router
registers. A commit editing only that document therefore ran no runner job at
all, so the very drift those two liveness tests exist to catch shipped green.

So the filters are held against the suite itself: every path a `test_*.py`
module spells that resolves outside `runner/` has to be matched by an entry in
both the `push` and the `pull_request` list. The scan is deliberately literal —
a path written in code counts — because an extra entry costs one cheap CI job
and a missing one costs the guarantee the test was written for.
"""

import ast
import glob
import os
import re
import unittest

RUNNER_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(RUNNER_DIR)
WORKFLOW_PATH = os.path.join(RUNNER_DIR, "..", ".github", "workflows", "runner.yml")
WORKFLOW = ".github/workflows/runner.yml"

EVENTS = ("push", "pull_request")

# A string literal that spells a path on its own: `../docs/auth-runner.md`, or
# a runner-relative `docs/auth-runner.md`. A bare filename is not one —
# `"README.md"` names a document, not a location — and a leading `/` marks an
# HTTP route, which is what most slashes in this suite are.
PATH_LITERAL_RE = re.compile(r"(?:\.{1,2}/|[\w@.-]+/)[\w@./-]*")


def _is_os_path_join(func):
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "join"
        and isinstance(func.value, ast.Attribute)
        and func.value.attr == "path"
        and isinstance(func.value.value, ast.Name)
        and func.value.value.id == "os"
    )


def _join_components(call):
    """The constant tail of an `os.path.join(...)`, as path components.

    Leading non-constant arguments are the directory the call starts from —
    every one of them in this suite is derived from `__file__` — so they stand
    for `runner/`. A non-constant that appears after a component leaves a hole
    no resolution can fill, so that call is not a spelled path at all.
    """
    components = []
    for arg in call.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            components.append(arg.value)
        elif components:
            return None
    return components


def _spellings(tree):
    """Every path a module spells, as `(line, as written, components)`."""
    prose = {
        id(node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    }

    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _is_os_path_join(node.func):
            components = _join_components(node)
            if components:
                found.append((node.lineno, "/".join(components), components))
        elif (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in prose
            and PATH_LITERAL_RE.fullmatch(node.value)
        ):
            found.append((node.lineno, node.value, [node.value]))
    return found


def _references():
    """Repo paths outside runner/ that the suite reads, as `(path, where)`.

    A spelling that resolves to nothing is not a repo path — `"image/png"` is a
    media type, `os.path.join(env["HOME"], ".codex", "auth.json")` names a
    fixture under a temporary home — so it drops out here.
    """
    found = []
    for path in sorted(glob.glob(os.path.join(RUNNER_DIR, "test_*.py"))):
        module = os.path.basename(path)
        with open(path, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())

        for line, spelled, components in _spellings(tree):
            resolved = os.path.normpath(os.path.join(RUNNER_DIR, *components))
            if not os.path.exists(resolved):
                continue
            from_root = os.path.relpath(resolved, REPO_ROOT)
            if from_root.startswith(os.pardir):
                continue
            if not os.path.relpath(resolved, RUNNER_DIR).startswith(os.pardir):
                continue
            found.append(
                (from_root.replace(os.sep, "/"), f"{module}:{line} {spelled}")
            )
    return found


def _workflow_triggers():
    """The `paths:` list of each `on:` trigger in the workflow.

    The runner image carries no YAML parser — requirements.txt is FastAPI and
    pytest — so the block is read directly. That is enough for this file: one
    `on:` mapping, whose events each hold a flat list of quoted scalars.
    """
    with open(WORKFLOW_PATH, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    triggers = {}
    in_on = False
    event = None
    in_paths = False
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())

        if in_paths:
            if indent >= 6 and stripped.startswith("- "):
                triggers[event].append(stripped[2:].strip().strip("'\""))
                continue
            in_paths = False

        if indent == 0:
            in_on = stripped == "on:"
            event = None
        elif in_on and indent == 2 and stripped.endswith(":"):
            event = stripped[:-1]
            triggers.setdefault(event, [])
        elif event is not None and indent == 4 and stripped == "paths:":
            in_paths = True

    return triggers


def _matches(pattern, path):
    """GitHub's path-filter globbing: `*` stays in one segment, `**` crosses."""
    regex = ""
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if pattern[index + 1 : index + 2] == "*":
                regex += ".*"
                index += 2
                continue
            regex += "[^/]*"
        elif char == "?":
            regex += "[^/]"
        else:
            regex += re.escape(char)
        index += 1
    return re.fullmatch(regex, path) is not None


REFERENCES = _references()
TRIGGERS = _workflow_triggers()


class RunnerWorkflowPathTriggersTest(unittest.TestCase):
    def test_reads_both_trigger_filters(self):
        # A parse that quietly found nothing would pass everything below.
        for event in EVENTS:
            with self.subTest(event=event):
                self.assertIn(event, TRIGGERS)
                self.assertIn("runner/**", TRIGGERS[event])
                self.assertIn(WORKFLOW, TRIGGERS[event])
                # `_matches` reads every entry as an include, so a negation
                # would be honoured backwards.
                self.assertEqual(
                    [], [entry for entry in TRIGGERS[event] if entry.startswith("!")]
                )

        self.assertTrue(_matches("runner/**", "runner/app.py"))
        self.assertFalse(_matches("runner/**", "docs/auth-runner.md"))
        self.assertTrue(_matches("docs/auth-runner.md", "docs/auth-runner.md"))
        self.assertFalse(_matches("docs/*.md", "docs/nested/auth-runner.md"))

    def test_finds_the_paths_the_suite_is_known_to_read(self):
        # Likewise: a scan that matched nothing, or one that stopped seeing the
        # `os.path.join(RUNNER_DIR, "..", ...)` spelling, has nothing to guard.
        referenced = {path for path, _ in REFERENCES}

        self.assertIn("docs/auth-runner.md", referenced)
        self.assertIn(WORKFLOW, referenced)

    def test_triggers_on_every_path_the_suite_reads(self):
        uncovered = sorted(
            {
                f"{where} — {path} is not matched by the {event} paths of {WORKFLOW}"
                for path, where in REFERENCES
                for event in EVENTS
                if not any(
                    _matches(entry, path) for entry in TRIGGERS.get(event, [])
                )
            }
        )

        self.assertEqual([], uncovered)
