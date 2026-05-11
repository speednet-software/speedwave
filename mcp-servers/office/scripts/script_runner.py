"""Shared I/O convention for the office worker's Python support-scripts.

Every script is invoked as ``python3 <script>.py <args...>`` and must print a single
JSON object on stdout. On success the object has ``{"ok": true, ...}``; on failure the
script prints ``{"ok": false, "error": "..."}`` to stdout AND exits non-zero, with the
error also on stderr. The TypeScript ``runPythonScript`` helper enforces this contract.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import uuid
from typing import Any, Callable


def atomic_save(dest: str, write_fn: Callable[[str], None]) -> None:
    """Write to a sibling ``*.tmp-<uuid>`` via ``write_fn(tmp_path)``, then ``os.replace`` it onto ``dest``.

    Mirrors the TypeScript-layer ``atomicWrite``/``atomicMoveOnto`` so a SIGKILL mid-write leaves
    either the previous file or the temp file (which is cleaned up), never a half-written ``dest``.
    ``write_fn`` may be ``open(p, "wb").write`` style or a library's ``save(p)``.
    """
    tmp = f"{dest}.tmp-{uuid.uuid4().hex}"
    try:
        write_fn(tmp)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ok(**fields: Any) -> None:
    """Print a success JSON object to stdout and exit 0."""
    sys.stdout.write(json.dumps({"ok": True, **fields}))
    sys.stdout.flush()
    raise SystemExit(0)


def fail(message: str) -> None:
    """Print a failure JSON object to stdout, the message to stderr, and exit 1."""
    sys.stdout.write(json.dumps({"ok": False, "error": message}))
    sys.stdout.flush()
    sys.stderr.write(message + "\n")
    raise SystemExit(1)


def main(fn: Callable[[list[str]], None]) -> None:
    """Run ``fn(argv_tail)`` (argv without the script name), turning any exception into :func:`fail`.

    ``fn`` is expected to call :func:`ok` on success.
    """
    try:
        fn(sys.argv[1:])
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — top-level guard turns anything into a structured failure
        fail(f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")
