#!/usr/bin/env python3
"""Record the four README startup cards in real 88-column pseudo-terminals.

Run this file with Python 3 and Go, with the wrapper's Go dependencies cached.
The native versions illustrate hosts running the repository's runner pins.
All host, account and usage readings are synthetic, and no provider CLI is run.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WRAPPERS = ROOT / "wrappers"
MODULE = WRAPPERS / "cxx"

# Exercise the same renderer the four managed launch paths call. Passing
# ScreenInput as JSON keeps all example readings here without editing Go source.
RENDERER = '''package main

import (
    "encoding/json"
    "flag"
    "log"
    "os"
    "path/filepath"

    "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func main() {
    engine := flag.String("engine", "", "README fixture")
    scene := flag.String("scene", "", "startup")
    flag.Parse()
    if *scene != "startup" { log.Fatal("expected a startup card") }
    source, err := os.Open(filepath.Join(filepath.Dir(os.Args[0]), *engine+".json"))
    if err != nil { log.Fatal(err) }
    defer source.Close()
    var screen terminalui.ScreenInput
    decoder := json.NewDecoder(source)
    decoder.DisallowUnknownFields()
    if err := decoder.Decode(&screen); err != nil { log.Fatal(err) }
    terminalui.PrintBootScreen(os.Stdout, screen)
}
'''

# Reset durations are minutes. Grok has one subscription period; Kimi can
# expose two distinct monthly limits in addition to the short and weekly ones.
EXAMPLES = {
    "codex": ("cdx", "CODEX_VERSION", "gpt-6.2-astra", "high",
              [("5h", 32, 138), ("weekly", 41, 4620)]),
    "claude": ("clx", "CLAUDE_CODE_VERSION", "claude-opus-5-5", "medium",
               [("5h", 18, 176), ("weekly", 36, 5730)]),
    "grok": ("cgx", "GROK_VERSION", "grok-4.7", "high", [("weekly", 44, 5940)]),
    "kimi": ("ckx", "KIMI_VERSION", "kimi-code/k3.1-pro", "max",
             [("5h", 23, 152), ("weekly", 34, 4380),
              ("month total", 38, 23280), ("month code", 29, 23280)]),
}


def pinned_version(source, pattern):
    match = re.search(pattern + r"(\d+\.\d+\.\d+)$", source, re.MULTILINE)
    if not match:
        raise ValueError(f"Could not find an exact version for {pattern!r}")
    return match[1]


def screen_input(engine, wrapper, runner):
    persona, pin, model, effort, quota = EXAMPLES[engine]
    subscription_lease = engine in ("grok", "kimi")
    dots = [{"Name": name, "Tone": "ok"} for name in ("api", "auth", "skills", "config", "runner")]
    sessions = [("hosts 30m", 3), ("syncs UTC day", 27), ("syncs UTC month", 416)]
    if subscription_lease:
        # The Grok/Kimi runtime reports configured MCP without a connectivity probe.
        dots.append({"Name": "mcp", "Tone": "dim"})
    else:
        sessions.insert(0, ("local procs", 1))
    return {
        "Prefix": persona, "EngineName": engine, "WrapperVersion": wrapper,
        "EngineVersion": pinned_version(runner, rf"^ARG {pin}="),
        "WrapperTone": "ok", "EngineTone": "ok", "Model": model, "Effort": effort,
        "HostFQDN": "atlas.example.net", "APICalls": 1284, "Dots": dots,
        "Launch": {"Account": f"{engine}-team", "Session": "Ada"},
        "QuotaRows": [{"Label": label, "Used": used, "ResetAfter": minutes * 60_000_000_000}
                      for label, used, minutes in quota],
        "SessionRows": [{"Label": label, "Count": count} for label, count in sessions],
        "ResultLabel": ("Ready — subscription account leased." if subscription_lease
                        else "Ready — all systems operational."),
        "ResultTone": "ok",
    }


def main():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("terminal_check", WRAPPERS / "scripts/check-terminal-ui.py")
    terminal = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(terminal)
    wrapper = pinned_version((WRAPPERS / "Makefile").read_text(), r"^VERSION \?= ")
    runner = (ROOT / "runner/Dockerfile").read_text()
    captures = {}
    # The temporary Go entrypoint belongs inside the module for its internal import.
    with tempfile.TemporaryDirectory(prefix="readme-preview-", dir=MODULE) as work:
        work = Path(work)
        (work / "main.go").write_text(RENDERER)
        binary = work / "preview"
        subprocess.run(["go", "build", "-mod=readonly", "-o", binary, "."], cwd=work,
                       env={**os.environ, "GOPROXY": "off"}, check=True)
        for engine in EXAMPLES:
            screen = screen_input(engine, wrapper, runner)
            (work / f"{engine}.json").write_text(json.dumps(screen))
            ansi = terminal.capture(binary, engine, "startup", 88, "rich")
            plain = terminal.verify(ansi, 88, "rich")
            persona = screen["Prefix"]
            expected = [f"{persona.upper()} / {engine.upper()}", f"wrapper {wrapper}",
                        f"{engine} {screen['EngineVersion']}", f"{screen['Model']}/{screen['Effort']}"]
            # Long quota labels can occupy a line above their meter.
            text = " ".join(word for line in plain.splitlines() for word in line.strip("│ ").split())
            expected += [f"{row['Label']} {row['Used']}%" for row in screen["QuotaRows"]]
            for item in expected:
                if item not in text:
                    raise ValueError(f"{persona} card is missing {item!r}")
            captures[persona] = ansi
    for persona, ansi in captures.items():
        (HERE / f"{persona}.ansi").write_text(ansi)
        print(f"{persona}: production startup renderer verified at 88 columns")


if __name__ == "__main__":
    main()
