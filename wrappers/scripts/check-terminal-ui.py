#!/usr/bin/env python3
"""Exercise real terminal detection with safe fixtures; optionally export a gallery.

Uses only the Python standard library. The preview binary is a developer fixture
driver, never an installed wrapper: no fleet auth, upstream CLI, or network calls.
"""

import argparse
import errno
import fcntl
import html
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import termios
import time
import unicodedata


SGR = re.compile(r"\x1b\[([0-9;]*)m")
SCENES = ("startup", "attention", "blocked", "concurrent", "stale", "forecast", "doctor", "help", "session", "updates", "notices", "prompt")
COLORS = {30: "#555766", 31: "#ef747b", 32: "#85ca97", 33: "#eac079", 34: "#88a9e8", 35: "#c79aee", 36: "#8bced7", 37: "#e2e5ed"}


def capture(binary, engine, scene, width, mode):
    env = dict(os.environ, TERM="xterm-256color", LANG="C.UTF-8", LC_ALL="C.UTF-8", COLUMNS="200")
    for name in ("NO_COLOR", "CDX_SKIP_BANNER", "CLX_SKIP_BANNER"):
        env.pop(name, None)
    if mode == "no-color":
        env["NO_COLOR"] = "1"
    elif mode == "dumb":
        env["TERM"] = "dumb"
    elif mode == "ascii":
        env["LC_ALL"] = "C"
    args = [str(binary), "-engine", engine, "-scene", scene]
    if mode == "minimal":
        args.append("-minimal")
    if mode == "pipe":
        env["COLUMNS"] = str(width)
        return subprocess.run(args, env=env, check=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=10).stdout.decode()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 240, width, 0, 0))
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=slave, stderr=slave, env=env, close_fds=True)
    os.close(slave)
    output = bytearray()
    deadline = time.monotonic() + 10
    try:
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(f"preview timed out: {engine}/{scene}/{mode}")
            if not select.select([master], [], [], 0.1)[0]:
                continue
            try:
                part = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not part:
                break
            output.extend(part)
        if process.wait(timeout=2) != 0:
            raise RuntimeError(output.decode(errors="replace"))
    finally:
        os.close(master)
        if process.poll() is None:
            process.kill()
            process.wait()
    return output.decode().replace("\r\n", "\n")


def visible_width(line):
    # Fixtures deliberately contain ordinary text/glyphs, not complex emoji;
    # the Go renderer separately tests grapheme/ZWJ/combining-character widths.
    return sum(0 if unicodedata.combining(char) else 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1 for char in line)


def verify(output, width, mode):
    plain = SGR.sub("", output)
    assert plain.strip(), "empty terminal output"
    assert not any(ord(char) < 32 and char != "\n" for char in plain), "unexpected terminal control sequence"
    for index, line in enumerate(plain.splitlines(), 1):
        assert visible_width(line) <= width, f"line {index} exceeds {width} columns: {line!r}"
    lines = plain.splitlines()
    if lines and lines[0].startswith("╭"):
        frame_width = visible_width(lines[0])
        for line in lines:
            assert visible_width(line) == frame_width, f"misaligned frame edge: {line!r}"
    if mode in ("minimal", "dumb", "pipe", "no-color") or width < 40:
        assert "\x1b" not in output, "ANSI in a plain destination"
    if mode in ("minimal", "dumb", "pipe", "ascii") or width < 40:
        assert plain.isascii(), "non-ASCII glyph in a portable destination"
    return plain


def color256(value):
    if value < 16:
        return COLORS.get(30 + value % 8, "#e2e5ed")
    if value >= 232:
        level = min(255, 8 + (value - 232) * 10)
        return f"rgb({level},{level},{level})"
    index = value - 16
    levels = (0, 95, 135, 175, 215, 255)
    return f"rgb({levels[index // 36]},{levels[index // 6 % 6]},{levels[index % 6]})"


def ansi_html(output):
    result, start, style = [], 0, {}
    for match in SGR.finditer(output):
        text = terminal_text(output[start:match.start()])
        css = ";".join(f"{key}:{value}" for key, value in style.items())
        result.append(f'<span style="{css}">{text}</span>')
        values = [int(value or "0") for value in match.group(1).split(";")]
        i = 0
        while i < len(values):
            value = values[i]
            if value == 0:
                style = {}
            elif value == 1:
                style["font-weight"] = "700"
            elif value == 2:
                style["opacity"] = ".68"
            elif value == 22:
                style.pop("font-weight", None)
                style.pop("opacity", None)
            elif value == 39:
                style.pop("color", None)
            elif value in COLORS:
                style["color"] = COLORS[value]
            elif value == 38 and values[i + 1:i + 2] == [5] and len(values) > i + 2:
                style["color"] = color256(values[i + 2])
                i += 2
            elif value == 38 and values[i + 1:i + 2] == [2] and len(values) > i + 4:
                style["color"] = f"rgb({values[i + 2]},{values[i + 3]},{values[i + 4]})"
                i += 4
            i += 1
        start = match.end()
    result.append(terminal_text(output[start:]))
    return "".join(result)


def terminal_text(value):
    # Browser fallback fonts may render a terminal's one-cell status glyph at
    # emoji width. Fix those cells so HTML faithfully preserves PTY geometry.
    return "".join(
        html.escape(char) if char.isascii() else
        f'<span style="display:inline-block;width:{visible_width(char)}ch;text-align:center">{html.escape(char)}</span>'
        for char in value
    )


def write_gallery(directory, cases):
    directory.mkdir(parents=True, exist_ok=True)
    panels = []
    for case in cases:
        name = "-".join(str(case[key]) for key in ("engine", "scene", "width", "mode"))
        (directory / f"{name}.ansi").write_text(case["output"])
        (directory / f"{name}.txt").write_text(case["plain"])
        if case["mode"] == "rich" and case["width"] in (48, 80):
            panels.append(f'<article data-engine="{case["engine"]}" data-scene="{case["scene"]}" data-width="{case["width"]}"><h2>{case["engine"]} / {case["scene"]} <small>{case["width"]} columns</small></h2><pre>{ansi_html(case["output"])}</pre></article>')
    (directory / "index.html").write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><title>cxx terminal design review</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0e1016;color:#e2e5ed;font:15px system-ui;padding:40px}h1{font-size:30px;margin:0 0 12px}p{color:#a1a8bb}main{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}article{background:#171a23;border:1px solid #2b3040;border-radius:14px;overflow:hidden}h2{font:600 13px system-ui;padding:14px 20px;margin:0;background:#1d212d;color:#c2c9da;text-transform:uppercase;letter-spacing:.08em}small{float:right;margin-left:32px;color:#929aae}pre{font:14px/1.55 "DejaVu Sans Mono",monospace;margin:0;padding:20px 12px;white-space:pre}select{background:#1d212d;border:1px solid #454d62;color:#e2e5ed;border-radius:6px;padding:8px;margin:12px 12px 24px 0}label{color:#a1a8bb}article[hidden]{display:none}</style>
<h1>One terminal. Two engines.</h1><p>Production cdx / clx renderers captured from real PTYs. Deterministic sample data; no fleet credentials or live reports.</p>
<label>Scene <select id="scene">''' + "".join(f'<option>{scene}</option>' for scene in SCENES + ("security",)) + '''</select></label><label>Width <select id="width"><option>80</option><option>48</option></select></label><main>''' + "".join(panels) + '''</main><script>const scene=document.querySelector('#scene'),width=document.querySelector('#width');function filter(){document.querySelectorAll('article').forEach(a=>a.hidden=a.dataset.scene!==scene.value||a.dataset.width!==width.value)}scene.onchange=width.onchange=filter;filter()</script></html>''')
    (directory / "manifest.json").write_text(json.dumps([{key: value for key, value in case.items() if key not in ("output", "plain")} for case in cases], indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, help="export ANSI/text captures and a standalone HTML review gallery")
    args = parser.parse_args()
    cases = []
    for engine in ("codex", "claude"):
        scenes = SCENES + (("security",) if engine == "claude" else ())
        for scene in scenes:
            modes = [(width, "rich") for width in (20, 39, 40, 48, 64, 80, 120)]
            modes += [(80, mode) for mode in ("no-color", "dumb", "ascii", "minimal", "pipe")]
            for width, mode in modes:
                output = capture(args.binary.resolve(), engine, scene, width, mode)
                try:
                    plain = verify(output, width, mode)
                except AssertionError as error:
                    raise AssertionError(f"{engine}/{scene}/{width}/{mode}: {error}") from error
                cases.append(dict(engine=engine, scene=scene, width=width, mode=mode, output=output, plain=plain))
    if args.output:
        write_gallery(args.output, cases)
    print(f"{len(cases)} terminal cases passed: both engines, seven widths, five degraded modes.")


if __name__ == "__main__":
    main()
