"""Owned process groups for native runner calls."""

import os
import selectors
import signal
import subprocess
import threading
import time


MAX_OUTPUT_BYTES = 8 * 1024 * 1024
READ_BYTES = 64 * 1024
POLL_SECONDS = 0.1
TERMINATE_GRACE_SECONDS = 2.0


class ExecCancelled(Exception):
    pass


class NativeOutputError(Exception):
    """Provider output could not be safely delivered as a complete result."""


def signal_group(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass


def _stop(proc):
    # Signal the group even when its leader has exited: descendants may still
    # hold the output pipes or the private credential home open.
    signal_group(proc, signal.SIGTERM)
    try:
        for stream in (proc.stdout, proc.stderr):
            stream.close()
        try:
            proc.wait(timeout=TERMINATE_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            signal_group(proc, signal.SIGKILL)
            proc.wait(timeout=TERMINATE_GRACE_SECONDS)
    finally:
        # A descendant can close its pipes but keep running after its leader.
        signal_group(proc, signal.SIGKILL)


def run_prompt_process(cmd, *, env, timeout, cancelled=None, cwd=None):
    cancelled = cancelled if cancelled is not None else threading.Event()
    if cancelled.is_set():
        raise ExecCancelled("exec cancelled")
    proc = subprocess.Popen(
        cmd, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,
    )
    deadline = time.monotonic() + timeout
    try:
        captures = [bytearray(), bytearray()]
        size = 0
        with selectors.DefaultSelector() as selector:
            for pipe, target in zip((proc.stdout, proc.stderr), captures):
                selector.register(pipe, selectors.EVENT_READ, target)
            while True:
                if cancelled.is_set():
                    raise ExecCancelled("exec cancelled")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(cmd, timeout)
                interval = min(POLL_SECONDS, remaining)
                if not selector.get_map():
                    # A process may close both streams before it exits.
                    try:
                        proc.wait(timeout=interval)
                    except subprocess.TimeoutExpired:
                        continue
                    break
                for key, _ in selector.select(interval):
                    chunk = os.read(key.fd, min(READ_BYTES, MAX_OUTPUT_BYTES - size + 1))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    size += len(chunk)
                    if size > MAX_OUTPUT_BYTES:
                        raise NativeOutputError("native_output_limit_exceeded")
                    key.data.extend(chunk)
        if cancelled.is_set():
            raise ExecCancelled("exec cancelled")
        try:
            stdout, stderr = (data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n") for data in captures)
        except UnicodeDecodeError:
            raise NativeOutputError("native_output_invalid_utf8") from None
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    finally:
        _stop(proc)
