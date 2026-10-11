"""Bounded, cancellable process groups for gateway /exec calls."""

import os
import signal
import subprocess
import threading
import time


POLL_SECONDS = 0.1
TERMINATE_GRACE_SECONDS = 2.0


class ExecCancelled(Exception):
    pass


def _signal_group(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass


def _stop(proc):
    # Signal the group even when its leader has exited: descendants may still
    # hold the output pipes or the private credential home open.
    _signal_group(proc, signal.SIGTERM)
    try:
        proc.communicate(timeout=TERMINATE_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        _signal_group(proc, signal.SIGKILL)
        try:
            proc.communicate(timeout=TERMINATE_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            # A process that explicitly escaped the owned group can retain a
            # pipe. It must not make cancellation wait indefinitely for EOF.
            for stream in (proc.stdout, proc.stderr):
                if stream:
                    stream.close()
            proc.wait(timeout=TERMINATE_GRACE_SECONDS)
    finally:
        # A descendant can close its pipes but keep running after its leader.
        _signal_group(proc, signal.SIGKILL)


def run_prompt_process(cmd, *, env, timeout, cancelled=None):
    cancelled = cancelled if cancelled is not None else threading.Event()
    if cancelled.is_set():
        raise ExecCancelled("exec cancelled")
    proc = subprocess.Popen(
        cmd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=True,
    )
    deadline = time.monotonic() + timeout
    try:
        while True:
            if cancelled.is_set():
                raise ExecCancelled("exec cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(cmd, timeout)
            try:
                stdout, stderr = proc.communicate(timeout=min(POLL_SECONDS, remaining))
            except subprocess.TimeoutExpired:
                continue
            if cancelled.is_set():
                raise ExecCancelled("exec cancelled")
            return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    finally:
        _stop(proc)
