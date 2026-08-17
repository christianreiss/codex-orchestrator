"""Which engine CLIs this image actually carries, and at which version.

The runner used to answer `/health` with `shutil.which(...) is not None` per
engine. That is a claim about a filename, not about a working CLI, and the
image that produced it installed Claude Code with a trailing `|| true` — so a
registry hiccup at build time shipped an image whose `/health` reported a
dual-engine runner with no `claude` on it at all.

This module owns the honest answer instead: resolve the binary, ask it for its
version, compare that against the version the image was built with, and refuse
to start when a required engine is missing. `RUNNER_REQUIRED_ENGINES` names the
engines that must be present; the bundled image sets it to `codex,claude`.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Optional

ENGINE_CODEX = "codex"
ENGINE_CLAUDE = "claude"
ENGINES: tuple[str, ...] = (ENGINE_CODEX, ENGINE_CLAUDE)

#: `codex --version` prints `codex-cli 0.144.1`; `claude --version` prints
#: `2.1.233 (Claude Code)`. Both reduce to the first dotted number in the line.
_VERSION_RE = re.compile(r"\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?")

_VERSION_TIMEOUT_SECONDS = 5.0

#: Environment variable holding the version each engine was installed at.
_EXPECTED_VERSION_ENV = {
    ENGINE_CODEX: "RUNNER_CODEX_VERSION",
    ENGINE_CLAUDE: "RUNNER_CLAUDE_VERSION",
}


class RunnerStartupError(RuntimeError):
    """A configured engine is unusable, so the process must not serve traffic."""


@dataclass(frozen=True)
class EngineRuntime:
    """What one engine CLI is, right now, in this container."""

    engine: str
    binary: Optional[str]
    version: Optional[str]
    expected_version: Optional[str]
    detail: str

    @property
    def available(self) -> bool:
        return self.binary is not None and self.version is not None

    @property
    def version_matches(self) -> bool:
        """True when the CLI reports the version the image was built with.

        An image with no recorded expectation cannot contradict itself, so it
        counts as matching — the check exists to catch drift, not to demand
        that every deployment bake the variable in.
        """
        if self.expected_version is None or self.version is None:
            return True
        return self.version == self.expected_version

    def as_payload(self) -> dict:
        return {
            "available": self.available,
            "binary": self.binary,
            "version": self.version,
            "expected_version": self.expected_version,
            "version_matches": self.version_matches,
            "detail": self.detail,
        }


def parse_version(output: str) -> Optional[str]:
    """The first dotted version in a CLI's `--version` output, or None."""
    match = _VERSION_RE.search(output or "")
    return match.group(0) if match else None


def required_engines(environ: Optional[Mapping[str, str]] = None) -> tuple[str, ...]:
    """Engines this deployment insists on, in declaration order.

    Unset means "whatever is installed is fine", which is the right default for
    a source checkout run outside the image. The image itself sets the variable,
    so a production runner always fails closed.
    """
    env = os.environ if environ is None else environ
    raw = (env.get("RUNNER_REQUIRED_ENGINES") or "").strip()
    if not raw:
        return ()
    names = [part.strip().lower() for part in raw.split(",") if part.strip()]
    unknown = sorted({name for name in names if name not in ENGINES})
    if unknown:
        raise RunnerStartupError(
            f"RUNNER_REQUIRED_ENGINES names unknown engines: {', '.join(unknown)}"
        )
    seen: list[str] = []
    for name in names:
        if name not in seen:
            seen.append(name)
    return tuple(seen)


def probe_engine(
    engine: str,
    environ: Optional[Mapping[str, str]] = None,
    *,
    which: Callable[[str], Optional[str]] = shutil.which,
    run: Optional[Callable[..., subprocess.CompletedProcess]] = None,
) -> EngineRuntime:
    """Resolve one engine's binary and ask it for its version."""
    if engine not in ENGINES:
        raise ValueError(f"unknown engine: {engine}")
    env = os.environ if environ is None else environ
    expected = (env.get(_EXPECTED_VERSION_ENV[engine]) or "").strip() or None

    binary = which(engine)
    if binary is None:
        return EngineRuntime(engine, None, None, expected, "not installed")

    runner = run or subprocess.run
    try:
        proc = runner(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=_VERSION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return EngineRuntime(engine, binary, None, expected, "version check timed out")
    except OSError as exc:
        return EngineRuntime(engine, binary, None, expected, f"not executable: {exc.strerror}")

    if proc.returncode != 0:
        return EngineRuntime(
            engine, binary, None, expected, f"--version exited {proc.returncode}"
        )

    version = parse_version(f"{proc.stdout or ''}\n{proc.stderr or ''}")
    if version is None:
        return EngineRuntime(engine, binary, None, expected, "--version printed no version")

    if expected is not None and version != expected:
        return EngineRuntime(
            engine,
            binary,
            version,
            expected,
            f"installed {version}, image was built with {expected}",
        )
    return EngineRuntime(engine, binary, version, expected, "ready")


def runtime_snapshot(
    environ: Optional[Mapping[str, str]] = None,
    *,
    engines: Iterable[str] = ENGINES,
    which: Callable[[str], Optional[str]] = shutil.which,
    run: Optional[Callable[..., subprocess.CompletedProcess]] = None,
) -> dict[str, EngineRuntime]:
    return {
        engine: probe_engine(engine, environ, which=which, run=run) for engine in engines
    }


def readiness_problems(
    snapshot: Mapping[str, EngineRuntime],
    required: Iterable[str],
) -> list[str]:
    """Human-readable reasons this runner is not ready, empty when it is."""
    problems: list[str] = []
    for engine in required:
        state = snapshot.get(engine)
        if state is None:
            problems.append(f"{engine}: not probed")
        elif not state.available:
            problems.append(f"{engine}: {state.detail}")
        elif not state.version_matches:
            problems.append(f"{engine}: {state.detail}")
    return problems


def readiness_payload(
    snapshot: Mapping[str, EngineRuntime],
    required: Iterable[str],
) -> dict:
    """The `/health` body: what is installed, what is demanded, and the verdict."""
    required = tuple(required)
    problems = readiness_problems(snapshot, required)
    return {
        "status": "ok" if not problems else "degraded",
        "required_engines": list(required),
        "engines": {engine: state.as_payload() for engine, state in snapshot.items()},
        "problems": problems,
    }


def assert_required_engines(
    snapshot: Mapping[str, EngineRuntime],
    required: Iterable[str],
) -> None:
    """Raise unless every required engine is installed at the expected version."""
    problems = readiness_problems(snapshot, required)
    if problems:
        raise RunnerStartupError(
            "runner cannot start; required engines unavailable -> " + "; ".join(problems)
        )
