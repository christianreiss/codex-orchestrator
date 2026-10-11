#!/usr/bin/env python3
"""Capture current production terminal renderers with documentation-only inputs.

Run from any directory: python3 frontend/scripts/readme-shots/terminals.py
Requires Go and Python's standard library. No installed wrapper, fleet auth,
provider CLI or network service is invoked. The temporary preview entrypoint
changes only the upstream preview's illustrative version/host/model values.
"""

import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WRAPPERS = ROOT / "wrappers"
MODULE = WRAPPERS / "cxx"

spec = importlib.util.spec_from_file_location("terminal_check", WRAPPERS / "scripts/check-terminal-ui.py")
assert spec and spec.loader
terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal)

version_match = re.search(r"^VERSION \?= (\S+)$", (WRAPPERS / "Makefile").read_text(), re.MULTILINE)
assert version_match, "Wrapper VERSION is missing"
source = (MODULE / "cmd/terminal-preview/main.go").read_text()
for original, demo in (
    ('WrapperVersion: "0.8.0"', f'WrapperVersion: "{version_match[1]}"'),
    ('"0.144.1"', '"0.158.0"'),
    ('"2.1.71"', '"2.1.184"'),
    ('"workstation.example"', '"atlas.example.net"'),
):
    assert original in source, f"Preview fixture changed: {original}"
    source = source.replace(original, demo)

# Go internal imports require this temporary entrypoint inside the module.
with tempfile.TemporaryDirectory(prefix="readme-preview-", dir=MODULE) as work:
    work = Path(work)
    (work / "main.go").write_text(source)
    binary = work / "preview"
    subprocess.run(["go", "build", "-o", str(binary), "."], cwd=work, check=True)
    for engine, persona in (("codex", "cdx"), ("claude", "clx"), ("grok", "cgx")):
        ansi = terminal.capture(binary, engine, "startup", 88, "rich")
        terminal.verify(ansi, 88, "rich")
        (HERE / f"{persona}.ansi").write_text(ansi)
        print(f"{persona}: production renderer verified at 88 columns")
