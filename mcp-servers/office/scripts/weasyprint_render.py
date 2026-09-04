"""Render an HTML file to PDF with WeasyPrint, loading only ``file://`` resources under ``/workspace``.

Usage: ``python3 weasyprint_render.py <src.html> <dst.pdf> <base-url>``
The custom ``url_fetcher`` rejects any non-``file:`` URL and any ``file:`` path that resolves
(via ``realpath``) outside ``/workspace`` — defence in depth on top of the worker's egress-less
network; any rejection fails the whole render (no PDF is written). The PDF is written
atomically (tmp file + rename).
Output: ``{"ok": true, "path": "<dst.pdf>"}``
"""

from __future__ import annotations

import os
from urllib.parse import unquote, urlparse

from script_runner import atomic_save, fail, main, ok

WORKSPACE_ROOT = "/workspace"

_rejected_urls: list[str] = []


def _local_only_url_fetcher(url: str, timeout: int = 10, ssl_context=None):
    """A WeasyPrint ``url_fetcher`` that only resolves ``file://`` URLs whose realpath is under ``/workspace``."""
    from weasyprint import default_url_fetcher

    if not url.startswith("file:"):
        _rejected_urls.append(url)
        raise ValueError(f"remote resources are not allowed: {url}")
    real = os.path.realpath(unquote(urlparse(url).path))
    if not (real == WORKSPACE_ROOT or real.startswith(WORKSPACE_ROOT + os.sep)):
        _rejected_urls.append(url)
        raise ValueError(f"resource outside /workspace: {url}")
    return default_url_fetcher(url, timeout=timeout, ssl_context=ssl_context)


def _run(argv: list[str]) -> None:
    if len(argv) != 3:
        fail("usage: weasyprint_render.py <src.html> <dst.pdf> <base-url>")
    src, dst, base_url = argv
    from weasyprint import HTML

    doc = HTML(filename=src, base_url=base_url, url_fetcher=_local_only_url_fetcher)
    # WeasyPrint downgrades url_fetcher exceptions to warnings and renders on with the
    # resource missing; the recorded rejections keep this script fail-closed.
    pdf = doc.write_pdf(presentational_hints=False)
    if _rejected_urls:
        fail(f"rejected resources: {', '.join(sorted(set(_rejected_urls)))}")

    def _write(p: str) -> None:
        with open(p, "wb") as fh:
            fh.write(pdf)

    atomic_save(dst, _write)
    ok(path=dst)


if __name__ == "__main__":
    main(_run)
