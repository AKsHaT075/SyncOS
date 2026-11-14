"""Runs extraction in a throw-away child process so a hostile or pathological file can only hurt the child.

* wall-clock timeout: the parent kills the child
* CPU time and (Linux) address-space limits are set inside the child
* the child returns JSON bytes over a pipe; the parent caps what it will read
The child is started with `spawn`, so it inherits nothing from the worker (no tokens, no connections).
"""
from __future__ import annotations

import json
import multiprocessing as mp
import sys
from typing import Callable

from .limits import Limits
from .reasons import CRASHED, OUT_OF_MEMORY, TIMEOUT


class IsolationError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _apply_limits(limits: Limits) -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds + 5))
        if sys.platform.startswith("linux"):  # macOS does not honour RLIMIT_AS reliably
            resource.setrlimit(resource.RLIMIT_AS, (limits.memory_bytes, limits.memory_bytes))
    except Exception:
        pass  # best effort; the wall-clock kill still applies


def _child(conn, target: Callable, args: tuple, limits_dict: dict) -> None:
    _apply_limits(Limits(**limits_dict))
    try:
        payload = json.dumps({"ok": target(*args)}).encode()
    except MemoryError:
        payload = json.dumps({"error": OUT_OF_MEMORY}).encode()
    except BaseException:  # noqa: BLE001 - report a code only; the message could contain document text
        payload = json.dumps({"error": CRASHED}).encode()
    conn.send_bytes(payload)
    conn.close()


def run_isolated(target: Callable, args: tuple, limits: Limits, max_result_bytes: int = 64 * 1024 * 1024) -> dict:
    """Blocking. Call it from a worker thread. Raises IsolationError(TIMEOUT|CRASHED|EXTRACTION_OOM)."""
    ctx = mp.get_context("spawn")
    parent, child_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child, args=(child_conn, target, args, limits.as_dict()), daemon=True)
    proc.start()
    child_conn.close()
    try:
        if not parent.poll(limits.timeout_seconds):
            raise IsolationError(TIMEOUT)
        try:
            raw = parent.recv_bytes(max_result_bytes)
        except (EOFError, OSError):
            raise IsolationError(OUT_OF_MEMORY if proc.exitcode in (-9, -6, -11) else CRASHED) from None
        message = json.loads(raw)
        if "error" in message:
            raise IsolationError(message["error"])
        return message["ok"]
    finally:
        parent.close()
        if proc.is_alive():
            proc.kill()
        proc.join(5)
