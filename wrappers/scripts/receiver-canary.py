#!/usr/bin/env python3
"""Opt-in real-model canary for the installed CLIs and a freshly built cxx.

Uses a temporary Unix broker and temporary working directory. No fleet messages
are sent: both receive sources supply ordinary messages and only correlated
model replies count as response evidence. Credentials stay with the native CLI.
"""
import argparse
import http.server
import json
import os
import pathlib
import pty
import re
import select
import signal
import shlex
import socketserver
import subprocess
import tempfile
import threading
import time
import sys
import uuid

# Mirrors wrappers/cxx/internal/agentportal/receiver.go. Claude Code keys a
# plugin-provided MCP server as `plugin:<plugin>:<server>` and normalises `:`
# to `_` for the `mcp__<server>__<tool>` identifier, so these three names move
# together or the canary approves tools that do not exist.
CLAUDE_PLUGIN = "cxx-receiver"
CLAUDE_CHANNEL = "plugin:" + CLAUDE_PLUGIN + "@inline"
CLAUDE_MCP_SERVER = "plugin_" + CLAUDE_PLUGIN + "_cxx-agent"

MANAGED_SETTINGS_DIR = ("/Library/Application Support/ClaudeCode" if sys.platform == "darwin"
                        else "/etc/claude-code")


def channel_approved():
    """Whether this host's managed settings approve the receiver plugin.

    The canary launches `claude` directly, so it cannot use the wrapper's
    drop-in installer; it asks the same question the wrapper does and takes the
    same fallback, which keeps it runnable on an unprivileged host.
    """
    path = pathlib.Path(MANAGED_SETTINGS_DIR) / "managed-settings.d" / "50-cxx-channels.json"
    try:
        policy = json.loads(path.read_text())
    except (OSError, ValueError):
        return False
    return policy.get("channelsEnabled") is True and any(
        entry.get("plugin") == CLAUDE_PLUGIN for entry in policy.get("allowedChannelPlugins", []))


def run(engine, cxx, timeout):
    with tempfile.TemporaryDirectory(prefix="cxx-receiver-canary-") as tmp:
        receiver_log = pathlib.Path(tmp) / "receiver.log"
        shim = pathlib.Path(tmp) / "cxx-shim"
        shim.write_text("#!/bin/sh\nexec " + shlex.quote(cxx) + " \"$@\" 2>" + shlex.quote(str(receiver_log)) + "\n")
        shim.chmod(0o700)
        cxx = str(shim)
        session = str(uuid.uuid4())
        native = str(uuid.uuid4())
        broker = str(pathlib.Path(tmp) / "portal.sock")
        sock = str(pathlib.Path(tmp) / "codex.sock")
        healthy = False
        sources = ("peer", "portal")
        message_ids = {s: str(uuid.uuid4()) for s in sources}
        receipts = {s: "canary-" + str(uuid.uuid4()) for s in sources}
        submitted = set()
        replied = set()
        native_reported = False
        reconnect_requested = False
        reconnected = False
        completed_replies = []
        registered = None
        failure = None
        operations = {}
        lock = threading.Lock()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                nonlocal registered, failure, native_reported, reconnect_requested, reconnected, completed_replies, healthy
                data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or "{}")
                op = self.path.rsplit("/", 1)[-1]
                out, status = {}, 200
                with lock:
                    operations[op] = operations.get(op, 0) + 1
                    if os.environ.get("CXX_CANARY_DEBUG") == "1" and op not in ("claim", "native", "heartbeat"):
                        print("broker", op, flush=True)
                    if op == "register":
                        if registered:
                            if not reconnect_requested or data["generation"] == registered["generation"] or data["native_session_id"] != registered["native_session_id"]:
                                failure = "reconnection lost its generation or native conversation binding"
                            reconnected = True
                            message_ids.update({s: str(uuid.uuid4()) for s in sources})
                            receipts.update({s: "canary-" + str(uuid.uuid4()) for s in sources})
                        registered = data
                        healthy = False
                        submitted.clear()
                        replied.clear()
                        out = {"sources": ["peer", "portal"]}
                    elif op == "native":
                        if data.get("native_session_id"):
                            native_reported = data["native_session_id"] == native
                        out = {"native_session_id": native if native_reported or engine == "codex" else ""}
                    elif op == "claim":
                        source = data["source"]
                        if healthy and source not in submitted:
                            submitted.add(source)
                            message = {"message_id": message_ids[source], "lease_owner": data["claim_id"], "kind": "message", "content": "Canary only: reply with exactly " + receipts[source] + ". Do not run commands or edit files."}
                            out = {"delivery" if source == "peer" else "message": message}
                    elif op == "ack" and "/receiver/" in self.path:
                        failure = "unexpected receiver probe acknowledgment"
                        status = 400
                    elif op == "reply":
                        if data.get("message_id") == message_ids["peer"] and data.get("content", "").strip() == receipts["peer"]:
                            replied.add("peer")
                        else:
                            failure = "peer reply lost message correlation"
                    elif op == "events":
                        payload = data.get("payload", {})
                        if payload.get("message_id") == message_ids["portal"] and payload.get("text", "").strip() == receipts["portal"]:
                            replied.add("portal")
                        else:
                            failure = "portal reply lost message correlation"
                    elif op == "heartbeat" and "/receiver/" in self.path and len(replied) == 2 and not reconnect_requested:
                        completed_replies = sorted(replied)
                        reconnect_requested = True
                        status = 409
                        out = {"code": "receiver_generation_changed", "message": "canary reconnect requested"}
                    elif op == "heartbeat" and "/receiver/" in self.path:
                        healthy = True
                        out = {"receiver": {"sources": [{"source": s} for s in sources]}}
                    elif op in ("heartbeat", "stop", "status", "ack", "renew"):
                        pass
                    else:
                        failure = "unexpected broker operation: " + op
                        status = 400
                body = json.dumps(out).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True

        server = Server(broker, Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = dict(os.environ, TERM="xterm-256color")
        mcp_env = {
            "CXX_AGENT_PORTAL_SOCKET": broker,
            "CXX_AGENT_PORTAL_SESSION_ID": session,
            "CXX_AGENT_PORTAL_ENGINE": engine,
            "CXX_CODEX_SOCKET": sock,
        }
        children = []
        master = slave = None
        try:
            if engine == "codex":
                overrides = ["-c", 'mcp_servers.cxx-agent.command=' + json.dumps(cxx),
                             "-c", 'mcp_servers.cxx-agent.args=["agent","mcp","--auto"]']
                for key, value in mcp_env.items():
                    overrides += ["-c", "mcp_servers.cxx-agent.env." + key + "=" + json.dumps(value)]
                # This isolated canary grants only its own receipt tools; shell
                # commands and files remain read-only with approvals disabled.
                for name in ("agent_receiver_reply", "agent_reply"):
                    overrides += ["-c", "mcp_servers.cxx-agent.tools." + name + '.approval_mode="approve"']
                daemon = subprocess.Popen(["codex", "app-server", "--listen", "unix://" + sock, *overrides],
                                          cwd=tmp, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                          start_new_session=True)
                children.append(daemon)
                deadline = time.monotonic() + 15
                while not os.path.exists(sock) and time.monotonic() < deadline and daemon.poll() is None:
                    time.sleep(.1)
                command = ["codex", "--remote", "unix://" + sock, "--no-alt-screen", "-C", tmp,
                           "-a", "never", "-s", "read-only"]
            else:
                # The plugin directory basename is the plugin's identity to
                # Claude Code (`<basename>@inline`), and it provides the MCP
                # server itself: only a plugin-provided server can be approved
                # as a channel without the development-channels confirmation.
                plugin = pathlib.Path(tmp) / CLAUDE_PLUGIN
                (plugin / ".claude-plugin").mkdir(parents=True)
                (plugin / "hooks").mkdir()
                (plugin / ".claude-plugin" / "plugin.json").write_text(json.dumps(
                    {"name": CLAUDE_PLUGIN, "version": "1.0.0", "channels": [{"server": "cxx-agent"}]}))
                hook_env = " ".join(shlex.quote(k + "=" + v) for k, v in mcp_env.items())
                command_hook = "env " + hook_env + " " + shlex.quote(cxx) + " agent native-session"
                (plugin / "hooks" / "hooks.json").write_text(json.dumps({"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": command_hook, "timeout": 5}]}]}}))
                mcp = {"mcpServers": {"cxx-agent": {"command": cxx, "args": ["agent", "mcp", "--auto"], "env": mcp_env}}}
                (plugin / ".mcp.json").write_text(json.dumps(mcp))
                tools = ["mcp__" + CLAUDE_MCP_SERVER + "__agent_receiver_reply",
                         "mcp__" + CLAUDE_MCP_SERVER + "__agent_reply"]
                command = ["claude", "--plugin-dir", str(plugin), "--session-id", native,
                           *(["--channels", CLAUDE_CHANNEL] if channel_approved() else
                             ["--dangerously-load-development-channels", CLAUDE_CHANNEL]),
                           "--permission-mode", "dontAsk",
                           "--allowedTools", *tools]
            master, slave = pty.openpty()
            import fcntl
            import struct
            import termios
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
            def terminal_session():
                os.setsid()
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            process = subprocess.Popen(command, cwd=tmp, env=env, stdin=slave, stdout=slave, stderr=slave,
                                       preexec_fn=terminal_session)
            children.append(process)
            os.close(slave)
            slave = None
            deadline = time.monotonic() + timeout
            tail = b""
            trusted = False
            channel_confirmed = False
            while time.monotonic() < deadline:
                with lock:
                    if failure:
                        raise RuntimeError(failure)
                    if reconnected and healthy and len(replied) == 2:
                        print(json.dumps({"engine": engine, "result": "passed", "native_session_id": registered["native_session_id"],
                                          "generation": registered["generation"], "correlated_message_replies": completed_replies, "reconnected_and_replied": sorted(replied)}), flush=True)
                        return
                if process.poll() is not None:
                    raise RuntimeError("native terminal exited before replying to both messages")
                readable, _, _ = select.select([master], [], [], .2)
                if readable:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    tail = (tail + data)[-8192:]
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")
                    # Only approve the canary's own temporary directory and named
                    # custom Channel. Never answer a tool-permission prompt.
                    screen = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", tail).lower()
                    screen = re.sub(rb"\s+", b"", screen)
                    if not trusted and (b"trustthisfolder" in screen or b"trustthecontentsofthisdirectory" in screen):
                        time.sleep(1)
                        if engine == "claude" and "❯no,exit".encode() in screen:
                            os.write(master, b"\x1b[B")
                            time.sleep(.2)
                        os.write(master, b"\r")
                        trusted = True
                    if not channel_confirmed and b"iamusingthisforlocaldevelopment" in screen:
                        # With the managed drop-in installed this dialog must
                        # never appear: the channel is approved, so a prompt
                        # here means the approval silently stopped working and
                        # the run is not proving what it claims to prove.
                        if channel_approved():
                            raise SystemExit(
                                "channel confirmation appeared although managed settings approve "
                                + CLAUDE_CHANNEL)
                        os.write(master, b"\r")
                        channel_confirmed = True
            # Diagnostics remain local and exclude terminal contents by default.
            if os.environ.get("CXX_CANARY_DEBUG") == "1":
                print(tail.decode(errors="replace"))
                if receiver_log.exists():
                    print(receiver_log.read_text()[-4000:])
                print(json.dumps({"operations": operations, "replies": sorted(replied), "native_reported": native_reported}))
            raise RuntimeError("timed out: " + ("registered; correlated message replies incomplete" if registered else "receiver never registered"))
        finally:
            for child in reversed(children):
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            if master is not None:
                os.close(master)
            if slave is not None:
                os.close(slave)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["codex", "claude"], required=True)
    parser.add_argument("--cxx", required=True, help="absolute path to the built wrapper")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    run(args.engine, os.path.abspath(args.cxx), args.timeout)
