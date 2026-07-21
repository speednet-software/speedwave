"""Render an HTML file to PDF with WeasyPrint, loading only ``file://`` resources under ``/workspace``.

Usage: ``python3 weasyprint_render.py <src.html> <dst.pdf> <base-url>``
The custom ``url_fetcher`` rejects any non-``file:`` URL and any ``file:`` path that resolves
(via ``realpath``) outside ``/workspace`` — defence in depth on top of the worker's egress-less
network. The PDF is written atomically (tmp file + rename).
Output: ``{"ok": true, "path": "<dst.pdf>"}``
"""

from __future__ import annotations

import os
from urllib.parse import unquote, urlparse

from script_runner import atomic_save, fail, main, ok

WORKSPACE_ROOT = "/workspace"


def _local_only_url_fetcher(url: str, timeout: int = 10, ssl_context=None):
    """A WeasyPrint ``url_fetcher`` that only resolves ``file://`` URLs whose realpath is under ``/workspace``."""
    from weasyprint import default_url_fetcher

    if not url.startswith("file:"):
        raise ValueError(f"remote resources are not allowed: {url}")
    real = os.path.realpath(unquote(urlparse(url).path))
    if not (real == WORKSPACE_ROOT or real.startswith(WORKSPACE_ROOT + os.sep)):
        raise ValueError(f"resource outside /workspace: {url}")
    return default_url_fetcher(url, timeout=timeout, ssl_context=ssl_context)


def _run(argv: list[str]) -> None:
    if len(argv) != 3:
        fail("usage: weasyprint_render.py <src.html> <dst.pdf> <base-url>")
    src, dst, base_url = argv
    from weasyprint import HTML

    doc = HTML(filename=src, base_url=base_url, url_fetcher=_local_only_url_fetcher)
    atomic_save(dst, lambda p: doc.write_pdf(p, presentational_hints=False))
    ok(path=dst)


if __name__ == "__main__":
    main(_run)
