"""Every third-party module `runner/app.py` imports has to be pinned.

`app.py` imports `pydantic` at module scope, but requirements.txt named only
fastapi, starlette, httpx, uvicorn and pytest — pydantic reached the image and
CI purely as a transitive dependency of FastAPI. The Dockerfile
(`pip install --no-cache-dir -r requirements.txt`) and the runner workflow
(`pip install -r requirements.txt`) install from that file and nothing else, so
an undeclared direct import breaks the moment FastAPI drops or renames its own
dependency — and no other test here can see that coming, because they all pass
while the transitive package happens to be present.

So the manifest is held against the imports in both directions: a third-party
import no entry pins fails, and an entry no import names has to spell its
reason in `UNIMPORTED_DISTRIBUTIONS` below.
"""

import ast
import os
import re
import sys
import unittest

RUNNER_DIR = os.path.dirname(os.path.abspath(__file__))
APP_PATH = os.path.join(RUNNER_DIR, "app.py")
REQUIREMENTS_PATH = os.path.join(RUNNER_DIR, "requirements.txt")

# Import name -> the distribution that ships it, for the pairs that differ.
# Every third-party import in app.py spells its own distribution today; an
# entry belongs here when that stops holding (`yaml` ships as PyYAML).
DISTRIBUTION_FOR_IMPORT = {}

# Entries no import in app.py names, each with the reason it is pinned anyway.
UNIMPORTED_DISTRIBUTIONS = {
    "starlette": "FastAPI's ASGI layer, pinned so the version is ours to pick.",
    "uvicorn": "the ASGI server entrypoint.sh execs: `uvicorn app:app`.",
    "pytest": "runs this suite; a test-time tool app.py never imports.",
}

# The distribution at the head of a requirement line, before any extras or
# version specifier: `uvicorn[standard]==0.32.0` yields `uvicorn`.
REQUIREMENT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def _normalize(name):
    """PEP 503 comparison form, so `Foo_Bar` and `foo-bar` are one name."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _imported_modules():
    """Every top-level module `app.py` imports."""
    with open(APP_PATH, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())

    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name.split(".")[0])
        # A relative `from . import x` names no distribution to pin.
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            modules.add(node.module.split(".")[0])
    return modules


def _pinned_distributions():
    """The distributions requirements.txt names, in comparison form."""
    pinned = set()
    with open(REQUIREMENTS_PATH, encoding="utf-8") as fh:
        for line in fh:
            entry = line.split("#", 1)[0].strip()
            if entry:
                pinned.add(_normalize(REQUIREMENT_RE.match(entry).group()))
    return pinned


def _distribution(module):
    return _normalize(DISTRIBUTION_FOR_IMPORT.get(module, module))


IMPORTED = _imported_modules()
THIRD_PARTY = sorted(name for name in IMPORTED if name not in sys.stdlib_module_names)
PINNED = _pinned_distributions()


class RequirementsCoverImportsTest(unittest.TestCase):
    def test_reads_the_imports_and_the_pins(self):
        # A scan that quietly found nothing, or a manifest read as empty, would
        # pass everything below without checking anything at all.
        self.assertNotEqual([], THIRD_PARTY)
        self.assertIn("fastapi", THIRD_PARTY)
        self.assertNotEqual(set(), PINNED)
        self.assertIn("fastapi", PINNED)

        # And the stdlib filter has to be dropping the imports it is there for,
        # rather than letting every name through as third-party.
        self.assertIn("os", IMPORTED)
        self.assertNotIn("os", THIRD_PARTY)

    def test_every_third_party_import_is_pinned(self):
        missing = sorted(
            f"app.py imports {module}, which no requirements.txt entry pins"
            for module in THIRD_PARTY
            if _distribution(module) not in PINNED
        )

        self.assertEqual([], missing)

    def test_every_pin_is_imported_or_explained(self):
        imported = {_distribution(module) for module in THIRD_PARTY}

        unexplained = sorted(
            f"{name} is pinned but app.py never imports it — give it a reason "
            f"in UNIMPORTED_DISTRIBUTIONS"
            for name in PINNED
            if name not in imported and not UNIMPORTED_DISTRIBUTIONS.get(name)
        )

        self.assertEqual([], unexplained)

        # A reason for an entry that is gone, or for one app.py does import, is
        # stale: it excuses a pin nothing here is checking any more.
        stale = sorted(
            name
            for name in UNIMPORTED_DISTRIBUTIONS
            if name not in PINNED or name in imported
        )

        self.assertEqual([], stale)
