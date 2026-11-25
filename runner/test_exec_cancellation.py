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
from fastapi.testclient import TestClient

import app
import chatty
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


@pytest.mark.skipif(sys.platform != "linux", reason="Linux runner process-group contract")
@pytest.mark.parametrize("engine", ["chatty", "codex", "claude", "grok", "kimi"])
def test_provider_calls_clean_children_after_leader_exit(tmp_path, engine):
    """Native CLIs may leave a helper alive that already closed its pipes."""
    marker = tmp_path / "child.pid"
    child_script = """
import os, signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()))
time.sleep(10)
"""
    leader_script = """
import subprocess, sys, time
from pathlib import Path
subprocess.Popen([sys.executable, "-c", sys.argv[1], sys.argv[2]],
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
while not Path(sys.argv[2]).exists():
    time.sleep(0.005)
"""
    cmd = [sys.executable, "-c", leader_script, child_script, str(marker)]
    env = {"HOME": str(tmp_path), "PATH": os.defpath}
    try:
        if engine == "chatty":
            async def exercise():
                proc = await asyncio.create_subprocess_exec(*cmd, env=env, start_new_session=True)
                assert await asyncio.wait_for(proc.wait(), timeout=4) == 0
                await chatty.stop_process(proc)

            asyncio.run(exercise())
        else:
            owner, attr = {
                "codex": (app, "_build_codex_exec_cmd"),
                "claude": (app, "_build_claude_exec_cmd"),
                "grok": (app.grok, "build_command"),
                "kimi": (app.kimi, "build_command"),
            }[engine]
            with patch.object(owner, attr, return_value=cmd):
                if engine in ("codex", "claude"):
                    app._run_engine_exec("test", env, 4, engine)
                else:
                    owner.run("test", env, 4)
        pid = int(marker.read_text())
        deadline = time.monotonic() + 0.5
        while running(pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not running(pid), f"{engine} left its helper running"
    finally:
        if marker.exists():
            try:
                os.kill(int(marker.read_text()), signal.SIGKILL)
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
@pytest.mark.parametrize("engine", ["codex", "claude", "grok", "kimi"])
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
             patch.object(app.kimi, "prepare_env", return_value=(env, str(home), "unused")), \
             patch.object(app, "_build_codex_exec_cmd", return_value=cmd), \
             patch.object(app, "_build_claude_exec_cmd", return_value=cmd), \
             patch.object(app.grok, "build_command", return_value=cmd), \
             patch.object(app.kimi, "build_command", return_value=cmd):
            observer.start()
            payload = app.ExecRequest(auth_json={}, prompt="test", engine=engine)
            with pytest.raises(exec_process.ExecCancelled):
                app._exec_prompt(payload, cancelled)
        assert stopped.read_text() == "TERM"
        assert not home.exists()
    finally:
        observer.join(timeout=5)


@pytest.mark.parametrize("engine", ["codex", "claude", "grok", "kimi"])
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

@pytest.mark.parametrize("fd", [1, 2])
def test_bounded_output_counts_both_pipes_and_reaps_descendants(tmp_path, monkeypatch, fd):
    monkeypatch.setattr(exec_process, "MAX_OUTPUT_BYTES", 32)
    pid_file = tmp_path / "owned-child"
    script = """
import os, subprocess, sys
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
with open(sys.argv[1], 'w') as f:
    print(child.pid, file=f)
os.write(1, b'x' * 16)
os.write(2, b'y' * 16)
os.write(int(sys.argv[2]), b'z')
"""
    try:
        with pytest.raises(exec_process.NativeOutputError, match="^native_output_limit_exceeded$"):
            exec_process.run_prompt_process([sys.executable, "-c", script, str(pid_file), str(fd)], env={}, timeout=3)
        pid = int(pid_file.read_text())
        deadline = time.monotonic() + 1
        while running(pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not running(pid)
    finally:
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_utf8_across_reads_and_exact_limit(monkeypatch):
    text = "ä🐈\r\n"
    monkeypatch.setattr(exec_process, "MAX_OUTPUT_BYTES", len(text.encode()) + 1)
    monkeypatch.setattr(exec_process, "READ_BYTES", 1)
    result = exec_process.run_prompt_process(
        [sys.executable, "-c", "import os,sys; os.write(1, sys.argv[1].encode()); os.write(2,b'!')", text],
        env={}, timeout=2)
    assert (result.returncode, result.stdout, result.stderr) == (0, "ä🐈\n", "!")


def test_invalid_output_reports_only_fixed_reason():
    with pytest.raises(exec_process.NativeOutputError, match="^native_output_invalid_utf8$"):
        exec_process.run_prompt_process(
            [sys.executable, "-c", "import os; os.write(2, b'private-part' + bytes([255]))"], env={}, timeout=2)

@pytest.mark.parametrize("path", ["/exec", "/verify", "/skills/generate"])
def test_output_limit_http_response_and_single_native_execution(tmp_path, monkeypatch, path):
    monkeypatch.setattr(exec_process, "MAX_OUTPUT_BYTES", 32)
    monkeypatch.setattr(app, "RUNNER_SHARED_SECRET", "fixture-runner")
    monkeypatch.setattr(app, "RUNNER_HOME_PARENT", str(tmp_path))
    runs = tmp_path / "runs"
    code = """
import os, sys
with open(sys.argv[1], 'a') as count:
    print('started', file=count)
os.write(2, b'synthetic-private-text' * 3)
"""
    cmd = [sys.executable, "-c", code, str(runs)]
    monkeypatch.setattr(app, "_build_codex_exec_cmd", lambda *args, **kwargs: cmd)
    payload = {"auth_json": {"tokens": {"access_token": "fixture-token"}}, "timeout_seconds": 3}
    if path != "/verify":
        payload["prompt"] = "fixture"
    response = TestClient(app.app).post(path, headers={"x-runner-auth": "fixture-runner"}, json=payload)
    assert response.status_code == 502, response.text
    assert response.json() == {"detail": "native_output_limit_exceeded"}
    assert runs.read_text() == "started\n"
    assert list(tmp_path.iterdir()) == [runs]
