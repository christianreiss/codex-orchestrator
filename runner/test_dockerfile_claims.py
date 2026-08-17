"""`runner/README.md` states hard facts about what `runner/Dockerfile` builds.

The pin is the load-bearing one, and the Dockerfile comment says why: a
`CODEX_TAG` of 0.125.0 probed with a model that CLI did not know and rejected
every VALID fresh login as "failed live verification". The next operator
chasing that failure reads the README for the tag the image actually carries,
so a bump of `ARG CODEX_TAG` that leaves the README quoting the old tag sends
them after the wrong thing.

So every claim the Build and Environment sections make is held against the
instruction it describes: the tag, the overridable build args, the
architectures the Codex download knows how to fetch, the Node major, and the
`RUNNER_HOME_PARENT` the image bakes in. The Dockerfile is the source of
truth — a failure here is fixed by correcting the README.

The runner image carries no Dockerfile parser — requirements.txt is FastAPI
and pytest — so the instructions are read directly. That is enough for this
file: unindented `ARG`/`ENV` lines, and one `case "$arch" in` per download
step.
"""

import os
import re
import unittest

RUNNER_DIR = os.path.dirname(os.path.abspath(__file__))
DOCKERFILE_PATH = os.path.join(RUNNER_DIR, "Dockerfile")
README_PATH = os.path.join(RUNNER_DIR, "README.md")

BUILD_HEADING = "## Build"
ENVIRONMENT_HEADING = "## Environment variables"

# `ARG TARGETARCH` counts as declared: the README offers it as a value to set,
# not as an arg with a baked-in default.
ARG_RE = re.compile(r"^ARG\s+([A-Za-z_]\w*)(?:=(\S*))?$")
ENV_RE = re.compile(r"^ENV\s+([A-Za-z_]\w*)=(\S+)$")
CASE_OPEN_RE = re.compile(r'^case\s+"\$arch"\s+in$')
CASE_ARM_RE = re.compile(r"^([\w*]+)\)\s*(.*)$")

# The Build section's claims, as written. `default `...`` is the pin clause;
# `defaults to `...`` elsewhere in the README is a different kind of sentence
# and does not match.
CLAIMED_TAG_RE = re.compile(r"default `([^`]+)`")
CLAIMED_BUILD_ARGS_RE = re.compile(r"Override via build args ([^.]*)\.")
CLAIMED_ARCHES_RE = re.compile(r"Supported `TARGETARCH` values are ([^.]*)\.")
CLAIMED_NODE_VERSION_RE = re.compile(r"Node\.js (\d+(?:\.\d+)+)")
CLAIMED_CLAUDE_VERSION_RE = re.compile(r"`@anthropic-ai/claude-code@([^`]+)`")
CLAIMED_HOME_PARENT_RE = re.compile(
    r"`RUNNER_HOME_PARENT`[^.\n]*?"
    r"the bundled image (?:sets it to|defaults this to) `([^`]+)`"
)
BACKTICKED_RE = re.compile(r"`([^`]+)`")


def _dockerfile_lines():
    with open(DOCKERFILE_PATH, encoding="utf-8") as fh:
        # A continued shell line ends in `\`; the trailing `;` is noise here.
        return [line.strip().rstrip("\\").strip() for line in fh.read().splitlines()]


def _args(lines):
    """Every declared build arg, as `name -> default` (`None` when undeclared)."""
    found = {}
    for line in lines:
        match = ARG_RE.match(line)
        if match:
            found[match.group(1)] = match.group(2)
    return found


def _envs(lines):
    return {
        match.group(1): match.group(2)
        for match in (ENV_RE.match(line) for line in lines)
        if match
    }


def _codex_case_arches(lines):
    """Architectures the Codex download step handles, minus the error arm.

    The Dockerfile runs a second `case "$arch" in` for the Node tarball; the
    one that picks the Codex asset is the one whose arms read `CODEX_ASSET_*`.
    """
    blocks = []
    arms = None
    for line in lines:
        if CASE_OPEN_RE.match(line):
            arms = {}
            continue
        if arms is None:
            continue
        if line.startswith("esac"):
            blocks.append(arms)
            arms = None
            continue
        match = CASE_ARM_RE.match(line)
        if match:
            arms[match.group(1)] = match.group(2)

    codex = [
        block
        for block in blocks
        if any("CODEX_ASSET_" in body for body in block.values())
    ]
    if len(codex) != 1:
        raise AssertionError(
            f"expected exactly one Codex-download `case \"$arch\" in` in "
            f"{DOCKERFILE_PATH}, found {len(codex)}"
        )
    return {token for token in codex[0] if token != "*"}


def _section(heading):
    """The body of one README section, up to the next heading of any level."""
    with open(README_PATH, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    if heading not in lines:
        raise AssertionError(f"{README_PATH} no longer has a '{heading}' section")

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

    return "\n".join(body)


ARGS = _args(_dockerfile_lines())
ENVS = _envs(_dockerfile_lines())
CODEX_ARCHES = _codex_case_arches(_dockerfile_lines())

BUILD = _section(BUILD_HEADING)
ENVIRONMENT = _section(ENVIRONMENT_HEADING)


class RunnerDockerfileClaimsTest(unittest.TestCase):
    """Held both ways wherever the README claims a whole set."""

    def test_reads_both_files(self):
        # A regex that quietly stopped matching would pass everything below.
        self.assertIn("CODEX_TAG", ARGS)
        self.assertIn("NODE_VERSION", ARGS)
        self.assertIn("CLAUDE_CODE_VERSION", ARGS)
        self.assertIn("RUNNER_HOME_PARENT", ENVS)
        self.assertNotEqual(set(), CODEX_ARCHES)

        for claim, text in (
            ("the Codex pin", CLAIMED_TAG_RE.findall(BUILD)),
            ("the overridable build args", CLAIMED_BUILD_ARGS_RE.findall(BUILD)),
            ("the supported architectures", CLAIMED_ARCHES_RE.findall(BUILD)),
            ("the Node version", CLAIMED_NODE_VERSION_RE.findall(BUILD)),
            ("the Claude Code pin", CLAIMED_CLAUDE_VERSION_RE.findall(BUILD)),
            ("RUNNER_HOME_PARENT", CLAIMED_HOME_PARENT_RE.findall(ENVIRONMENT)),
        ):
            with self.subTest(claim=claim):
                self.assertNotEqual([], text, f"runner/README.md no longer states {claim}")

    def test_claimed_pin_is_the_codex_tag_arg(self):
        claimed = CLAIMED_TAG_RE.findall(BUILD)
        declared = ARGS.get("CODEX_TAG")

        self.assertNotEqual([], claimed)
        self.assertEqual(
            [declared] * len(claimed),
            claimed,
            f"runner/README.md's Build section pins the Codex CLI at "
            f"{', '.join(claimed)}, but runner/Dockerfile declares "
            f"ARG CODEX_TAG={declared}",
        )

    def test_claimed_build_args_are_declared(self):
        claimed = [
            name
            for clause in CLAIMED_BUILD_ARGS_RE.findall(BUILD)
            for name in BACKTICKED_RE.findall(clause)
        ]
        self.assertNotEqual([], claimed)

        undeclared = sorted(name for name in claimed if name not in ARGS)

        self.assertEqual(
            [],
            undeclared,
            f"runner/README.md offers build args runner/Dockerfile does not "
            f"declare: {', '.join(undeclared)}; declared ARGs are "
            f"{', '.join(sorted(ARGS))}",
        )

    def test_claimed_architectures_are_the_codex_case_arms(self):
        claimed = {
            token
            for clause in CLAIMED_ARCHES_RE.findall(BUILD)
            for token in BACKTICKED_RE.findall(clause)
        }
        self.assertNotEqual(set(), claimed)

        self.assertEqual(
            sorted(CODEX_ARCHES),
            sorted(claimed),
            f"runner/README.md calls TARGETARCH {', '.join(sorted(claimed))} "
            f"supported, but runner/Dockerfile's Codex download handles "
            f"{', '.join(sorted(CODEX_ARCHES))}",
        )

    def test_claimed_node_version_is_the_node_version_arg(self):
        claimed = CLAIMED_NODE_VERSION_RE.findall(BUILD)
        declared = ARGS.get("NODE_VERSION")

        self.assertNotEqual([], claimed)
        self.assertEqual(
            [declared] * len(claimed),
            claimed,
            f"runner/README.md bundles Node.js {', '.join(claimed)}, but "
            f"runner/Dockerfile declares ARG NODE_VERSION={declared}",
        )

    def test_claimed_claude_version_is_the_claude_version_arg(self):
        claimed = CLAIMED_CLAUDE_VERSION_RE.findall(BUILD)
        declared = ARGS.get("CLAUDE_CODE_VERSION")

        self.assertNotEqual([], claimed)
        self.assertEqual(
            [declared] * len(claimed),
            claimed,
            f"runner/README.md bundles @anthropic-ai/claude-code@"
            f"{', '.join(claimed)}, but runner/Dockerfile declares "
            f"ARG CLAUDE_CODE_VERSION={declared}",
        )


class RunnerDockerfileFailsClosedTest(unittest.TestCase):
    """The image must not be able to build without both engine CLIs.

    `npm install -g @anthropic-ai/claude-code && claude --version || true` built
    green with no `claude` at all, and the runner then reported every valid
    Claude credential as broken. These rules are what stops that shape coming
    back, not a style preference.
    """

    def setUp(self):
        with open(DOCKERFILE_PATH, encoding="utf-8") as fh:
            self.text = fh.read()
        self.lines = _dockerfile_lines()

    def test_no_swallowed_failures(self):
        swallowed = [
            line
            for line in self.lines
            if "|| true" in line and not line.startswith("#")
        ]
        self.assertEqual(
            [],
            swallowed,
            "a `|| true` lets a failed install produce a green image",
        )

    def test_every_remote_download_is_checksum_verified(self):
        # One `curl -o` per downloaded archive, one `sha256sum -c` per archive.
        downloads = [line for line in self.lines if re.search(r"curl\b.*\s-o\s", line)]
        verifications = [line for line in self.lines if "sha256sum -c" in line]
        self.assertNotEqual([], downloads)
        self.assertEqual(
            len(downloads),
            len(verifications),
            f"{len(downloads)} downloads but {len(verifications)} sha256sum "
            f"checks: every fetched archive must be verified before it is unpacked",
        )

    def test_checksum_args_exist_for_both_architectures(self):
        for name in (
            "CODEX_SHA256_AMD64",
            "CODEX_SHA256_ARM64",
            "NODE_SHA256_AMD64",
            "NODE_SHA256_ARM64",
        ):
            with self.subTest(arg=name):
                value = ARGS.get(name)
                self.assertIsNotNone(value, f"runner/Dockerfile declares no ARG {name}")
                self.assertRegex(value, r"^[0-9a-f]{64}$")

    def test_both_cli_installs_assert_their_version(self):
        for engine, arg in (("codex", "CODEX_VERSION"), ("claude", "CLAUDE_CODE_VERSION")):
            with self.subTest(engine=engine):
                self.assertIn(arg, ARGS)
                self.assertIn(f'"${arg}"', self.text)

    def test_base_image_is_digest_pinned(self):
        froms = re.findall(r"^FROM\s+(\S+)", self.text, re.MULTILINE)
        self.assertNotEqual([], froms)
        images = [ARGS.get(ref[2:-1], ref) if ref.startswith("${") else ref for ref in froms]
        unpinned = [image for image in images if "@sha256:" not in image]
        self.assertEqual(
            [],
            unpinned,
            f"base images must be pinned by digest, not by tag: {unpinned}",
        )

    def test_required_engines_are_baked_in(self):
        self.assertEqual("codex,claude", ENVS.get("RUNNER_REQUIRED_ENGINES"))
        self.assertIn("RUNNER_CODEX_VERSION", ENVS)
        self.assertIn("RUNNER_CLAUDE_VERSION", ENVS)

    def test_claimed_home_parent_is_the_env(self):
        # The README states the baked-in value in the Environment section and
        # again in the per-route behavior notes; both are the same claim.
        with open(README_PATH, encoding="utf-8") as fh:
            claimed = set(CLAIMED_HOME_PARENT_RE.findall(fh.read()))
        declared = ENVS.get("RUNNER_HOME_PARENT")

        self.assertNotEqual(set(), claimed)
        self.assertNotEqual([], CLAIMED_HOME_PARENT_RE.findall(ENVIRONMENT))
        self.assertEqual(
            {declared},
            claimed,
            f"runner/README.md says the bundled image sets RUNNER_HOME_PARENT "
            f"to {', '.join(sorted(claimed))}, but runner/Dockerfile sets "
            f"ENV RUNNER_HOME_PARENT={declared}",
        )
