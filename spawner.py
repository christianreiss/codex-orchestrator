#!/usr/bin/env python3
"""Autonomous AI spawner for codex-orchestrator study.

Cyclically spawns claude agents with task-specific prompts.
Each agent makes real changes, commits locally, and reports a summary.
"""

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(REPO_ROOT, ".spawner-state.json")
SUMMARY_START = "===SPAWNER_SUMMARY_START==="
SUMMARY_END = "===SPAWNER_SUMMARY_END==="


# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
class C:
    """ANSI color codes, disabled when NO_COLOR is set."""
    _enabled = "NO_COLOR" not in os.environ and sys.stdout.isatty()
    BOLD   = "\033[1m"  if _enabled else ""
    DIM    = "\033[2m"  if _enabled else ""
    GREEN  = "\033[32m" if _enabled else ""
    YELLOW = "\033[33m" if _enabled else ""
    RED    = "\033[31m" if _enabled else ""
    CYAN   = "\033[96m" if _enabled else ""
    MAGENTA = "\033[35m" if _enabled else ""
    RESET  = "\033[0m"  if _enabled else ""


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
# State management
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
    except OSError as e:
        print(f"{C.YELLOW}Warning: could not save state: {e}{C.RESET}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Summary parsing
# ---------------------------------------------------------------------------
def parse_summary(stdout: str) -> str:
    start = stdout.find(SUMMARY_START)
    end = stdout.find(SUMMARY_END)
    if start != -1 and end != -1:
        return stdout[start + len(SUMMARY_START):end].strip()
    # Fallback: last 500 chars
    return stdout[-500:].strip() if stdout else "(no output)"


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def log_result(log_file: str, cycle: int, task_num: int, task_name: str,
               status: str, duration: float, summary: str, error: str = "") -> None:
    dur_str = format_duration(duration)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = (
        f"{'=' * 80}\n"
        f"Cycle {cycle} | Task {task_num}/6: {task_name}\n"
        f"Time: {now}\n"
        f"Status: {status}\n"
        f"Duration: {dur_str}\n"
        f"{'-' * 80}\n"
    )
    if status == "SUCCESS":
        entry += f"Summary:\n{summary}\n"
    else:
        if error:
            entry += f"Error:\n{error[:1000]}\n{'-' * 80}\n"
        entry += f"Output (last 500 chars):\n{summary}\n"
    entry += f"{'=' * 80}\n\n"

    try:
        with open(log_file, "a") as f:
            f.write(entry)
    except OSError as e:
        print(f"{C.YELLOW}Warning: could not write log: {e}{C.RESET}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Console output
# ---------------------------------------------------------------------------
def format_duration(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    if m > 0:
        return f"{m}m {s}s"
    return f"{s}s"


def print_header(cycle: int, task_num: int, task_name: str) -> None:
    line = f"{C.CYAN}{'━' * 64}{C.RESET}"
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n{line}")
    print(f"{C.BOLD}Cycle {cycle}{C.RESET} | Task {C.YELLOW}{task_num}/6{C.RESET}: {C.GREEN}{task_name}{C.RESET}")
    print(f"{C.DIM}Started at {now}{C.RESET}")
    print(line)
    sys.stdout.flush()


def print_result(status: str, duration: float, summary: str) -> None:
    dur_str = format_duration(duration)
    if status == "SUCCESS":
        print(f"\n  {C.GREEN}SUCCESS{C.RESET} ({dur_str})")
    elif status == "TIMEOUT":
        print(f"\n  {C.RED}TIMEOUT{C.RESET} ({dur_str})")
    else:
        print(f"\n  {C.RED}{status}{C.RESET} ({dur_str})")
    # Print summary indented
    for line in summary.split("\n"):
        print(f"  {C.DIM}{line}{C.RESET}")
    print()
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Task runner
# ---------------------------------------------------------------------------
def run_task(task: dict, model: str, timeout_seconds: int) -> dict:
    """Run a single claude agent and return results."""
    cmd = [
        "claude",
        "--dangerously-skip-permissions",
        "-p",
        "--model", model,
        task["prompt"],
    ]

    print(f"  {C.DIM}Running claude (model={model}, timeout={timeout_seconds}s)...{C.RESET}")
    sys.stdout.flush()

    start_time = time.time()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            cwd=REPO_ROOT,
        )
        duration = time.time() - start_time
        summary = parse_summary(result.stdout)

        if result.returncode == 0:
            return {
                "status": "SUCCESS",
                "summary": summary,
                "duration": duration,
                "error": "",
            }
        else:
            return {
                "status": f"FAILED (exit code {result.returncode})",
                "summary": summary,
                "duration": duration,
                "error": result.stderr[-1000:] if result.stderr else "",
            }
    except subprocess.TimeoutExpired as e:
        duration = time.time() - start_time
        stdout = e.stdout or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        return {
            "status": "TIMEOUT",
            "summary": parse_summary(stdout),
            "duration": duration,
            "error": f"Process killed after {timeout_seconds}s",
        }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Autonomous AI spawner for codex-orchestrator study"
    )
    parser.add_argument("--model", default="sonnet",
                        help="Claude model to use (default: sonnet)")
    parser.add_argument("--timeout", type=int, default=1800,
                        help="Per-task timeout in seconds (default: 1800)")
    parser.add_argument("--start-cycle", type=int,
                        help="Override starting cycle number")
    parser.add_argument("--start-task", type=int,
                        help="Override starting task index (1-6)")
    parser.add_argument("--log-file", default=os.path.join(REPO_ROOT, "spawner.log"),
                        help="Log file path (default: spawner.log)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print prompts without running claude")
    parser.add_argument("--once", action="store_true",
                        help="Run a single task and exit")
    args = parser.parse_args()

    # Check claude binary exists
    if not shutil.which("claude"):
        print(f"{C.RED}Error: 'claude' binary not found in PATH.{C.RESET}", file=sys.stderr)
        sys.exit(1)

    # Load or override state
    state = load_state()
    cycle = args.start_cycle if args.start_cycle else state.get("cycle", 1)
    task_index = (args.start_task - 1) if args.start_task else state.get("task_index", 0)

    # Clamp task_index
    task_index = max(0, min(task_index, len(TASKS) - 1))

    print(f"{C.BOLD}{C.CYAN}AI Spawner{C.RESET} | codex-orchestrator")
    print(f"Model: {args.model} | Timeout: {args.timeout}s | Log: {args.log_file}")
    print(f"Starting at cycle {cycle}, task {task_index + 1}/6")
    if args.dry_run:
        print(f"{C.YELLOW}DRY RUN MODE{C.RESET}")
    print()

    try:
        while True:
            task = TASKS[task_index]
            task_num = task_index + 1
            print_header(cycle, task_num, task["name"])

            if args.dry_run:
                print(f"{C.DIM}{task['prompt'][:200]}...{C.RESET}")
                result_data = {
                    "status": "DRY_RUN",
                    "summary": "(dry run -- no changes)",
                    "duration": 0,
                    "error": "",
                }
            else:
                result_data = run_task(task, args.model, args.timeout)

            print_result(result_data["status"], result_data["duration"],
                         result_data["summary"])
            log_result(args.log_file, cycle, task_num, task["name"],
                       result_data["status"], result_data["duration"],
                       result_data["summary"], result_data.get("error", ""))

            # Advance to next task
            task_index = (task_index + 1) % len(TASKS)
            if task_index == 0:
                cycle += 1
            save_state(cycle, task_index)

            if args.once:
                print(f"{C.GREEN}Single task complete. Exiting.{C.RESET}")
                break

    except KeyboardInterrupt:
        save_state(cycle, task_index)
        print(f"\n{C.YELLOW}Spawner stopped at cycle {cycle}, task {task_index + 1}/6.")
        print(f"Resume with: python3 spawner.py{C.RESET}")
        sys.exit(0)


if __name__ == "__main__":
    main()
