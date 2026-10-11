"""Real subprocess coverage for gateway disconnect/timeout cleanup."""

import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from unittest.mock import patch

import pytest
from fastapi import HTTPException

import app
import exec_process


def wait_for_file(path):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(0.01)
    raise AssertionError(f"fixture did not start: {path}")


def running(pid):
    # A killed grandchild can briefly remain a zombie pending init's reap.
    try:
        state = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1][0]
        return state != "Z"
    except (FileNotFoundError, ProcessLookupError):
        return False


def tree_command(tmp_path, ignore_term=False):
    ready = tmp_path / "ready.json"
    stopped = tmp_path / "term.txt"
    script = """
import json, os, signal, subprocess, sys, time
from pathlib import Path
ignore = sys.argv[3] == '1'
child = subprocess.Popen([sys.executable, '-c',
    'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])
def stop(sig, frame):
    Path(sys.argv[2]).write_text('TERM')
    if not ignore:
        child.kill()
        child.wait()
        raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
Path(sys.argv[1]).write_text(json.dumps([os.getpid(), child.pid]))
while True:
    time.sleep(0.02)
"""
    return [sys.executable, "-c", script, str(ready), str(stopped), str(int(ignore_term))], ready, stopped


@pytest.mark.skipif(sys.platform != "linux", reason="Linux runner process-group contract")
@pytest.mark.parametrize("reason", ["timeout", "disconnect"])
@pytest.mark.parametrize("ignore_term", [False, True])
def test_exec_stops_complete_group_with_grace(tmp_path, reason, ignore_term):
    cmd, ready, stopped = tree_command(tmp_path, ignore_term)
    cancelled = threading.Event()
    def cancel_when_ready():
        wait_for_file(ready)
        if reason == "disconnect":
            cancelled.set()
    observer = threading.Thread(target=cancel_when_ready)
    observer.start()
    began = time.monotonic()
    try:
        with patch.object(exec_process, "TERMINATE_GRACE_SECONDS", 0.15):
            with pytest.raises(exec_process.ExecCancelled if reason == "disconnect" else subprocess.TimeoutExpired):
                exec_process.run_prompt_process(cmd, env=os.environ.copy(), timeout=0.5, cancelled=cancelled)
        assert time.monotonic() - began < 3
        assert stopped.read_text() == "TERM"
        pids = json.loads(ready.read_text())
        deadline = time.monotonic() + 2
        while any(running(pid) for pid in pids) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not any(running(pid) for pid in pids)
    finally:
        observer.join(timeout=5)
        if ready.exists():
            for pid in json.loads(ready.read_text()):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def test_already_cancelled_exec_never_spawns():
    cancelled = threading.Event()
    cancelled.set()
    with patch.object(subprocess, "Popen") as spawn:
        with pytest.raises(exec_process.ExecCancelled):
            exec_process.run_prompt_process(["unused"], env={}, timeout=1, cancelled=cancelled)
    spawn.assert_not_called()


@pytest.mark.skipif(sys.platform != "linux", reason="Linux runner process-group contract")
def test_success_reaps_descendants_that_closed_output(tmp_path):
    script = """
import subprocess,sys
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(child.pid)
"""
    result = exec_process.run_prompt_process(
        [sys.executable, "-c", script], env=os.environ.copy(), timeout=2)
    pid = int(result.stdout.strip())
    deadline = time.monotonic() + 2
    while running(pid) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert result.returncode == 0
    assert not running(pid)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux runner process-group contract")
@pytest.mark.parametrize("engine", ["codex", "claude", "grok"])
def test_engine_exec_cancellation_removes_actual_private_home(tmp_path, engine):
    home = tmp_path / "private-home"
    home.mkdir()
    cmd, ready, stopped = tree_command(tmp_path)
    cancelled = threading.Event()
    observer = threading.Thread(target=lambda: (wait_for_file(ready), cancelled.set()))
    env = os.environ.copy()
    env["HOME"] = str(home)
    try:
        with patch.object(app, "_prepare_engine_env", return_value=(env, str(home), "unused")), \
             patch.object(app.grok, "prepare_env", return_value=(env, str(home), "unused")), \
             patch.object(app, "_build_codex_exec_cmd", return_value=cmd), \
             patch.object(app, "_build_claude_exec_cmd", return_value=cmd), \
             patch.object(app.grok, "build_command", return_value=cmd):
            observer.start()
            payload = app.ExecRequest(auth_json={}, prompt="test", engine=engine)
            with pytest.raises(exec_process.ExecCancelled):
                app._exec_prompt(payload, cancelled)
        assert stopped.read_text() == "TERM"
        assert not home.exists()
    finally:
        observer.join(timeout=5)


@pytest.mark.parametrize("engine", ["codex", "claude", "grok"])
@pytest.mark.parametrize("cancel_task", [False, True])
def test_route_waits_for_cancelled_exec_and_home_cleanup(tmp_path, engine, cancel_task):
    home = tmp_path / engine
    home.mkdir()
    started = threading.Event()
    finished = threading.Event()
    received = threading.Event()

    class Request:
        headers = {"x-runner-auth": "runner-secret"}
        async def is_disconnected(self):
            return received.is_set()

    def execute(payload, cancelled):
        try:
            assert payload.engine == engine
            started.set()
            assert cancelled.wait(5), "route did not cancel its worker"
            # Model bounded reaping before the private home can be removed.
            time.sleep(0.03)
            raise exec_process.ExecCancelled("exec cancelled")
        finally:
            home.rmdir()
            finished.set()

    async def scenario():
        payload = app.ExecRequest(auth_json={}, prompt="test", engine=engine)
        task = asyncio.create_task(app.exec_prompt(payload, Request()))
        assert await asyncio.to_thread(started.wait, 5)
        if cancel_task:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            received.set()
            with pytest.raises(HTTPException) as err:
                await task
            assert err.value.status_code == 499
        assert finished.is_set()
        assert not home.exists()

    with patch.object(app, "RUNNER_SHARED_SECRET", "runner-secret"), patch.object(app, "_exec_prompt", execute):
        asyncio.run(scenario())
