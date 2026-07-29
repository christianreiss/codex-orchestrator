import os
import re
import unittest

from fastapi.routing import APIRoute

import app as runner_app

RUNNER_DIR = os.path.dirname(os.path.abspath(__file__))
README_PATH = os.path.join(RUNNER_DIR, "README.md")
AUTH_RUNNER_DOC_PATH = os.path.join(RUNNER_DIR, "..", "docs", "auth-runner.md")

README_INDEX_HEADING = "## HTTP API"
AUTH_RUNNER_DOC_HEADING = "## HTTP surface (runner container)"

# Matches a route written as a single backticked `METHOD /path`. Matching the
# pair, not the bare path, keeps `POST /verify` from vouching for
# `/verify-claude` (or any other route it happens to be a prefix of).
ROUTE_RE = re.compile(r"`(GET|POST|PUT|PATCH|DELETE) (/[^`\s]*)`")

# Registered routes excused from one or more of the checks below, and documented
# `METHOD /path` pairs excused from the reverse check. Empty on purpose: every
# route the router serves is in both documents, and neither document names a
# route the runner does not serve. Anything added here needs a comment saying
# why that delta is correct — a failure of these tests is otherwise fixed by
# correcting the document, not by growing this list.
ALLOWED_DELTAS = frozenset()


def _registered_routes():
    return {
        (method, route.path)
        for route in runner_app.app.routes
        # Skip FastAPI's own /docs, /redoc and /openapi.json plumbing.
        if isinstance(route, APIRoute)
        for method in route.methods
    }


def _section_lines(path, heading):
    """The body of one markdown section, up to the next heading of any level."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    if heading not in lines:
        raise AssertionError(f"{path} no longer has a '{heading}' section")

    body = []
    in_section = False
    for line in lines:
        if line.startswith("#"):
            if in_section:
                break
            in_section = line == heading
            continue
        if in_section:
            body.append(line)

    return body


def _bullet_lines(lines):
    """The bullet items of a markdown list, plus their continuation lines."""
    kept = []
    in_item = False
    for line in lines:
        if line.startswith("-"):
            in_item = True
        elif line.strip() and not line[:1].isspace():
            in_item = False
        if in_item:
            kept.append(line)
    return kept


def _routes_in(lines):
    return set(ROUTE_RE.findall("\n".join(lines)))


class RunnerDocsSurfaceTest(unittest.TestCase):
    """The runner's two documents describe an HTTP contract the API codes against.

    Both were hand-reconciled against `runner/app.py` after they drifted, so
    every part of that reconciliation is checked here: the README index, the
    per-route README sections, and the docs/auth-runner.md surface list each
    have to name exactly the routes `app.routes` reports.
    """

    def setUp(self):
        self.registered = _registered_routes() - ALLOWED_DELTAS
        self.assertNotEqual(set(), self.registered)

    def readme_index_routes(self):
        return _routes_in(_bullet_lines(_section_lines(README_PATH, README_INDEX_HEADING)))

    def readme_section_routes(self):
        with open(README_PATH, encoding="utf-8") as fh:
            headings = [line for line in fh.read().splitlines() if line.startswith("### ")]
        return _routes_in(headings)

    def auth_runner_doc_routes(self):
        return _routes_in(
            _bullet_lines(_section_lines(AUTH_RUNNER_DOC_PATH, AUTH_RUNNER_DOC_HEADING))
        )

    def assert_covers(self, documented, where):
        missing = sorted(f"{method} {path}" for method, path in self.registered - documented)

        self.assertEqual([], missing, f"missing from {where}: {', '.join(missing)}")

    def test_every_registered_route_is_in_the_readme_index(self):
        self.assert_covers(self.readme_index_routes(), f"the '{README_INDEX_HEADING}' index")

    def test_every_registered_route_has_a_readme_section(self):
        self.assert_covers(self.readme_section_routes(), "runner/README.md's `### METHOD /path` sections")

    def test_every_registered_route_is_in_the_auth_runner_doc(self):
        self.assert_covers(self.auth_runner_doc_routes(), f"docs/auth-runner.md's '{AUTH_RUNNER_DOC_HEADING}' list")

    def test_neither_document_names_an_unregistered_route(self):
        documented = (
            self.readme_index_routes()
            | self.readme_section_routes()
            | self.auth_runner_doc_routes()
        )

        unregistered = sorted(
            f"{method} {path}"
            for method, path in documented - _registered_routes() - ALLOWED_DELTAS
        )

        self.assertEqual(
            [],
            unregistered,
            f"documented as runner routes but not registered: {', '.join(unregistered)}",
        )
