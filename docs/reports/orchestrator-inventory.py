#!/usr/bin/env python3
"""Rebuild the review indexes from versioned files and the captured HTTP/MCP catalog.

Run at the repository root. Reads Git-visible source and local compiler metadata.
Seed HTTP and tool registrations from orchestrator-entrypoints.tsv; see the matrix
for capture provenance. Other entries are regenerated from the worktree.
"""

import argparse
import ast
import csv
import json
import os
import re
import subprocess
from collections import Counter, defaultdict, deque
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path.cwd()
OUT = ROOT / "docs/reports"
FILES = {
    p
    for p in subprocess.check_output(
        [
            "git",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
            ":(exclude,glob)**/node_modules/**",
            ":(exclude,glob).review*",
            ":(exclude,glob).review/**",
        ]
    )
    .decode()
    .split("\0")
    if p and Path(p).is_file()
}
FILES.add("docs/reports/orchestrator-modules.tsv")
SOURCE = {}
GRAPH = defaultdict(set)
ROOTS = {}
CLASS = {}
SCOPE = {}
EVIDENCE = {}
NOTE = {}
ENTRY = OUT / "orchestrator-entrypoints.tsv"
MODULE = OUT / "orchestrator-modules.tsv"


def read(path):
    if path not in SOURCE:
        SOURCE[path] = Path(path).read_text(errors="replace")
    return SOURCE[path]


def loc(path, pos):
    return f"{path}:{1 + read(path).count(chr(10), 0, pos)}"


def seed(path, label):
    if path in FILES:
        ROOTS[path] = label


def link(src, target):
    if src in FILES and target in FILES:
        GRAPH[src].add(target)


def tsv(path, header, rows, quoting=csv.QUOTE_MINIMAL):
    with path.open("w", newline="") as out:
        writer = csv.writer(out, delimiter="\t", lineterminator="\n", quoting=quoting)
        writer.writerow(header)
        writer.writerows(rows)


def category(path):
    if path.startswith(("frontend/static/fonts/", "public/admin/fonts/")) or "/third-party/" in path:
        return "third-party / bundled asset"
    if path.startswith("public/admin/manual/"):
        return "shipped help content"
    if path.startswith("public/admin/"):
        return "built SPA artifact"
    if "/third-party/" in path or "/vendor/" in path or path.endswith(("gradle-wrapper.jar", "gradlew", "gradlew.bat")):
        return "third-party / bundled tooling"
    if "/db/migrations/" in path:
        return "released migration"
    if "/db/baseline/" in path:
        return "initial schema"
    if (
        re.search(r"(^|/)(test|tests|e2e|testdata|androidTest|__snapshots__)(/|$)", path)
        or path.startswith("scripts/test-")
        or "/testutil/" in path
        or re.search(r"(\.test\.[cm]?[jt]s|_test\.go|/test_[^/]+\.py)$", path)
    ):
        return "test / fixture"
    if path.startswith(("docs/", "storage/")) or path.endswith((".md", "LICENSE", ".gitkeep")):
        return "documentation / repository metadata"
    if path.endswith(("package-lock.json", "go.sum", "gradle.lockfile")):
        return "dependency lock"
    if path.endswith((".ts", ".js", ".mjs", ".cjs", ".mts", ".svelte", ".go", ".kt", ".py", ".qml")):
        return "source"
    return "asset / configuration / operator entry"


def resolve_js(src, spec):
    if spec.startswith("$lib/"):
        start = "frontend/src/lib/" + spec.removeprefix("$lib/")
    elif spec.startswith("."):
        start = os.path.normpath(os.path.join(os.path.dirname(src), spec))
    else:
        return
    candidates = [start, re.sub(r"\.[cm]?js$", ".ts", start)]
    candidates += [start + end for end in (".ts", ".svelte", ".js", "/index.ts", "/index.js")]
    for item in candidates:
        if item in FILES:
            return item


def js_graph():
    # Includes type dependencies; these prove build reachability, not runtime calls.
    imports = re.compile(
        r"""(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bexport\s*\*\s*from\s*|\brequire\s*\(\s*|@import\s*(?:url\(\s*)?)["']([^"']+)["']"""
    )
    for src in sorted(FILES):
        if CLASS[src] == "test / fixture" or not src.endswith((".ts", ".mts", ".svelte", ".js", ".mjs", ".css")):
            continue
        if not src.startswith(("api/", "frontend/", "slop-worker/")) or "/vendor/" in src:
            continue
        for m in imports.finditer(read(src)):
            target = resolve_js(src, m[1])
            if target:
                link(src, target)
    for src in FILES:
        if src.startswith("frontend/src/routes/") and re.search(
            r"/\+(?:page|layout|error)(?:\.server)?\.(svelte|ts)$", src
        ):
            seed(src, "SvelteKit filesystem route")
    for src in sorted(FILES):
        if (
            src.startswith(("api/scripts/", "frontend/scripts/", "wrappers/scripts/", "scripts/"))
            and CLASS[src] != "test / fixture"
            and not src.endswith(".md")
        ):
            seed(src, "explicit maintenance/build script; inspect invocation")
        if re.match(r"^(?:frontend|api)/[^/]+\.config\.(?:ts|js)$", src):
            seed(src, "tooling config by conventional filename or package script")
    seed("frontend/src/app.d.ts", "SvelteKit ambient type contract")
    for src in (
        "api/src/server.ts",
        "api/src/db/migrate-cli.ts",
        "api/src/ops/retention-maintenance.ts",
        "api/src/ops/rotate-signing-key.ts",
        "api/src/ops/setup-signing-key.ts",
        "slop-worker/worker.mjs",
        "frontend/src/app.html",
    ):
        seed(src, "package, Docker, operator or build entry")


def go_graph():
    root = ROOT / "wrappers/cxx"
    make = read("wrappers/Makefile")
    platforms = re.search(r"^PLATFORMS\s*:=\s*(.+)$", make, re.M)[1].split()
    for target in platforms + ["linux/amd64+cxx_otel"]:
        osname, arch = target.split("/")
        arch, _, tag = arch.partition("+")
        # go list resolves package dependencies and file constraints without executing Go tests.
        command = [
            "go",
            "list",
            "-deps",
            "-f",
            '{{if and .Module .Module.Main}}{{.ImportPath}}|{{.Dir}}|{{join .GoFiles ","}}|{{join .EmbedFiles ","}}{{end}}',
        ]
        if tag:
            command += ["-tags", tag]
        data = subprocess.check_output(
            command + ["./cmd/cxx"],
            cwd=root,
            env={**os.environ, "GOOS": osname, "GOARCH": arch, "CGO_ENABLED": "0"},
            text=True,
        )
        for line in data.splitlines():
            if not line.strip():
                continue
            pkg, directory, sources, assets = line.split("|")
            for name in filter(None, (sources + "," + assets).split(",")):
                path = str((Path(directory) / name).relative_to(ROOT))
                if path in FILES:
                    SCOPE.setdefault(path, []).append(target)
                    EVIDENCE[path] = pkg
    seed("wrappers/cxx/cmd/terminal-preview/main.go", "separate terminal preview command")


def python_android_qml():
    for src in FILES:
        if src.startswith(("runner/", "advisor/", "media-worker/")) and src.endswith(".py") and CLASS[src] == "source":
            for node in ast.walk(ast.parse(read(src))):
                names = (
                    [n.name for n in node.names]
                    if isinstance(node, ast.Import)
                    else [node.module]
                    if isinstance(node, ast.ImportFrom)
                    else []
                )
                for name in filter(None, names):
                    link(src, str(Path(src).parent / (name.split(".")[0] + ".py")))
    for path in ("runner/app.py", "advisor/bootstrap.py", "media-worker/worker.py"):
        seed(path, "container entrypoint")
    manifest = "mobile/android/app/src/main/AndroidManifest.xml"
    seed(manifest, "Android application manifest")
    kotlin = {p for p in FILES if "/src/main/java/" in p and p.endswith(".kt")}
    # Name references within main source only. Kotlin functions and top-level composables
    # need symbol declarations as well as filename stems. Ambiguous symbols are omitted.
    symbols = defaultdict(set)
    for path in kotlin:
        for symbol in re.findall(
            r"^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:internal|private|public|data|enum|sealed|abstract|open|inline|tailrec|suspend|override|annotation|value|final)\s+)*(?:class|object|interface|fun|typealias)\s+(?:[\w<>?]+\.)?([A-Za-z_]\w*)",
            read(path),
            re.M,
        ):
            symbols[symbol].add(path)
    for element in ET.fromstring(read(manifest)).iter():
        name = element.attrib.get("{http://schemas.android.com/apk/res/android}name", "")
        if name.startswith("."):
            for target in symbols[name[1:]]:
                link(manifest, target)
    for path in kotlin:
        for name in set(re.findall(r"\b[A-Z][A-Za-z0-9_]+\b|\b[a-z][A-Za-z0-9_]+(?=\s*\()", read(path))):
            if len(symbols[name]) == 1:
                target = next(iter(symbols[name]))
                if target != path:
                    link(path, target)
    plasma = "plasmoid/org.codex.orchestrator/"
    seed(plasma + "metadata.json", "Plasma package metadata")
    for rel in (
        "contents/ui/main.qml",
        "contents/config/config.qml",
        "contents/config/main.xml",
    ):
        link(plasma + "metadata.json", plasma + rel)
    for path in sorted(p for p in FILES if p.startswith(plasma) and p.endswith(".qml")):
        for other in (p for p in FILES if p.startswith(plasma) and p.endswith(".qml") and p != path):
            if re.search(r"\b" + re.escape(Path(other).stem) + r"(?:\.qml|\s*\{)", read(path)):
                link(path, other)


def module_rows():
    for path in FILES:
        CLASS[path] = category(path)
    js_graph()
    go_graph()
    python_android_qml()
    for src, target in (
        ("runner/Dockerfile", "runner/install-grok.mjs"),
        ("runner/Dockerfile", "runner/install-kimi.sh"),
        ("bin/orchestrator", "bin/lib/instance-status.py"),
        ("bin/lib/owner-cutover.sh", "bin/lib/owner-drain-cutover.py"),
        ("api/Dockerfile", "api/src/server.ts"),
    ):
        if src in FILES and Path(target).name in read(src):
            seed(src, "container or instance CLI loader")
            link(src, target)
    for src in FILES:
        if src.startswith("wrappers/cxx/") and src.endswith("_windows.go") and src not in SCOPE:
            NOTE[src] = "Windows implementation; outside the five shipped platform targets"
        if src.startswith("frontend/static/") or src.startswith("frontend/src/lib/assets/"):
            NOTE[src] = "SvelteKit public source asset or imported module resource"
        if "/src/main/res/" in src:
            NOTE[src] = "Android resource merged by Gradle/aapt2; qualified variants selected by device"
        if "/db/migrations/" in src:
            NOTE[src] = "SQL migrator loads its numbered migration directory"

    queue = deque(sorted(ROOTS))
    previous = {path: None for path in queue}
    while queue:
        parent = queue.popleft()
        for path in sorted(GRAPH[parent]):
            if path not in previous:
                previous[path] = parent
                queue.append(path)
    rows = []
    for path in sorted(FILES):
        kind = CLASS[path]
        via = previous.get(path)
        remark = ""
        if path in SCOPE:
            state = "Go package dependency / selected files"
            via = EVIDENCE[path]
            remark = ",".join(SCOPE[path])
        elif path in ROOTS:
            state = "registered root"
            via = ROOTS[path]
        elif path in previous:
            state = (
                "Android symbol reference"
                if path.endswith(".kt")
                else "Plasma loader/reference"
                if path.startswith("plasmoid/")
                else "static module dependency"
            )
        elif kind == "source" and path.startswith(("frontend/scripts/", "api/scripts/", "wrappers/scripts/")):
            state = "build/maintenance script"
            via = "explicit invocation or package/CI script"
        elif path in NOTE:
            state = "conditional platform / loader"
            via = NOTE[path]
        elif kind == "source":
            state = "inspect separately"
            via = "no path from selected static roots"
        else:
            state = kind
        if path.endswith(".ts") and re.search(
            r"(?:@generated|^[/* #]*GENERATED\b|Do not edit (?:this file|manually))",
            read(path)[:550],
            re.I,
        ):
            kind += " / generated header"
        rows.append((path, kind, state, via or "", remark))
    return rows


def family(kind, key, path, prior="TOOLS"):
    word = key.lower().replace("-", "_")
    if kind in {"Fleet MCP", "Local MCP", "Admin event", "WS publish", "WS consumer"}:
        ordered = (
            (
                "COORD",
                (
                    "resource_claim",
                    "agent_context",
                    "agent_room_",
                    "agent_coordination",
                ),
            ),
            ("GIT", ("git_", "agent_git_", "git_director")),
            (
                "DAEMON",
                (
                    "host_spawn",
                    "agent_spawn",
                    "agent_stop",
                    "agent_reboot",
                    "host.spawn",
                    "host.daemon",
                ),
            ),
            (
                "REVIEW",
                (
                    "slop_",
                    "project.slop",
                    "feedback",
                    "project_feedback",
                    "project.feedback",
                ),
            ),
            ("MEMORY", ("project.memory", "project_memory", "shared_memory", "memory")),
            ("TRANSFER", ("transfer", "agent_attachment")),
            ("PROJECT", ("project", "fs_")),
            ("CONTENT", ("skill", "claude_artifact", "agents.stored")),
            ("WORKFLOW", ("workflow", "agent_workflow")),
            ("ROLE", ("role_", "agent_role")),
            ("ACCESS", ("user.", "admin.user", "passkey")),
            ("QUOTA", ("quota", "usage", "chatgpt.usage")),
            ("SCHEDULE", ("schedule", "watchdog")),
            ("ACCOUNT", ("accounts.", "auth.")),
            ("HOST", ("host_", "host.")),
            ("LIVE", ("transport.", "control_state", "topology")),
            ("CONNECTOR", ("connector",)),
            ("SECRET", ("secret",)),
            ("MCP", ("resource_",)),
            ("ADVISOR", ("advisor", "chatty")),
            ("COMPANION", ("companion",)),
            ("MESSAGING", ("agent_room_chat", "agent_chat.")),
            (
                "SESSION",
                (
                    "agent_self",
                    "agent_task_result",
                    "agent_work_state",
                    "agent_session",
                    "agent_portal",
                    "agent_receiver",
                    "agent_fresh",
                    "agent_translate",
                ),
            ),
            ("MESSAGING", ("agent_",)),
            ("GATEWAY", ("api_key", "apikey", "gateway")),
        )
        if word.startswith("agent_room_chat"):
            return "MESSAGING"
        for name, prefixes in ordered:
            if word.startswith(prefixes):
                return name
        return prior
    if kind == "SSE handler":
        if "watchdogs" in path:
            return "SCHEDULE"
        if "chatty" in path:
            return "ADVISOR"
        if "companion" in path:
            return "COMPANION"
        if "agent-sessions" in path:
            return "SESSION"
        return "GATEWAY"
    if kind in {"HTTP", "Web page", "Legacy bookmark"}:
        url = key.rsplit(" ", 1)[-1] if kind == "HTTP" else key
        if kind == "HTTP":
            if not url.startswith("/admin/"):
                for component, group in (
                    ("/agent-messaging/coordination", "COORD"),
                    ("/agent-messaging/roles", "ROLE"),
                    ("/agent-messaging/workflows", "WORKFLOW"),
                    ("/agent-room-chat", "MESSAGING"),
                    ("/agent-messaging/", "MESSAGING"),
                    ("/agent-chat", "SESSION"),
                    ("/agent-receiver", "SESSION"),
                    ("/agent-portal/", "SESSION"),
                    ("/host-daemon", "DAEMON"),
                    ("/host-spawn", "DAEMON"),
                    ("/watchdogs", "SCHEDULE"),
                    ("/schedules/", "SCHEDULE"),
                    ("/communicator", "LIVE"),
                    ("/model-defaults", "CONFIG"),
                    ("/transfers/", "TRANSFER"),
                    ("/session-housekeeping", "OPS"),
                    ("/rtk", "OPS"),
                ):
                    if component in path:
                        return group
            if url.startswith(("/oauth", "/.well-known/", "/connectors")):
                return "CONNECTOR"
            if url.startswith(("/auth", "/claude/auth", "/grok/auth", "/kimi/auth")):
                return "ACCOUNT"
            if url.startswith(("/v1/", "/anthropic/v1/", "/grok/v1/", "/kimi/v1/")):
                return "GATEWAY"
        if url.startswith("/admin/"):
            parts = url.split("/")[2:]
            groups = {
                "OWNER": "",
                "ACCESS": "login password account people users passkeys authorization auth",
                "DAEMON": "host-daemons host-spawn daemon-sessions",
                "SESSION": "agents agent-sessions agent-supervisor agent-portal",
                "MESSAGING": "agent-chat agent-messaging address-form",
                "CONTENT": "library agents-generation-mode agent-policy-profiles skills skill-sources",
                "QUOTA": "limits quota-policy quota-mode",
                "GATEWAY": "api api-keys api-keys-in-chat openai",
                "EXTERNAL": "external-clients",
                "CONFIG": "config model-defaults model-policy cdx-silent",
                "ENGINE": "engines codex-version versions auto-update model-tier-check subagent-model-selection",
                "ACCOUNT": "accounts runner",
                "TRANSFER": "transfers",
                "ADVISOR": "chatty",
                "STATIC": "manual * [...legacy]",
                "HOST": "hosts insecure-domain-allows insecure-approval insecure-approvals reverse-dns prune-policy",
                "LIVE": "communicator communicators topology ws overview dashboard activity",
                "MEMORY": "memories",
                "SETUP": "setup",
                "REVIEW": "reports feedback slop-jobs",
                "SCHEDULE": "schedules watchdogs",
                "GIT": "git-director",
                "SECRET": "secrets",
                "ROLE": "roles",
                "WORKFLOW": "workflows workflow-runs workflow-definitions",
                "COMPANION": "companion",
                "PROJECT": "projects project-board",
                "CONNECTOR": "connectors",
                "INSTALL": "wrapper",
                "OPS": "settings logs response-verbosity rtk server-retention session-housekeeping speech-input theme toasts",
            }
            if kind == "HTTP" and parts[0] == "agents":
                return "CONTENT"
            if len(parts) > 2 and parts[0] == "hosts":
                operation = parts[2]
                if operation in ("daemon", "spawn"):
                    return "DAEMON"
                if operation in ("installer", "wrapper-canary"):
                    return "INSTALL"
                if operation in ("model", "browseros-mcp"):
                    return "CONFIG"
                if (
                    operation in ("auto-update", "engines")
                    or operation.endswith("-version")
                    and operation != "agents-version"
                ):
                    return "ENGINE"
                if operation in ("agents-extra", "agents-version"):
                    return "CONTENT"
                if operation in ("rtk", "session-housekeeping"):
                    return "OPS"
            if len(parts) > 2 and parts[0] == "accounts" and any("quota" in x or "usage" in x for x in parts[2:]):
                return "QUOTA"
            if len(parts) > 2 and parts[0] == "projects" and parts[2] in ("reports", "feedback", "slop", "slop-jobs"):
                return "REVIEW"
            if parts[0] in ("grok", "claude", "kimi"):
                if "settings" in parts or "config" in parts:
                    return "CONFIG"
                if any("key" in x or "proxy" in x for x in parts):
                    return "GATEWAY"
                if any("usage" in x for x in parts):
                    return "QUOTA"
                if any("auth" in x for x in parts):
                    return "ACCOUNT"
                return "ENGINE"
            for n, words in groups.items():
                if parts[0] in words.split():
                    return n
        if "/agent-messaging/coordination" in path:
            return "COORD"
        if "/agent-messaging/roles" in path:
            return "ROLE"
        if "/agent-messaging/workflows" in path:
            return "WORKFLOW"
        if "/projects-mcp/" in path or "/projects-client/" in path:
            return "PROJECT"
        if url.startswith("/wrapper/") or url.startswith(("/install/", "/seed/", "/rescue/")):
            return "INSTALL"
        if url.startswith("/external/"):
            return "EXTERNAL"
        if url.startswith("/sync"):
            return "CONFIG"
    if kind in ("UI component", "Dialog / sheet", "Tab / navigation") and "/components/" in path:
        top = path.split("/components/")[1].split("/")[0]
        domains = {
            "accounts": "ACCOUNT",
            "account": "ACCESS",
            "admins": "ACCESS",
            "users": "ACCESS",
            "projects": "PROJECT",
            "workflows": "WORKFLOW",
            "hosts": "HOST",
            "setup": "SETUP",
            "library": "CONTENT",
            "memories": "MEMORY",
            "authoring": "CONTENT",
            "agent-messaging": "MESSAGING",
            "agent-chat": "SESSION",
            "api-keys": "GATEWAY",
            "feedback": "REVIEW",
            "dashboard": "LIVE",
            "chatty": "ADVISOR",
            "transfers": "TRANSFER",
            "secrets": "SECRET",
            "external-clients": "EXTERNAL",
            "schedules": "SCHEDULE",
            "portal": "SESSION",
            "engines": "ENGINE",
            "settings": "OPS",
            "manual": "STATIC",
            "quota": "QUOTA",
            "roles": "ROLE",
            "topology": "LIVE",
            "git-director": "GIT",
            "layout": "STATIC",
            "command-palette": "STATIC",
            "shortcuts": "STATIC",
            "page": "STATIC",
            "auth": "ACCESS",
        }
        return domains.get(top, prior)
    if path.startswith("media-worker/") or "speech-input" in path:
        return "MEDIA"
    if path.startswith("caddy/"):
        return "INGRESS"
    if path.startswith("slop-worker/"):
        return "REVIEW"
    if path.startswith("advisor/"):
        return "ADVISOR"
    if path.startswith("plasmoid/"):
        return "PLASMA"
    if path.startswith("mobile/"):
        return "COMPANION"
    return prior


def at(path, key, matcher=None):
    for m in (matcher or re.compile(re.escape(key))).finditer(read(path)):
        return loc(path, m.start())
    return path


WS_TABLE = "frontend/src/lib/ws/events.ts"
MANIFEST = "mobile/android/app/src/main/AndroidManifest.xml"


def ws_dispatch():
    """Read the default key table only. Runtime-selected keys have separate dispatch."""
    source = read(WS_TABLE)
    start = source.index("{", source.index("export const DEFAULT_INVALIDATIONS"))
    end = source.index("\n};", start)
    body = source[start + 1:end]
    fields = list(re.finditer(r"""^[ \t]*(["'])([\w.:-]+)\1\s*:\s*""", body, re.M))
    scoped = re.search(r"const PROJECT_SCOPED_EVENTS = new Set<string>\(\[(.*?)\]\)", source, re.S)
    project_events = set(re.findall(r"""^\s*["']([\w.:-]+)["'],""", scoped[1], re.M)) if scoped else set()
    payload_selector = re.search(r"""event\.type === ["']([\w.:-]+)["'] \? (\w+\(event\.payload\)) : invalidations\[event\.type\]""", source)
    result = {}
    for i, field in enumerate(fields):
        name = field[2]
        value = body[field.end():fields[i + 1].start() if i + 1 < len(fields) else len(body)]
        value = re.sub(r"^\s*//[^\n]*", "", value, flags=re.M).strip().removesuffix(",")
        try:
            keys = ast.literal_eval(value)
            static = isinstance(keys, list) and all(isinstance(k, list) and all(isinstance(s, str) for s in k) for k in keys)
        except (ValueError, SyntaxError):
            static = False
        if payload_selector and name == payload_selector[1]:
            detail = payload_selector[2] + " selects query keys at runtime"
        elif static:
            detail = "default query prefixes " + json.dumps(keys, ensure_ascii=False, separators=(",", ":"))
        else:
            detail = "query keys from runtime expression in DEFAULT_INVALIDATIONS"
        if name in project_events:
            detail += ", also project detail via payload slug and projectDetailSubKey"
        result[name] = (loc(WS_TABLE, start + 1 + field.start(2)), detail)
    toast = re.search(r"""if\s*\(event\.type === "toast"\)\s*\{\s*showServerToast\(event\.payload\)""", source)
    if toast:
        result["toast"] = (loc(WS_TABLE, toast.start()), "showServerToast(event.payload) dispatches the validated notification")
    return result


def runner_routes(path):
    """Use Python decorator/handler ownership, including routes inside register_chatty."""
    def walk(node, parents):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                symbol = ".".join([*parents, child.name])
                for decorator in child.decorator_list:
                    if not (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)
                            and isinstance(decorator.func.value, ast.Name) and decorator.func.value.id in ("app", "router")
                            and decorator.func.attr in {"get", "post", "put", "delete", "patch"}
                            and decorator.args and isinstance(decorator.args[0], ast.Constant)
                            and isinstance(decorator.args[0].value, str)):
                        continue
                    yield decorator.func.attr.upper(), decorator.args[0].value, decorator.lineno, f"{symbol} ({path}:{child.lineno})"
                yield from walk(child, [*parents, child.name])
            else:
                yield from walk(child, parents)
    return walk(ast.parse(read(path)), [])


def startup_target(path, name):
    for item in re.finditer(r"""import\s*\{([^{}]+)\}\s*from\s*['"]([^'"]+)['"]""", read(path)):
        if name not in (part.strip() for part in item[1].split(",")):
            continue
        target = resolve_js(path, item[2])
        if target:
            declaration = re.search(r"\b(?:function|const)\s+" + re.escape(name) + r"\b", read(target))
            return name + " in " + (loc(target, declaration.start()) if declaration else target)
    return name + " called at startup; implementation not statically resolved"


def android_dispatch(symbol, path, pos, files, manifest):
    manifest_ref = manifest.get(symbol)
    if manifest_ref:
        tag, source = manifest_ref
        return f"Android manifest {tag} {symbol} ({source})"
    line = read(path)[read(path).rfind("\n", 0, pos) + 1:read(path).find("\n", pos)]
    frame = re.search(r"\)\s*:\s*(\w+)\s*$", line)
    # Two Kotlin types named RoomActivity exist: one is a qualified LiveFrame case.
    prefix = re.escape(frame[1]) + r"\." if frame else r"(?<![\w.])"
    call = re.compile(prefix + re.escape(symbol) + r"\s*\(")
    references = []
    for other in files:
        for match in call.finditer(read(other)):
            before = read(other)[read(other).rfind("\n", 0, match.start()) + 1:match.start()]
            if not re.search(r"\b(?:fun|class)\s+$", before):
                references.append(loc(other, match.start()))
    role = "data class" if "data class" in line else "Compose screen" if "@Composable" in read(path)[max(0, pos - 150):pos] else "Kotlin declaration"
    return role + " " + symbol + (" referenced at " + ", ".join(references[:2]) if references else " (caller not statically resolved)")


def yaml_members(path, section):
    """Direct child identifiers of a conventional GitHub jobs / Compose services map."""
    block = re.search(r"^" + section + r":\s*\n((?:[ \t].*\n|\n|#.*\n)*)", read(path), re.M)
    return re.findall(r"^  ([\w.-]+):\s*(?:#.*)?$", block[1], re.M) if block else []


def instance_dispatch(path, package_scripts):
    body = read(path)
    if path.startswith(".github/workflows/"):
        return "GitHub Actions jobs: " + ", ".join(yaml_members(path, "jobs"))
    if path == "docker-compose.yml":
        return "Compose services: " + ", ".join(yaml_members(path, "services"))
    if path == "Dockerfile":
        return "runtime " + " ".join(re.findall(r"^(?:ENTRYPOINT|CMD)\s+[^\n]+", body, re.M))
    if path == "wrappers/Makefile":
        targets = re.findall(r"^([\w-]+):(?!=)", body, re.M)
        return "make -C wrappers targets: " + ", ".join(targets)
    if path in package_scripts:
        return "npm scripts: " + ", ".join(package_scripts[path])
    if path.endswith(".ansi"):
        reader = "frontend/scripts/readme-shots/capture.ts"
        return "terminal transcript read by persona at " + at(reader, "${persona}.ansi")
    if path.endswith(".md"):
        consumer = "scripts/check-engine-parity.py"
        if Path(path).name in read(consumer):
            return "parity-check input referenced at " + at(consumer, Path(path).name)
        return "operator documentation " + path
    if path.endswith(".py"):
        tree = ast.parse(body)
        for node in tree.body:
            if isinstance(node, ast.If) and "__name__" in ast.unparse(node.test):
                functions = {f.name for f in tree.body if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef))}
                calls = [call.func.id for call in ast.walk(node) if isinstance(call, ast.Call)
                         and isinstance(call.func, ast.Name) and call.func.id in functions]
                return f"Python __main__ at {path}:{node.lineno}" + (", local calls " + ", ".join(dict.fromkeys(calls)) if calls else "")
        return "Python module entry " + path
    if body.startswith("#!") and ("sh" in body.splitlines()[0] or path.startswith("bin/")):
        main = re.search(r'^main "\$@"', body, re.M)
        if main:
            return "shell main() at " + loc(path, main.start())
        case = re.search(r'^case "\$\{?1[^\n]*\n((?:[^\n]*\n)*?)esac\b', body, re.M)
        if case:
            arms = re.findall(r"^\s*([\w|-]+)\)", case[1], re.M)
            return "shell argument dispatch " + ", ".join(arms) + " at " + loc(path, case.start())
        if path.startswith("bin/lib/"):
            sources = []
            for caller in ("bin/orchestrator", "bin/install.sh", "scripts/deploy.sh"):
                match = re.search(r"^(?:source|\.)\s+[^\n]*?/" + re.escape(Path(path).name), read(caller), re.M)
                if match:
                    sources.append(loc(caller, match.start()))
            functions = re.findall(r"^([\w-]+)\(\)\s*\{", body, re.M)
            options = re.findall(r'\[\[ [^\n]*?== (--[\w-]+) \]\]', body)
            return (f"shell library {path}" + (", sourced at " + ", ".join(sources) if sources else "")
                    + (", functions " + ", ".join(functions[:4]) if functions else "")
                    + (", direct argument " + ", ".join(options) if options else ""))
        entry = re.search(r'^exec[ \t]+(?![0-9]*[<>])[^\n]+', body, re.M)
        return body.splitlines()[0][2:] + " " + path + (", " + entry[0].strip() if entry else " (top-level shell entry)")
    exports = re.findall(r"^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)", body, re.M)
    if exports:
        return "exports " + ", ".join(exports) + " from " + path
    main = re.search(r"^main\(\)", body, re.M)
    return "main() at " + loc(path, main.start()) if main else "top-level module entry " + path


def route_calls(locations):
    """Read actual call sites inside the registered route callback using the project's TS parser."""
    program = r"""
const fs = require('node:fs'), path = require('node:path'), ts = require('./api/node_modules/typescript');
const refs = JSON.parse(fs.readFileSync(0,'utf8')), byFile = new Map(), out = {};
for (const ref of refs) {
  const match = ref.match(/^(.*):([0-9]+)$/);
  if (!match || !fs.existsSync(match[1])) continue;
  if (!byFile.has(match[1])) byFile.set(match[1], []);
  byFile.get(match[1]).push([ref,Number(match[2])]);
}
const program = ts.createProgram([...byFile.keys()], {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
});
const checker = program.getTypeChecker();
const schemaFile = path.resolve('api/src/db/schema.ts');
function sqlTableName(operand) {
  if (!operand || !(ts.isIdentifier(operand) || ts.isPropertyAccessExpression(operand))) return;
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(operand) ? operand.name : operand);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const decl = symbol?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || path.resolve(decl.getSourceFile().fileName) !== schemaFile) return;
  const init = decl.initializer;
  if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'mysqlTable' &&
      init.arguments[0] && ts.isStringLiteral(init.arguments[0])) return init.arguments[0].text;
}
for (const [file,items] of byFile) {
  const src = program.getSourceFile(file);
  const line = at => src.getLineAndCharacterOfPosition(at).line+1;
  const routes=[];
  function find(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        /^(app|fastify|server|scope|instance)$/.test(node.expression.expression.getText(src)) &&
        /^(get|post|delete|put|patch|head|options|route|all)$/.test(node.expression.name.text)) routes.push(node);
    ts.forEachChild(node,find);
  }
  find(src);
  for (const [ref,n] of items) {
    const route = routes.find(node => line(node.getStart(src))===n) ||
      routes.find(node=>line(node.getStart(src))<=n && n<=line(node.end));
    if (!route) continue;
    const calls=new Set(), db=new Set();
    function body(node) {
      if (ts.isCallExpression(node)) {
        const e=node.expression, text=e.getText(src);
        if (ts.isPropertyAccessExpression(e)) {
          if (/^(from|insert|update|delete)$/.test(e.name.text)) {
            const table = sqlTableName(node.arguments[0]);
            if (table) db.add(table);
          }
          if (/^(?:ctx\.\w+|\w+)\.\w+$/.test(text) &&
              !/^(?:app|scope|reply|req|request|Date|Object|Array|String|Number|Math|Promise|Buffer|JSON|res|query|headers|url|z|params|schema|process|logger|data|payload|console|result|body|rows|raw|map|response)\./.test(text) &&
              !/\.(?:map|filter|includes|toString|trim|find|join|push|has|some|every|send|code|header|parse|safeParse|catch|then)$/.test(text)) calls.add(text);
        } else if (ts.isIdentifier(e) && /^(?:assert|require|register|read|list|create|store|update|delete|set|get|enqueue|verify|submit|format|send|resolve|build|prepare|record|issue|check|fetch|change|save|wait|stream)[A-Z]/.test(text)) calls.add(text);
      }
      ts.forEachChild(node,body);
    }
    for (const arg of route.arguments) {
      if (ts.isArrowFunction(arg)||ts.isFunctionExpression(arg)) body(arg.body);
      else if (ts.isIdentifier(arg)) calls.add(arg.text);
    }
    const parts=[];if(calls.size)parts.push('calls: '+Array.from(calls).join(', '));if(db.size)parts.push('Drizzle tables: '+Array.from(db).join(', '));
    if(parts.length)out[ref]=parts.join(' / ');
  }
}
process.stdout.write(JSON.stringify(out));
"""
    return json.loads(subprocess.check_output(["node", "-e", program], input=json.dumps(sorted(locations)), text=True))


def entries(route_capture=None, fleet_capture=None):
    with ENTRY.open() as source:
        old = list(csv.DictReader(source, delimiter="\t"))
    if fleet_capture:
        catalog = json.loads(Path(fleet_capture).read_text())
        names = set()
        groups = {row["Entry or action"]: row["Family"] for row in old if row["Entry kind"] == "Fleet MCP"}
        old = [row for row in old if row["Entry kind"] != "Fleet MCP"]
        for tool in catalog:
            name = tool["name"]
            capability = tool["capability"]
            if name in names or capability not in {"host", "operator"}:
                raise ValueError(f"Invalid fleet MCP catalog entry: {name}, {capability}")
            names.add(name)
            old.append({
                "Entry kind": "Fleet MCP",
                "Entry or action": name,
                "Registration / source": "api/src/services/mcp-tools.ts",
                "Guard / scope": capability,
                "Effect or dispatch": tool["description"],
                "Evidence": "authenticated tools/list with host and operator credentials",
                "Family": groups.get(name, "TOOLS"),
            })
        if not names:
            raise ValueError("Empty fleet MCP catalog")
    if route_capture:
        known = {r["Entry or action"]: r["Family"] for r in old if r["Entry kind"] == "HTTP"}
        old = [r for r in old if r["Entry kind"] != "HTTP"]
        for route in json.loads(Path(route_capture).read_text()):
            source = route.get("source") or (
                "api/src/server.ts" if route["url"] == "*" else "api/src/routes/admin/pages/static.ts"
            )
            methods = route["method"] if isinstance(route["method"], list) else [route["method"]]
            for method in methods:
                key = method + " " + route["url"]
                guard = route.get("guard") or {}
                old.append(
                    {
                        "Family": known.get(key, "TOOLS"),
                        "Entry kind": "HTTP",
                        "Entry or action": key,
                        "Registration / source": source,
                        "Guard / scope": "; ".join(
                            filter(
                                None,
                                [
                                    guard.get("capability") or guard.get("kind") or "handler contract",
                                    *route.get("handlers", []),
                                    "ADMIN_WS_ENABLED" if route["url"] == "/admin/ws" else None,
                                ],
                            )
                        ),
                        "Effect or dispatch": route.get("owner") or "",
                        "Evidence": ("Fastify onRoute at boot; HTTP HEAD for WebSocket-only GET"
                                     if method == "HEAD" and route.get("websocket") else "Fastify onRoute at boot"),
                    }
                )
    calls = route_calls({r["Registration / source"] for r in old if r["Entry kind"] == "HTTP"})
    result = set()
    ws_targets = ws_dispatch()
    kotlin = sorted(p for p in FILES if p.startswith("mobile/android/app/src/main/java/") and p.endswith(".kt"))
    manifest = {}
    for element in ET.fromstring(read(MANIFEST)).iter():
        name = element.get("{http://schemas.android.com/apk/res/android}name", "")
        if name.startswith("."):
            manifest[name[1:]] = (element.tag, at(MANIFEST, 'android:name="' + name + '"'))
    package_scripts = defaultdict(list)
    for package in ("api", "frontend"):
        for command, script in json.loads(read(package + "/package.json"))["scripts"].items():
            for script_path in re.findall(r"(?<![\w/])(?:\./)?(scripts/[\w./-]+\.(?:ts|mjs|py|sh))\b", script):
                package_scripts[f"{package}/{script_path}"].append(f"{package}/package.json → npm run {command}")

    def add(kind, key, path, guard, detail, evidence, group="TOOLS"):
        result.add((family(kind, key, path, group), kind, key, path, guard, detail, evidence))

    old_groups = {}
    for r in old:
        kind, key, path = (r[n] for n in ("Entry kind", "Entry or action", "Registration / source"))
        if kind in (
            "HTTP",
            "Web page",
            "UI component",
            "Owner / maintenance",
            "Owner/background",
        ):
            old_groups.setdefault(path.split(":")[0], r["Family"])
        if kind not in ("HTTP", "Local MCP", "Fleet MCP"):
            continue
        source = path.replace("api/src/server.ts (CORS OPTIONS)", "api/src/server.ts")
        if kind == "Fleet MCP":
            src = "api/src/services/mcp-tools.ts"
            source = at(src, key, re.compile(r"\bname:\s*'" + re.escape(key) + "'"))
            if ":" not in source:
                definitions = [
                    p
                    for p in FILES
                    if p.startswith("api/src/services/")
                    and p.endswith(".ts")
                    and p != src
                    and re.search(
                        r"""(?:name["']?\s*:\s*|^\s*)["']""" + re.escape(key) + r"""["']""",
                        read(p),
                        re.M,
                    )
                ]
                if definitions:
                    source = at(sorted(definitions)[0], key)
        if kind == "Local MCP":
            candidates = sorted(
                p
                for p in FILES
                if p.startswith("wrappers/cxx/internal/agentbus/")
                and p.endswith(".go")
                and not p.endswith("_test.go")
                and '"' + key + '"' in read(p)
            )
            if candidates:
                src = next(
                    (p for p in candidates if 'tool("' + key + '"' in read(p)),
                    candidates[0],
                )
                source = at(src, '"' + key + '"')
            else:
                source = "wrappers/cxx/internal/agentbus/mcp.go"
        gate = r["Guard / scope"]
        if key.split(" ")[-1] in (
            "/admin/external-clients",
            "/admin/logs",
        ) and key.startswith(("GET ", "HEAD ")):
            gate = gate.split(";")[0] + "; browser HTML negotiation, JSON session/capability"
        detail = r["Effect or dispatch"]
        if kind == "HTTP":
            if "HTTP HEAD for WebSocket-only GET" in r["Evidence"]:
                detail = "api/src/ws/transport.ts: ordinary HEAD runs admission, then returns empty 404"
            else:
                detail = calls.get(source) or "inline handler/plugin; inspect cited registration"
        add(kind, key, source, gate, detail, r["Evidence"], r["Family"])

    def code(
        kind,
        key,
        path,
        pos=0,
        detail="",
        group=None,
        guard="enclosing caller/route",
        evidence="static source",
    ):
        group = group or old_groups.get(path, "TOOLS")
        add(kind, key, loc(path, pos), guard, detail, evidence, group)

    for path in sorted(FILES):
        kind = CLASS[path]
        if kind in (
            "test / fixture",
            "third-party / bundled tooling",
            "built SPA artifact",
        ) or path.startswith("docs/"):
            continue
        if path.startswith("frontend/src/") and path.endswith(".svelte"):
            body = read(path)
            if path.endswith("/+page.svelte"):
                parts = Path(path).parent.relative_to("frontend/src/routes").parts
                url = "/admin" + "".join("/" + x for x in parts if not x.startswith("("))
                code(
                    "Web page",
                    url,
                    path,
                    detail="SvelteKit route; tabs/dialogs below",
                    evidence="real browser navigation, 42/42; fixture actions have separate scope",
                )
            if "/components/" in path and "/components/ui/" not in path:
                code(
                    "UI component",
                    Path(path).stem,
                    path,
                    detail="see importing module in module index",
                )
            if "/components/ui/" not in path:
                for m in re.finditer(
                    r"<((?:(?:Alert)?Dialog|Sheet|Drawer)\.(?:Root|Content)|Tabs\.Trigger|TabNav)\b([^>]*?)>",
                    body,
                    re.S,
                ):
                    name, attrs = m.groups()
                    if name.endswith("Content"):
                        continue
                    val = re.search(r'\b(?:value|aria-label)=(?:"([^"]*)"|\{([^}]+)\})', attrs)
                    label = (val[1] or "{" + val[2] + "}") if val else name
                    code(
                        "Tab / navigation" if name in ("Tabs.Trigger", "TabNav") else "Dialog / sheet",
                        label,
                        path,
                        m.start(),
                        detail="reachable through enclosing page/component",
                    )
        if path.startswith("api/src/ops/") and path.endswith(".ts"):
            code(
                "Owner / maintenance",
                Path(path).stem,
                path,
                detail="see module index for boot path vs operator entry",
            )
        if (
            path.startswith(("media-worker/", "advisor/", "slop-worker/", "caddy/", "plasmoid/"))
            and kind != "documentation / repository metadata"
        ):
            code(
                "Deployment component",
                Path(path).name,
                path,
                detail="container, composed ingress, or KDE package",
                guard="operator or isolated service",
            )
        if path.startswith(
            (
                "bin/",
                "scripts/",
                ".github/workflows/",
                "api/scripts/",
                "frontend/scripts/",
                "wrappers/scripts/",
            )
        ) or path in ("docker-compose.yml", "Dockerfile", "wrappers/Makefile"):
            code("Instance / build / CI", Path(path).name, path, guard="operator or CI", detail=instance_dispatch(path, package_scripts))
        if path.startswith("runner/") and path.endswith(".py") and kind == "source":
            for method, url, line, handler in runner_routes(path):
                group = (
                    "ACCOUNT"
                    if "verify" in url
                    else "ADVISOR"
                    if "chatty" in path
                    else "GATEWAY"
                    if "exec" in url
                    else "CONTENT"
                )
                add(
                    "Runner HTTP",
                    method + " " + url, f"{path}:{line}",
                    "internal runner route; method-specific gate in handler",
                    handler, "static Python route decorator and function", group,
                )
        if path.startswith("api/src/") and path.endswith(".ts"):
            for m in re.finditer(r"""(?:\bwsPublisher|\bws)\.publish\(\s*['"]([^'"]+)['"]""", read(path)):
                if m[1] in EVENT_NAMES:
                    target = ws_targets.get(m[1])
                    code(
                        "WS publish",
                        m[1],
                        path,
                        m.start(),
                        group="LIVE",
                        guard="publisher; subscriber scope checked at transport",
                        detail=m[0].split("(", 1)[0] + " → " + (
                            target[1] + " (" + target[0] + ")" if target else
                            "event " + m[1] + ", no static default SPA query mapping"
                        ),
                    )
            for m in re.finditer(r"""(?:['"])text/event-stream(?:;[^'"]*)?['"]""", read(path)):
                code(
                    "SSE handler",
                    Path(path).parent.name + " / " + Path(path).stem,
                    path,
                    m.start(),
                    group="GATEWAY" if "/stream/" in path else old_groups.get(path, "LIVE"),
                    detail="stream/opening headers; route capability in matching HTTP entry",
                )
        if path.startswith("mobile/android/app/src/main/java/") and path.endswith(".kt"):
            for m in re.finditer(
                r"\b(?:class|fun)\s+(\w+(?:Activity|Worker|Screen|Service|Receiver))\b",
                read(path),
            ):
                code(
                    "Android component",
                    m[1],
                    path,
                    m.start(),
                    group="COMPANION",
                    guard="manifest or Compose caller",
                    detail=android_dispatch(m[1], path, m.start(), kotlin, manifest),
                )
    resource = "api/src/services/mcp-resources.ts"
    for m in re.finditer(r"\x60([a-z]+://<[^\x60]+)\x60", read(resource).split("*/", 1)[0]):
        key = m[1]
        scheme = key.split("://")[0]
        branch = at(resource, "scheme === '" + scheme + "'")
        add(
            "MCP resource URI",
            key,
            branch,
            "host feature, resource scope and operation-specific validation",
            "parser and CRUD implementation; " + loc(resource, m.start()),
            "declared URI templates and concrete parser branches",
            {"project": "PROJECT", "skill": "CONTENT"}.get(scheme, "MEMORY"),
        )
    for path in ["api/src/server.ts", "api/src/ops/owner-composition.ts"]:
        for m in re.finditer(r"^\s*(?:const [\w]+ = (?:await )?)?(start[A-Z]\w+)\(", read(path), re.M):
            name = m[1]
            group = next(
                (
                    v
                    for k, v in [
                        ("Usage", "QUOTA"),
                        ("Quota", "QUOTA"),
                        ("Slop", "REVIEW"),
                        ("Feedback", "REVIEW"),
                        ("Schedule", "SCHEDULE"),
                        ("Auth", "ACCOUNT"),
                        ("Media", "MEDIA"),
                        ("Transfer", "TRANSFER"),
                        ("Messaging", "MESSAGING"),
                        ("Portal", "SESSION"),
                        ("Wrapper", "INSTALL"),
                    ]
                    if k in name
                ),
                "OWNER",
            )
            code(
                "Startup hook",
                name,
                path,
                m.start(),
                group=group,
                guard="ready owner / feature-specific boot condition",
                detail=startup_target(path, name),
            )
    for path in sorted(p for p in FILES if p.startswith("frontend/src/") and p.endswith(".svelte")):
        for m in re.finditer(r"<ConfirmDialog\b([^>]*?)>", read(path), re.S):
            attrs = " ".join(m[1].split())
            title = re.search(r'\b(?:title|confirmLabel)=(?:"([^"]*)"|\{([^}]+)\})', attrs)
            name = (title[1] or title[2]) if title else "ConfirmDialog"
            code(
                "Confirmation",
                name,
                path,
                m.start(),
                detail="confirmation at action site",
            )
    catalog = "api/src/services/connectors/catalog.ts"
    for m in re.finditer(r"^      ([a-z][a-z0-9_]+): \{\s*$", read(catalog), re.M):
        code(
            "Connector MCP",
            m[1],
            catalog,
            m.start(),
            group="CONNECTOR",
            guard="connector OAuth token and per-operation policy",
            detail="operation schema, mode and execution in source",
        )
    event_path = "api/src/ws/events.ts"
    for name in EVENT_NAMES:
        target = ws_targets.get(name)
        add(
            "Admin event",
            name,
            at(event_path, "'" + name + "'"),
            "admin WebSocket scope",
            target[1] + " (" + target[0] + ")" if target else "event catalog; no static default SPA query mapping",
            "registered event; explicit publishers indexed separately",
            "LIVE",
        )
    for name, (source, effect) in ws_targets.items():
        add(
            "WS consumer", name, source, "authenticated WebSocket; client cache generation",
            effect, "static SPA event dispatch", "LIVE",
        )
    # These are data-driven surfaces. The owning declaration is the entrypoint rather
    # than the generic <Tabs.Trigger value={...}> component repeated for each option.
    tab_sources = [
        ("frontend/src/routes/account/+page.svelte", r'\bvalue:\s*"([^"]+)"', "ACCESS"),
        (
            "frontend/src/lib/components/settings/settings-anchors.ts",
            r'^\s{2}(?:"([^"]+)"|([\w-]+)):\s*"',
            "OPS",
        ),
        (
            "frontend/src/lib/components/projects/ProjectTabsNav.svelte",
            r'\blabel:\s*"([^"]+)"',
            "PROJECT",
        ),
        ("frontend/src/lib/legacy-admin-routes.ts", r'^\s*case "([^"]+)"', "STATIC"),
    ]
    for path, pattern, grp in tab_sources:
        for m in re.finditer(pattern, read(path), re.M):
            key = next(x for x in m.groups() if x)
            code(
                "Legacy bookmark" if grp == "STATIC" else "Navigation selection",
                key,
                path,
                m.start(),
                group=grp,
                detail="conditional branch; see enclosing route, hash or query",
            )
    for engine in ("codex", "claude", "grok", "kimi"):
        page = "frontend/src/routes/(providers)/engines/+page.svelte"
        add(
            "Engine tab",
            engine,
            at(page, "value={engine}"),
            "session; engine settings",
            "engine tab and enabled / suspended state",
            "runtime-selected engine iteration",
            "ENGINE",
        )
    for alias, engine in zip(("cdx", "clx", "cgx", "ckx"), ("codex", "claude", "grok", "kimi")):
        path = "wrappers/cxx/cmd/cxx/main.go"
        add(
            "argv[0] alias",
            alias,
            at(path, '"' + alias + '"'),
            "assigned engine",
            engine,
            "Go multicall entrypoint and tests",
            "ENGINE",
        )
    result.update(go_cases())
    return sorted(result)


def go_cases():
    result = set()
    # Associate Go case labels only with actual argv/command switches. A switch on
    # a telemetry or model value isn't a command. Indentation identifies direct cases.
    switches = re.compile(r"^(\s*)switch\s+(.*)\{\s*(?://.*)?$", re.M)
    for path in SCOPE:
        if not path.endswith(".go"):
            continue
        body = read(path)
        for sw in switches.finditer(body):
            expr = sw[2].strip()
            if not re.search(
                r"\b(?:args|argv|subcommand|sub|cmd|command|action|serviceCommand|flag|arg)\b",
                expr,
            ):
                continue
            if len(expr) > 220:
                continue
            stop = re.search("^" + re.escape(sw[1]) + r"\}", body[sw.end() :], re.M)
            segment = body[sw.end() : sw.end() + stop.start()] if stop else ""
            for m in re.finditer("^" + re.escape(sw[1]) + r"case\s+([^:\n]+):", segment, re.M):
                for literal in re.findall(r'"([^"]+)"', m[1]):
                    result.add(
                        (
                            "TOOLS",
                            "CLI switch / option",
                            literal,
                            loc(path, sw.end() + m.start()),
                            "local process; downstream scope by operation",
                            expr,
                            "static, parent command and build targets in source/module index",
                        )
                    )
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--routes",
        help="fresh capture from an isolated Fastify onRoute hook (see matrix)",
    )
    parser.add_argument("--fleet-tools", help="combined tools/list catalog from the two authenticated MCP identities")
    parser.add_argument("--output-dir", type=Path, default=OUT, help="write indexes and matrix to a separate directory, using the repository captures as inputs")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows = module_rows()
    EVENT_NAMES = set(re.findall(r"^\s*'([\w.:-]+)'", read("api/src/ws/events.ts"), re.M))
    entry_rows = entries(args.routes, args.fleet_tools)
    missing = sorted({r[3].split(":")[0] for r in entry_rows if r[3].split(":")[0] not in FILES})
    if missing:
        raise SystemExit("Unresolved entrypoint locations: " + str(missing))
    narrative = (OUT / "orchestrator-functional-matrix.md").read_text()
    decisions = {
        c[0]: c[-1]
        for line in narrative.splitlines()
        if line.startswith("| ") and len(c := [v.strip() for v in line.split("|")[1:-1]]) == 9
    }
    for row in entry_rows:
        if row[0] not in decisions:
            raise SystemExit("Family missing from matrix: " + row[0])
    output_rows = [(*row, decisions[row[0]]) for row in entry_rows]
    tsv(
        args.output_dir / ENTRY.name,
        [
            "Family",
            "Entry kind",
            "Entry or action",
            "Registration / source",
            "Guard / scope",
            "Effect or dispatch",
            "Evidence",
            "Family product decision",
        ],
        output_rows,
    )
    tsv(
        args.output_dir / MODULE.name,
        [
            "Tracked path",
            "Classification",
            "Reachability",
            "Direct parent, root or package",
            "Build targets",
        ],
        rows,
        quoting=csv.QUOTE_ALL,
    )
    # Keep the narrative and counts in sync as declarations/registrations change.
    matrix = args.output_dir / "orchestrator-functional-matrix.md"
    marker = "## Inventory counts"
    narrative = narrative.split(marker)[0].rstrip()
    kinds = Counter(r[1] for r in entry_rows)
    classes = Counter(r[1] for r in rows)
    table = "\n\n" + marker + "\n\n"
    table += f"{len(entry_rows):,} operation and registration references across {len(set(r[0] for r in entry_rows))} indexed families. {len(rows):,} paths in the source inventory. A publisher site, method or conditional widget is a reference and may share a single product workflow.\n\n"
    table += "| Entry classification | References |\n|---|---:|\n" + "".join(
        f"| {k} | {n:,} |\n" for k, n in sorted(kinds.items())
    )
    table += "\n| Source classification | Paths |\n|---|---:|\n" + "".join(
        f"| {k} | {n:,} |\n" for k, n in sorted(classes.items())
    )
    matrix.write_text(narrative + table)
    print(f"{len(entry_rows)} operation and registration references; {len(rows)} versioned files")
