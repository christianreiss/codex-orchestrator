#!/usr/bin/env python3
"""Autonomous AI spawner for codex-orchestrator study.

Cyclically spawns AI agents with task-specific prompts.
TUI with status panel, scrollable log, and interactive command bar.
"""

import argparse
import curses
import datetime
from dataclasses import dataclass, field
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(REPO_ROOT, ".spawner-state.json")
SUMMARY_START = "===SPAWNER_SUMMARY_START==="
SUMMARY_END = "===SPAWNER_SUMMARY_END==="

ENGINE_CLAUDE = "claude"
ENGINE_CODEX = "codex"


@dataclass
class CodexExecOptions:
    """Spawner-supported passthrough options for `codex exec`.

    Keep this list aligned with `codex exec --help`, not the interactive
    top-level `codex --help` surface. Flags like `--search`, `--remote`, and
    `--no-alt-screen` are intentionally excluded because they are not accepted
    by `codex exec`.
    """

    config_overrides: list[str] = field(default_factory=list)
    enable_features: list[str] = field(default_factory=list)
    disable_features: list[str] = field(default_factory=list)
    images: list[str] = field(default_factory=list)
    oss: bool = False
    local_provider: str | None = None
    sandbox_mode: str | None = None
    profile: str | None = None
    full_auto: bool = False
    bypass_approvals_and_sandbox: bool = True
    add_dirs: list[str] = field(default_factory=list)
    ephemeral: bool = False
    output_schema: str | None = None
    color: str | None = None
    progress_cursor: bool = False
    json_output: bool = False


# ---------------------------------------------------------------------------
# Prompt definitions
# ---------------------------------------------------------------------------
PREAMBLE = """\
You are an autonomous AI developer working on the codex-orchestrator project.
This is a PHP/MySQL fleet management system for OpenAI Codex with a Vue.js admin dashboard.

IMPORTANT FILES:
- AGENTS.md: coding guidelines, voice rules, process guardrails -- READ THIS FIRST
- src/: PHP backend (Controllers, Services, Repositories, Security, Migrations)
- public/admin/: Vue.js admin dashboard (HTML + vanilla JS + CSS)
- public/admin/assets/theme.css: design tokens and font declarations
- public/admin/assets/dashboard.css: dashboard styles
- public/admin/assets/dashboard.js: main dashboard logic
- public/admin/assets/nav.js: navigation controller
- public/admin/index.html: dashboard shell with editorial-rail navigation
- bin/cdx: main CLI wrapper (bash, built from bin/cdx.d/ fragments via scripts/build-cdx.sh)
- bin/cdx.d/: wrapper source fragments -- edit these, NOT bin/cdx directly
- tests/: PHPUnit tests
- CHANGELOG.md: changelog (newest date first, grouped under # YYYY-MM-DD headers)

RULES:
1. Read AGENTS.md before making any changes.
2. Make REAL, TANGIBLE improvements -- not trivial whitespace or comment changes.
3. Do NOT push to any remote. Only commit locally.
4. Update CHANGELOG.md if your change is user-visible.
5. If you change bin/cdx.d/ fragments, rebuild via: bash scripts/build-cdx.sh
6. Run existing tests if relevant: vendor/bin/phpunit
7. Do NOT break existing functionality.
8. Commit all your changes with a descriptive commit message.

When you are completely finished, output your summary in EXACTLY this format:
===SPAWNER_SUMMARY_START===
A 2-4 sentence summary of what you changed and why.
===SPAWNER_SUMMARY_END===
"""

TASKS = [
    {
        "name": "UX/UI Visual Polish",
        "prompt": PREAMBLE + """
TASK: UX/UI Visual Polish

Focus on the admin dashboard visual presentation. Look at:
- public/admin/assets/theme.css (design tokens, colors, typography)
- public/admin/assets/dashboard.css (layout, spacing, component styles)
- public/admin/assets/dashboard-mobile.css (mobile responsive styles)
- public/admin/index.html (HTML structure, semantic markup)
- public/admin/assets/nav.js (navigation behavior)
- public/admin/login.html (login page)

Pick ONE or TWO of these improvements to implement:
- Refine color palette, contrast ratios, or dark/light theme variables
- Improve typography hierarchy (font sizes, weights, line heights)
- Polish component borders, shadows, border-radius consistency
- Improve spacing rhythm and visual alignment
- Enhance transition/animation smoothness on interactive elements
- Improve mobile responsiveness for a specific component
- Tighten visual consistency between login page and dashboard

DO NOT change any JavaScript functionality or PHP backend logic.
Make your changes surgical and focused. Quality over quantity.
Commit with a message starting with "ui: ".
""",
    },
    {
        "name": "UX/UI Functional Improvement",
        "prompt": PREAMBLE + """
TASK: UX/UI Functional Improvement

Focus on the admin dashboard user experience and interactivity. Look at:
- public/admin/assets/dashboard.js (main dashboard logic)
- public/admin/assets/nav.js (navigation)
- public/admin/assets/logs.js (log viewer)
- public/admin/assets/users.js (user management)
- public/admin/assets/config.js (config UI)
- public/admin/assets/account.js (account management)
- public/admin/assets/profiles.js (profiles UI)
- public/admin/index.html (HTML structure)

Pick ONE of these improvements to implement:
- Add keyboard shortcuts for common actions (navigation, refresh, search)
- Improve table sorting, filtering, or search UX in any list view
- Add better loading states or skeleton screens for async data
- Improve error message display and user feedback
- Add confirmation dialogs where destructive actions lack them
- Improve form validation feedback
- Add useful tooltips or contextual help text
- Enhance accessibility (ARIA labels, focus management, screen reader support)

DO NOT change PHP backend logic or API contracts.
Make your changes surgical and focused. Test in browser if possible.
Commit with a message starting with "ux: ".
""",
    },
    {
        "name": "UX Optical Polish",
        "prompt": PREAMBLE + """
TASK: UX Optical Polish

You just made a functional UX improvement. Now step back and visually polish
the result. Look at the ENTIRE admin dashboard with fresh eyes and find rough
edges in the UI that were introduced or exposed by recent changes.

Inspect these files carefully:
- public/admin/assets/dashboard.css (component styles)
- public/admin/assets/theme.css (design tokens)
- public/admin/assets/dashboard-mobile.css (responsive breakpoints)
- public/admin/index.html (markup structure, class usage)
- public/admin/login.html (login page consistency)
- Any other CSS/HTML files under public/admin/

Focus on ONE or TWO of these optical refinements:
- Fix misaligned elements, inconsistent padding/margin between sibling components
- Correct color or contrast issues (text on background readability)
- Smooth out jarring transitions or missing hover/focus states
- Ensure icon sizes, badge sizes, and label spacing are visually balanced
- Fix clipped text, overflow issues, or truncation without ellipsis
- Tighten border-radius, shadow depth, or divider consistency across cards/panels
- Ensure the responsive layout doesn't break at common breakpoints (768px, 1024px)
- Polish empty states, placeholder text, or zero-data views

This is purely visual -- do NOT change JavaScript behavior or PHP backend logic.
Your commit message should start with "polish: ".
""",
    },
    {
        "name": "cdx Wrapper Improvement",
        "prompt": PREAMBLE + """
TASK: cdx Wrapper Improvement

Focus on the cdx CLI wrapper. IMPORTANT: The wrapper is built from fragments.
- Read bin/cdx.d/ directory structure to understand the fragment system
- Edit files in bin/cdx.d/, NOT bin/cdx directly
- After changes, rebuild: bash scripts/build-cdx.sh

Look at the fragments and pick ONE improvement:
- Improve output formatting (colors, alignment, whitespace in status/summary output)
- Add better error messages for common failure modes
- Improve the --doctor or --status output readability
- Tighten input validation or edge case handling
- Improve the run summary display
- Polish the banner or version display sections
- Add a missing help text or usage hint

Keep changes backward-compatible. Do not change API contracts or auth flow logic.
Run the build script after editing fragments.
Commit with a message starting with "cdx: ".
""",
    },
    {
        "name": "Backend Optimization",
        "prompt": PREAMBLE + """
TASK: Backend Optimization

Focus on PHP backend code quality and performance. Look at:
- src/Services/ (business logic)
- src/Repositories/ (database queries)
- src/Http/Controllers/ (route handlers)
- src/Http/ (helpers, middleware-like code)
- src/Security/ (rate limiting, encryption)
- public/index.php (router and bootstrapping)

Pick ONE of these improvements to implement:
- Reduce code duplication in a service or repository
- Improve error handling (catch specific exceptions, add context)
- Add type declarations (parameter types, return types, property types)
- Optimize a database query (add index hints, reduce N+1 patterns)
- Extract a method or class to improve single-responsibility
- Improve input validation or sanitization
- Tighten a security check or add a missing guard

DO NOT change API response shapes or database schema.
DO NOT break existing tests. Run: vendor/bin/phpunit
Commit with a message starting with "backend: ".
""",
    },
    {
        "name": "General Improvement",
        "prompt": PREAMBLE + """
TASK: General Improvement

You have freedom to improve ANY part of the codebase. Survey the project and find
something genuinely useful to improve. Some ideas:
- Documentation improvements (docs/, README.md, inline docs)
- Test coverage (add a missing test in tests/)
- Configuration improvements
- Code organization or cleanup
- Developer experience improvements
- Fix a TODO or FIXME comment in the codebase
- Improve logging or observability

Read AGENTS.md and CHANGELOG.md first to understand recent changes and conventions.
Pick something that adds real value. Avoid trivial changes.
Commit with a message starting with "improve: ".
""",
    },
    {
        "name": "Debug and Harden",
        "prompt": PREAMBLE + """
TASK: Debug and Harden

Hunt for bugs, edge cases, and reliability issues. Look at:
- Recent CHANGELOG.md entries for areas that changed recently (likely to have bugs)
- Error handling paths in src/Services/ and src/Http/Controllers/
- Edge cases in src/Security/ (rate limiting, encryption)
- Input validation gaps in route handlers
- Potential null/undefined issues in admin JS (public/admin/assets/)
- Shell script edge cases in bin/cdx.d/

Approach:
1. Read CHANGELOG.md to see what changed recently
2. Look at those areas for potential issues
3. Fix at least one real bug or harden one fragile code path
4. If you find no bugs, add defensive checks or improve error handling

If you change admin JS, update the cache-bust query param on the script tag in index.html.
If you change cdx fragments, rebuild via: bash scripts/build-cdx.sh
Run tests: vendor/bin/phpunit
Commit with a message starting with "fix: " or "harden: ".
""",
    },
]


# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------
def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"cycle": 1, "task_index": 0}


def save_state(cycle: int, task_index: int) -> None:
    try:
        with open(STATE_FILE, "w") as f:
            json.dump({"cycle": cycle, "task_index": task_index}, f)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Fatal error detection
# ---------------------------------------------------------------------------
FATAL_PATTERNS = [
    ("rate limit", "Rate limit reached"),
    ("rate_limit", "Rate limit reached"),
    ("too many requests", "Rate limit reached"),
    ("429", "HTTP 429 -- rate limit reached"),
    ("quota exceeded", "API quota exceeded"),
    ("quota_exceeded", "API quota exceeded"),
    ("billing", "Billing issue"),
    ("insufficient_quota", "API quota exhausted"),
    ("overloaded", "API overloaded"),
    ("api_error", "API error"),
    ("authentication", "Authentication failure"),
    ("invalid_api_key", "Invalid API key"),
    ("unauthorized", "Authentication failure"),
    ("could not connect", "Connection failure"),
    ("network error", "Network error"),
    ("ECONNREFUSED", "Connection refused"),
    ("context window", "Context window exceeded"),
    ("max.*token", "Token limit exceeded"),
]


def check_fatal(stdout: str, stderr: str) -> str | None:
    combined = (stdout + "\n" + stderr).lower()
    for pattern, reason in FATAL_PATTERNS:
        if pattern.lower() in combined:
            return reason
    return None


# ---------------------------------------------------------------------------
# Summary parsing
# ---------------------------------------------------------------------------
def parse_summary(stdout: str) -> str:
    start = stdout.find(SUMMARY_START)
    end = stdout.find(SUMMARY_END)
    if start != -1 and end != -1:
        return stdout[start + len(SUMMARY_START):end].strip()
    return stdout[-500:].strip() if stdout else "(no output)"


# ---------------------------------------------------------------------------
# File logging
# ---------------------------------------------------------------------------
def format_duration(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m}m {s}s" if m > 0 else f"{s}s"


def log_to_file(log_file: str, cycle: int, task_num: int, task_name: str,
                status: str, duration: float, summary: str, error: str = "") -> None:
    dur_str = format_duration(duration)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = (
        f"{'=' * 80}\n"
        f"Cycle {cycle} | Task {task_num}/{len(TASKS)}: {task_name}\n"
        f"Time: {now}\n"
        f"Status: {status}\n"
        f"Duration: {dur_str}\n"
        f"{'-' * 80}\n"
    )
    if "SUCCESS" in status:
        entry += f"Summary:\n{summary}\n"
    else:
        if error:
            entry += f"Error:\n{error[:1000]}\n{'-' * 80}\n"
        entry += f"Output (last 500 chars):\n{summary}\n"
    entry += f"{'=' * 80}\n\n"
    try:
        with open(log_file, "a") as f:
            f.write(entry)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Shared TUI state
# ---------------------------------------------------------------------------
class SpawnerState:
    """Thread-safe shared state between the worker and the TUI."""

    def __init__(self, engine: str, model: str, timeout: int, log_file: str,
                 cycle: int, task_index: int, dry_run: bool, once: bool,
                 codex_exec_options: CodexExecOptions | None = None):
        self.lock = threading.Lock()
        self.engine = engine
        self.model = model
        self.timeout = timeout
        self.log_file = log_file
        self.cycle = cycle
        self.task_index = task_index
        self.dry_run = dry_run
        self.once = once
        self.codex_exec_options = codex_exec_options or CodexExecOptions()

        # Runtime state
        self.running = True           # main loop alive
        self.task_running = False     # a task is currently executing
        self.current_task_name = ""
        self.task_start_time = 0.0
        self.completed = 0
        self.failed = 0
        self.total_time = 0.0

        # Control signals
        self.stop_now = False         # kill current task and exit
        self.stop_after = False       # finish current task then exit
        self.pending_engine: str | None = None   # switch after current task
        self.pending_model: str | None = None

        # Current subprocess (for kill)
        self.process: subprocess.Popen | None = None

        # Log lines for TUI display
        self.log_lines: list[tuple[str, int]] = []  # (text, color_pair)

        # Status message (transient feedback from commands)
        self.status_msg = ""
        self.status_time = 0.0

        # Fatal error
        self.fatal_msg = ""

    def add_log(self, text: str, color: int = 0) -> None:
        with self.lock:
            self.log_lines.append((text, color))

    def set_status(self, msg: str) -> None:
        with self.lock:
            self.status_msg = msg
            self.status_time = time.time()

    def get_status(self) -> str:
        with self.lock:
            if self.status_msg and time.time() - self.status_time < 5:
                return self.status_msg
            return ""


# ---------------------------------------------------------------------------
# Color pair IDs for curses
# ---------------------------------------------------------------------------
CP_NORMAL = 0
CP_HEADER = 1
CP_SUCCESS = 2
CP_ERROR = 3
CP_WARNING = 4
CP_DIM = 5
CP_ACCENT = 6
CP_CMD = 7
CP_STATUS_BG = 8


def init_colors() -> None:
    curses.start_color()
    curses.use_default_colors()
    curses.init_pair(CP_HEADER, curses.COLOR_CYAN, -1)
    curses.init_pair(CP_SUCCESS, curses.COLOR_GREEN, -1)
    curses.init_pair(CP_ERROR, curses.COLOR_RED, -1)
    curses.init_pair(CP_WARNING, curses.COLOR_YELLOW, -1)
    curses.init_pair(CP_DIM, curses.COLOR_WHITE, -1)
    curses.init_pair(CP_ACCENT, curses.COLOR_MAGENTA, -1)
    curses.init_pair(CP_CMD, curses.COLOR_CYAN, -1)
    curses.init_pair(CP_STATUS_BG, curses.COLOR_BLACK, curses.COLOR_CYAN)


def build_codex_exec_command(
    model: str,
    prompt: str,
    output_file: str,
    options: CodexExecOptions,
) -> list[str]:
    """Build a `codex exec` command using only flags supported by exec mode."""

    cmd = ["codex", "exec"]

    for item in options.config_overrides:
        cmd.extend(["--config", item])
    for item in options.enable_features:
        cmd.extend(["--enable", item])
    for item in options.disable_features:
        cmd.extend(["--disable", item])
    for item in options.images:
        cmd.extend(["--image", item])

    if options.oss:
        cmd.append("--oss")
    if options.local_provider:
        cmd.extend(["--local-provider", options.local_provider])

    cmd.extend(["--model", model, "-C", REPO_ROOT])

    if options.profile:
        cmd.extend(["--profile", options.profile])

    # Preserve the historical low-friction default, but let callers turn it off.
    if options.bypass_approvals_and_sandbox:
        cmd.append("--dangerously-bypass-approvals-and-sandbox")
    else:
        if options.full_auto:
            cmd.append("--full-auto")
        if options.sandbox_mode:
            cmd.extend(["--sandbox", options.sandbox_mode])

    for item in options.add_dirs:
        cmd.extend(["--add-dir", item])

    if options.ephemeral:
        cmd.append("--ephemeral")
    if options.output_schema:
        cmd.extend(["--output-schema", options.output_schema])
    if options.color:
        cmd.extend(["--color", options.color])
    if options.progress_cursor:
        cmd.append("--progress-cursor")
    if options.json_output:
        cmd.append("--json")

    cmd.extend(["-o", output_file, prompt])
    return cmd


# ---------------------------------------------------------------------------
# Task execution (runs in worker thread)
# ---------------------------------------------------------------------------
def run_task_worker(state: SpawnerState, task: dict) -> dict:
    """Run a single AI agent. Checks state.stop_now for early abort."""
    output_file = None
    engine = state.engine
    model = state.model

    if engine == ENGINE_CODEX:
        output_file = tempfile.NamedTemporaryFile(
            prefix="spawner-", suffix=".txt", delete=False, dir=REPO_ROOT)
        output_file.close()
        cmd = build_codex_exec_command(
            model=model,
            prompt=task["prompt"],
            output_file=output_file.name,
            options=state.codex_exec_options,
        )
    else:
        cmd = [
            "claude", "--dangerously-skip-permissions",
            "-p", "--model", model,
            task["prompt"],
        ]

    start_time = time.time()
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=REPO_ROOT,
        )
        with state.lock:
            state.process = proc

        # Poll so we can react to stop_now
        while proc.poll() is None:
            if state.stop_now:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                duration = time.time() - start_time
                return {"status": "KILLED", "summary": "(killed by user)",
                        "duration": duration, "error": "", "fatal": False}
            if time.time() - start_time > state.timeout:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                duration = time.time() - start_time
                return {"status": "TIMEOUT", "summary": "(timed out)",
                        "duration": duration,
                        "error": f"Process killed after {state.timeout}s",
                        "fatal": False}
            time.sleep(0.5)

        duration = time.time() - start_time
        stdout = proc.stdout.read() if proc.stdout else ""
        stderr = proc.stderr.read() if proc.stderr else ""

        # For codex, prefer the -o output file
        if engine == ENGINE_CODEX and output_file:
            try:
                with open(output_file.name) as f:
                    agent_out = f.read()
                if agent_out.strip():
                    stdout = agent_out
            except OSError:
                pass

        summary = parse_summary(stdout)
        fatal_reason = check_fatal(stdout, stderr)

        if proc.returncode == 0 and not fatal_reason:
            return {"status": "SUCCESS", "summary": summary,
                    "duration": duration, "error": "", "fatal": False}
        else:
            status = (f"FATAL: {fatal_reason}" if fatal_reason
                      else f"FAILED (exit code {proc.returncode})")
            return {"status": status, "summary": summary,
                    "duration": duration, "error": stderr[-1000:],
                    "fatal": bool(fatal_reason)}
    except FileNotFoundError:
        duration = time.time() - start_time
        return {"status": f"FATAL: '{engine}' binary not found",
                "summary": "", "duration": duration,
                "error": f"'{engine}' not in PATH", "fatal": True}
    finally:
        with state.lock:
            state.process = None
        if output_file:
            try:
                os.unlink(output_file.name)
            except OSError:
                pass


def worker_loop(state: SpawnerState) -> None:
    """Background thread: runs tasks in cycle."""
    while state.running and not state.stop_now:
        task = TASKS[state.task_index]
        task_num = state.task_index + 1
        total = len(TASKS)
        now_str = datetime.datetime.now().strftime("%H:%M:%S")

        with state.lock:
            state.task_running = True
            state.current_task_name = task["name"]
            state.task_start_time = time.time()

        state.add_log(f"", CP_NORMAL)
        state.add_log(
            f"{now_str}  Cycle {state.cycle} | Task {task_num}/{total}: {task['name']}",
            CP_HEADER)
        state.add_log(
            f"         Engine: {state.engine}  Model: {state.model}",
            CP_DIM)

        if state.dry_run:
            result = {"status": "DRY_RUN", "summary": "(dry run)",
                      "duration": 0.0, "error": "", "fatal": False}
        else:
            result = run_task_worker(state, task)

        dur = format_duration(result["duration"])
        status = result["status"]

        # Log to TUI
        if "SUCCESS" in status:
            state.add_log(f"         -> {status} ({dur})", CP_SUCCESS)
            with state.lock:
                state.completed += 1
        elif status == "KILLED":
            state.add_log(f"         -> KILLED ({dur})", CP_WARNING)
        else:
            state.add_log(f"         -> {status} ({dur})", CP_ERROR)
            with state.lock:
                state.failed += 1

        # Summary lines
        for line in result["summary"].split("\n"):
            trimmed = line.strip()
            if trimmed:
                state.add_log(f"         {trimmed}", CP_DIM)

        with state.lock:
            state.total_time += result["duration"]
            state.task_running = False

        # Log to file
        log_to_file(state.log_file, state.cycle, task_num, task["name"],
                    status, result["duration"], result["summary"],
                    result.get("error", ""))

        # Fatal -> stop
        if result.get("fatal"):
            with state.lock:
                state.fatal_msg = status
                state.running = False
            save_state(state.cycle, state.task_index)
            return

        # Killed -> stop
        if status == "KILLED" or state.stop_now:
            save_state(state.cycle, state.task_index)
            with state.lock:
                state.running = False
            return

        # Stop after task
        if state.stop_after:
            state.add_log("         Stopping after task (user request).", CP_WARNING)
            # Advance first so resume picks up the next task
            state.task_index = (state.task_index + 1) % total
            if state.task_index == 0:
                state.cycle += 1
            save_state(state.cycle, state.task_index)
            with state.lock:
                state.running = False
            return

        # Apply pending engine/model switch
        with state.lock:
            if state.pending_engine:
                state.engine = state.pending_engine
                state.pending_engine = None
                state.add_log(f"         >> Engine switched to: {state.engine}", CP_ACCENT)
            if state.pending_model:
                state.model = state.pending_model
                state.pending_model = None
                state.add_log(f"         >> Model switched to: {state.model}", CP_ACCENT)

        # Advance
        state.task_index = (state.task_index + 1) % total
        if state.task_index == 0:
            state.cycle += 1
        save_state(state.cycle, state.task_index)

        # --once mode
        if state.once:
            with state.lock:
                state.running = False
            return

    # End of loop
    with state.lock:
        state.running = False


# ---------------------------------------------------------------------------
# TUI drawing
# ---------------------------------------------------------------------------
def draw_status_panel(stdscr, state: SpawnerState, height: int, width: int) -> None:
    """Draw the top status panel (5 lines)."""
    # Line 0: title bar
    title = " AI Spawner | codex-orchestrator "
    pad = width - len(title)
    lp = pad // 2
    rp = pad - lp
    try:
        stdscr.addnstr(0, 0, " " * lp + title + " " * rp, width,
                       curses.color_pair(CP_STATUS_BG) | curses.A_BOLD)
    except curses.error:
        pass

    # Line 1: engine / model / timeout
    info = f" Engine: {state.engine}  |  Model: {state.model}  |  Timeout: {state.timeout}s"
    try:
        stdscr.addnstr(1, 0, info.ljust(width), width,
                       curses.color_pair(CP_HEADER))
    except curses.error:
        pass

    # Line 2: cycle / task
    with state.lock:
        c = state.cycle
        ti = state.task_index
        tname = state.current_task_name or TASKS[ti]["name"]
    task_info = f" Cycle: {c}  Task: {ti + 1}/{len(TASKS)}  {tname}"
    try:
        stdscr.addnstr(2, 0, task_info.ljust(width), width,
                       curses.color_pair(CP_NORMAL) | curses.A_BOLD)
    except curses.error:
        pass

    # Line 3: status + flags
    with state.lock:
        running = state.task_running
        start_t = state.task_start_time
        completed = state.completed
        failed = state.failed
        total_t = state.total_time
        stop_af = state.stop_after
        p_eng = state.pending_engine
        p_mod = state.pending_model
        fatal = state.fatal_msg
        alive = state.running

    if fatal:
        status_text = f"FATAL: {fatal}"
        scolor = CP_ERROR
    elif not alive:
        status_text = "STOPPED"
        scolor = CP_WARNING
    elif running:
        elapsed = format_duration(time.time() - start_t) if start_t else "0s"
        status_text = f"RUNNING ({elapsed})"
        scolor = CP_SUCCESS
    else:
        status_text = "IDLE"
        scolor = CP_DIM

    flags = []
    if stop_af:
        flags.append("stop-after-task")
    if p_eng:
        flags.append(f"next-engine:{p_eng}")
    if p_mod:
        flags.append(f"next-model:{p_mod}")

    line3 = f" Status: {status_text}"
    if flags:
        line3 += "  |  " + "  ".join(flags)
    try:
        stdscr.addnstr(3, 0, line3.ljust(width), width, curses.color_pair(scolor))
    except curses.error:
        pass

    # Line 4: stats + status message
    stats = f" Done: {completed}  Failed: {failed}  Total: {format_duration(total_t)}"
    smsg = state.get_status()
    if smsg:
        stats += f"  |  {smsg}"
    try:
        stdscr.addnstr(4, 0, stats.ljust(width), width, curses.color_pair(CP_DIM))
    except curses.error:
        pass


def draw_log_panel(stdscr, state: SpawnerState, y_start: int,
                   height: int, width: int, scroll_offset: int) -> int:
    """Draw the scrollable log panel. Returns total log line count."""
    # Border line
    try:
        stdscr.addnstr(y_start, 0, ("=" * width)[:width], width,
                       curses.color_pair(CP_DIM))
    except curses.error:
        pass

    log_area_start = y_start + 1
    log_area_height = height

    with state.lock:
        lines = list(state.log_lines)

    total = len(lines)

    # Wrap long lines to fit width
    wrapped: list[tuple[str, int]] = []
    for text, color in lines:
        if len(text) <= width - 1:
            wrapped.append((text, color))
        else:
            for wl in textwrap.wrap(text, width - 1):
                wrapped.append((wl, color))

    total_wrapped = len(wrapped)

    # Auto-scroll: if user hasn't scrolled up, show bottom
    visible = log_area_height
    if scroll_offset == 0:
        start_idx = max(0, total_wrapped - visible)
    else:
        start_idx = max(0, total_wrapped - visible - scroll_offset)

    for i in range(visible):
        li = start_idx + i
        row = log_area_start + i
        if li < total_wrapped:
            text, color = wrapped[li]
            try:
                stdscr.addnstr(row, 0, text.ljust(width)[:width], width,
                               curses.color_pair(color))
            except curses.error:
                pass
        else:
            try:
                stdscr.addnstr(row, 0, " " * width, width)
            except curses.error:
                pass

    return total_wrapped


def draw_command_bar(stdscr, state: SpawnerState, y: int, width: int,
                     cmd_buf: str, help_mode: bool) -> int:
    """Draw the bottom command bar. Returns number of lines used.

    Layout (help_mode=True, 4 lines):
      help line 1
      help line 2
      engine/model bar
      > input

    Layout (help_mode=False, 2 lines):
      engine/model bar
      > input
    """
    lines_used = 0
    row = y

    if help_mode:
        help1 = " q = quit now    s = stop after task    c = cancel pending"
        help2 = " e <engine>      m <model>              ? = close help"
        try:
            stdscr.addnstr(row, 0, help1.ljust(width)[:width], width,
                           curses.color_pair(CP_CMD) | curses.A_DIM)
        except curses.error:
            pass
        row += 1
        try:
            stdscr.addnstr(row, 0, help2.ljust(width)[:width], width,
                           curses.color_pair(CP_CMD) | curses.A_DIM)
        except curses.error:
            pass
        row += 1
        lines_used += 2

    # Engine/model bar — always visible
    with state.lock:
        eng = state.engine
        mod = state.model
    bar = f" [{eng}:{mod}]  q:quit  s:stop-after  k:kill  e:engine  m:model  ?:help"
    try:
        stdscr.addnstr(row, 0, bar.ljust(width)[:width], width,
                       curses.color_pair(CP_CMD) | curses.A_DIM)
    except curses.error:
        pass
    row += 1
    lines_used += 1

    # Input line
    prompt = f" > {cmd_buf}"
    try:
        stdscr.addnstr(row, 0, prompt.ljust(width)[:width], width,
                       curses.color_pair(CP_CMD) | curses.A_BOLD)
    except curses.error:
        pass
    lines_used += 1

    return lines_used


# ---------------------------------------------------------------------------
# Command processing
# ---------------------------------------------------------------------------
def process_command(cmd: str, state: SpawnerState) -> None:
    """Process a typed command."""
    parts = cmd.strip().split(None, 1)
    if not parts:
        return
    verb = parts[0].lower()
    arg = parts[1].strip() if len(parts) > 1 else ""

    if verb in ("q", "quit"):
        with state.lock:
            state.stop_now = True
            if state.process:
                state.process.terminate()
        state.set_status("Quitting...")

    elif verb in ("k", "kill"):
        with state.lock:
            state.stop_now = True
            if state.process:
                state.process.terminate()
        state.set_status("Killing current task...")

    elif verb in ("s", "stop"):
        with state.lock:
            state.stop_after = True
        state.set_status("Will stop after current task finishes.")

    elif verb in ("c", "cancel"):
        with state.lock:
            state.stop_after = False
            state.pending_engine = None
            state.pending_model = None
        state.set_status("Cancelled pending actions.")

    elif verb in ("e", "engine"):
        if arg in ("claude", "codex"):
            if arg == state.engine:
                state.set_status(f"Already using {arg}.")
            else:
                with state.lock:
                    state.pending_engine = arg
                    # Set default model for new engine if no pending model
                    if not state.pending_model:
                        state.pending_model = (
                            "o4-mini" if arg == "codex" else "sonnet")
                state.set_status(
                    f"Will switch to {arg} after current task.")
        else:
            state.set_status("Usage: e claude | e codex")

    elif verb in ("m", "model"):
        if arg:
            with state.lock:
                state.pending_model = arg
            state.set_status(f"Will switch model to {arg} after current task.")
        else:
            state.set_status("Usage: m <model-name>")

    else:
        state.set_status(f"Unknown command: {verb}")


# ---------------------------------------------------------------------------
# Curses main (TUI event loop)
# ---------------------------------------------------------------------------
def tui_main(stdscr, state: SpawnerState) -> None:
    curses.curs_set(0)
    stdscr.nodelay(True)
    stdscr.timeout(500)  # refresh every 500ms
    init_colors()

    cmd_buf = ""
    scroll_offset = 0
    help_mode = False

    # Start worker thread
    worker = threading.Thread(target=worker_loop, args=(state,), daemon=True)
    worker.start()

    while True:
        # Compute layout sizes
        h, w = stdscr.getmaxyx()
        status_h = 5
        cmd_h = 4 if help_mode else 2  # help adds 2 lines
        log_h = h - status_h - cmd_h - 1  # -1 for separator

        # Check if worker is done and no longer running
        if not worker.is_alive() and not state.running:
            stdscr.clear()
            if h < 10 or w < 40:
                break
            draw_status_panel(stdscr, state, status_h, w)
            draw_log_panel(stdscr, state, status_h, log_h, w, scroll_offset)
            draw_command_bar(stdscr, state, h - cmd_h, w, cmd_buf, help_mode)
            stdscr.refresh()
            # Wait for user to press q
            stdscr.timeout(-1)
            while True:
                ch = stdscr.getch()
                if ch in (ord('q'), ord('Q'), 27):
                    return

        stdscr.clear()
        if h < 10 or w < 40:
            try:
                stdscr.addstr(0, 0, "Terminal too small. Resize to at least 40x10.")
            except curses.error:
                pass
            stdscr.refresh()
            stdscr.getch()
            continue

        draw_status_panel(stdscr, state, status_h, w)
        total_lines = draw_log_panel(stdscr, state, status_h, log_h, w,
                                     scroll_offset)
        draw_command_bar(stdscr, state, h - cmd_h, w, cmd_buf, help_mode)
        stdscr.refresh()

        # Handle input
        ch = stdscr.getch()
        if ch == -1:
            continue
        elif ch == curses.KEY_UP:
            scroll_offset = min(scroll_offset + 3, max(0, total_lines - log_h))
        elif ch == curses.KEY_DOWN:
            scroll_offset = max(0, scroll_offset - 3)
        elif ch == curses.KEY_PPAGE:  # Page Up
            scroll_offset = min(scroll_offset + log_h, max(0, total_lines - log_h))
        elif ch == curses.KEY_NPAGE:  # Page Down
            scroll_offset = max(0, scroll_offset - log_h)
        elif ch == curses.KEY_END:
            scroll_offset = 0  # snap to bottom
        elif ch == curses.KEY_HOME:
            scroll_offset = max(0, total_lines - log_h)  # snap to top
        elif ch in (curses.KEY_BACKSPACE, 127, 8):
            cmd_buf = cmd_buf[:-1]
        elif ch in (10, 13):  # Enter
            if cmd_buf.strip():
                low = cmd_buf.strip().lower()
                if low in ("h", "help", "?"):
                    help_mode = not help_mode
                else:
                    process_command(cmd_buf, state)
                cmd_buf = ""
            scroll_offset = 0  # snap to bottom on command
        elif ch == 27:  # Esc
            cmd_buf = ""
            help_mode = False
        elif 32 <= ch <= 126:
            cmd_buf += chr(ch)
            # Single-key shortcuts (immediate, no Enter needed)
            if cmd_buf == "?":
                help_mode = not help_mode
                cmd_buf = ""
            elif cmd_buf in ("q", "k"):
                process_command(cmd_buf, state)
                cmd_buf = ""
                if not state.running:
                    time.sleep(0.3)
                    return


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Autonomous AI spawner for codex-orchestrator study (TUI)")
    parser.add_argument("--engine", choices=["claude", "codex"], default="claude",
                        help="AI engine to use (default: claude)")
    parser.add_argument("--model", default=None,
                        help="Model to use (default: sonnet for claude, o4-mini for codex)")
    parser.add_argument("--timeout", type=int, default=1800,
                        help="Per-task timeout in seconds (default: 1800)")
    parser.add_argument("--start-cycle", type=int,
                        help="Override starting cycle number")
    parser.add_argument("--start-task", type=int,
                        help="Override starting task index (1-7)")
    parser.add_argument("--log-file", default=os.path.join(REPO_ROOT, "spawner.log"),
                        help="Log file path (default: spawner.log)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print prompts without running AI")
    parser.add_argument("--once", action="store_true",
                        help="Run a single task and exit")
    codex_group = parser.add_argument_group(
        "codex exec passthrough",
        "Flags mirrored from `codex exec --help`. Interactive-only top-level "
        "flags such as --search, --remote, and --no-alt-screen are "
        "intentionally not exposed because the spawner always uses "
        "non-interactive `codex exec`.",
    )
    codex_group.add_argument("--codex-config", action="append", default=[],
                             metavar="KEY=VALUE",
                             help="Repeatable `codex exec --config` override")
    codex_group.add_argument("--codex-enable", action="append", default=[],
                             metavar="FEATURE",
                             help="Repeatable `codex exec --enable` feature")
    codex_group.add_argument("--codex-disable", action="append", default=[],
                             metavar="FEATURE",
                             help="Repeatable `codex exec --disable` feature")
    codex_group.add_argument("--codex-image", action="append", default=[],
                             metavar="FILE",
                             help="Attach an image via `codex exec --image`")
    codex_group.add_argument("--codex-oss", action="store_true",
                             help="Pass `--oss` to `codex exec`")
    codex_group.add_argument("--codex-local-provider",
                             choices=["lmstudio", "ollama"],
                             help="Pass `--local-provider` to `codex exec`")
    codex_group.add_argument("--codex-sandbox",
                             choices=["read-only", "workspace-write", "danger-full-access"],
                             help="Pass `--sandbox` to `codex exec` when dangerous bypass is off")
    codex_group.add_argument("--codex-profile",
                             help="Pass `--profile` to `codex exec`")
    codex_group.add_argument("--codex-full-auto", action="store_true",
                             help="Pass `--full-auto` when dangerous bypass is off")
    codex_group.set_defaults(codex_bypass_approvals_and_sandbox=True)
    codex_group.add_argument("--codex-bypass-approvals-and-sandbox",
                             dest="codex_bypass_approvals_and_sandbox",
                             action="store_true",
                             help="Keep the historical spawner default: pass "
                                  "`--dangerously-bypass-approvals-and-sandbox`")
    codex_group.add_argument("--no-codex-bypass-approvals-and-sandbox",
                             dest="codex_bypass_approvals_and_sandbox",
                             action="store_false",
                             help="Disable dangerous bypass so sandbox/full-auto "
                                  "flags can take effect")
    codex_group.add_argument("--codex-add-dir", action="append", default=[],
                             metavar="DIR",
                             help="Repeatable `codex exec --add-dir` writable path")
    codex_group.add_argument("--codex-ephemeral", action="store_true",
                             help="Pass `--ephemeral` to `codex exec`")
    codex_group.add_argument("--codex-output-schema",
                             help="Pass `--output-schema` to `codex exec`")
    codex_group.add_argument("--codex-color",
                             choices=["always", "never", "auto"],
                             help="Pass `--color` to `codex exec`")
    codex_group.add_argument("--codex-progress-cursor", action="store_true",
                             help="Pass `--progress-cursor` to `codex exec`")
    codex_group.add_argument("--codex-json", action="store_true",
                             help="Pass `--json` to `codex exec`")
    args = parser.parse_args()

    engine = args.engine
    model = args.model
    if model is None:
        model = "o4-mini" if engine == "codex" else "sonnet"

    # Check binary exists
    if not shutil.which(engine):
        print(f"Error: '{engine}' binary not found in PATH.", file=sys.stderr)
        sys.exit(1)

    # Load or override state
    saved = load_state()
    cycle = args.start_cycle if args.start_cycle else saved.get("cycle", 1)
    task_index = (args.start_task - 1) if args.start_task else saved.get("task_index", 0)
    task_index = max(0, min(task_index, len(TASKS) - 1))

    state = SpawnerState(
        engine=engine, model=model, timeout=args.timeout,
        log_file=args.log_file, cycle=cycle, task_index=task_index,
        dry_run=args.dry_run, once=args.once,
        codex_exec_options=CodexExecOptions(
            config_overrides=args.codex_config,
            enable_features=args.codex_enable,
            disable_features=args.codex_disable,
            images=args.codex_image,
            oss=args.codex_oss,
            local_provider=args.codex_local_provider,
            sandbox_mode=args.codex_sandbox,
            profile=args.codex_profile,
            full_auto=args.codex_full_auto,
            bypass_approvals_and_sandbox=args.codex_bypass_approvals_and_sandbox,
            add_dirs=args.codex_add_dir,
            ephemeral=args.codex_ephemeral,
            output_schema=args.codex_output_schema,
            color=args.codex_color,
            progress_cursor=args.codex_progress_cursor,
            json_output=args.codex_json,
        ),
    )

    # Ignore SIGINT in main -- curses and the worker handle shutdown
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    try:
        curses.wrapper(tui_main, state)
    except KeyboardInterrupt:
        pass

    # Final console message after curses exits
    with state.lock:
        c = state.cycle
        ti = state.task_index
        fatal = state.fatal_msg
    if fatal:
        print(f"\nFATAL: {fatal}")
        print(f"State saved at cycle {c}, task {ti + 1}/{len(TASKS)}.")
        print("Resolve the issue and re-run: python3 spawner.py")
        sys.exit(2)
    else:
        print(f"\nSpawner stopped at cycle {c}, task {ti + 1}/{len(TASKS)}.")
        print("Resume with: python3 spawner.py")


if __name__ == "__main__":
    main()
