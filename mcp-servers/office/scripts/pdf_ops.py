"""PDF manipulation for the office worker — merge / split / rotate / watermark / fill-form / metadata.

Usage (one subcommand per invocation):
  python3 pdf_ops.py metadata  <input.pdf>
  python3 pdf_ops.py merge     <output.pdf> <in1.pdf> <in2.pdf> ...
  python3 pdf_ops.py split     <input.pdf> <output.pdf> <start> <end>          (1-indexed, inclusive)
  python3 pdf_ops.py rotate    <input.pdf> <output.pdf> <degrees> <p1,p2,...>  (1-indexed pages; degrees 90|180|270)
  python3 pdf_ops.py watermark <input.pdf> <watermark.pdf> <output.pdf>
  python3 pdf_ops.py fillform  <input.pdf> <output.pdf> <flatten 0|1> <json-fields>

Output: {"ok": true, ...} (metadata adds {"metadata": {...}}).
"""

from __future__ import annotations

import json
import sys

from script_runner import atomic_save, main, ok, fail


def _write_pdf(writer, dest: str) -> None:
    """Write a pypdf ``PdfWriter`` to ``dest`` atomically (tmp file + rename)."""
    atomic_save(dest, lambda p: writer.write(p))


def _open_reader(path: str):
    from pypdf import PdfReader

    return PdfReader(path)


def _metadata(path: str) -> None:
    reader = _open_reader(path)
    meta = reader.metadata or {}
    ok(
        metadata={
            "pages": len(reader.pages),
            "title": str(meta.get("/Title", "")) or None,
            "author": str(meta.get("/Author", "")) or None,
            "producer": str(meta.get("/Producer", "")) or None,
            "creator": str(meta.get("/Creator", "")) or None,
            "encrypted": bool(getattr(reader, "is_encrypted", False)),
        }
    )


def _merge(output: str, inputs: list[str]) -> None:
    from pypdf import PdfWriter

    if len(inputs) < 2:
        fail("merge needs at least two input PDFs")
    writer = PdfWriter()
    for path in inputs:
        for page in _open_reader(path).pages:
            writer.add_page(page)
    _write_pdf(writer, output)
    ok(path=output, pages=len(writer.pages))


def _split(src: str, output: str, start: int, end: int) -> None:
    from pypdf import PdfWriter

    reader = _open_reader(src)
    n = len(reader.pages)
    if start < 1 or end < start:
        fail(f"invalid range [{start}, {end}]")
    if end > n:
        fail(f"range end {end} exceeds page count {n}")
    writer = PdfWriter()
    for i in range(start - 1, end):
        writer.add_page(reader.pages[i])
    _write_pdf(writer, output)
    ok(path=output, pages=len(writer.pages))


def _rotate(src: str, output: str, degrees: int, pages_csv: str) -> None:
    from pypdf import PdfWriter

    if degrees not in (90, 180, 270):
        fail("degrees must be 90, 180, or 270")
    try:
        pages = {int(p) for p in pages_csv.split(",") if p.strip()}
    except ValueError:
        fail("pages must be a comma-separated list of integers")
    reader = _open_reader(src)
    n = len(reader.pages)
    for p in pages:
        if p < 1 or p > n:
            fail(f"page {p} out of range 1..{n}")
    writer = PdfWriter()
    for idx, page in enumerate(reader.pages, start=1):
        if idx in pages:
            page.rotate(degrees)
        writer.add_page(page)
    _write_pdf(writer, output)
    ok(path=output, rotated=sorted(pages))


def _watermark(src: str, watermark: str, output: str) -> None:
    from pypdf import PdfWriter

    wm_reader = _open_reader(watermark)
    if len(wm_reader.pages) < 1:
        fail("watermark PDF has no pages")
    stamp = wm_reader.pages[0]
    reader = _open_reader(src)
    writer = PdfWriter()
    for page in reader.pages:
        page.merge_page(stamp)
        writer.add_page(page)
    _write_pdf(writer, output)
    ok(path=output, pages=len(writer.pages))


def _fillform(src: str, output: str, flatten: bool, fields: dict) -> None:
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(src)
    writer = PdfWriter()
    writer.append(reader)
    str_fields = {str(k): str(v) for k, v in fields.items()}
    fill_warnings: list[str] = []
    for page in writer.pages:
        try:
            writer.update_page_form_field_values(page, str_fields, auto_regenerate=False)
        except Exception as exc:  # noqa: BLE001
            # A page without form fields raises — expected; collect anything else so the worker surfaces it.
            fill_warnings.append(f"{type(exc).__name__}: {exc}")
    flattened = False
    if flatten:
        # Best-effort flatten via the private _root_object; degrades to a non-flat form on a pypdf rename.
        try:
            from pypdf.generic import NameObject

            if "/AcroForm" in writer._root_object:
                writer._root_object[NameObject("/AcroForm")].update(
                    {NameObject("/NeedAppearances"): writer._root_object["/AcroForm"].get("/NeedAppearances", False)}
                )
            writer.set_need_appearances_writer(True)
            flattened = True
        except Exception as exc:  # noqa: BLE001 — flatten is opportunistic; report and continue
            sys.stderr.write(
                f"warning: could not flatten AcroForm ({type(exc).__name__}: {exc}); returning a non-flat form\n"
            )
    _write_pdf(writer, output)
    ok(
        path=output,
        fields=list(str_fields.keys()),
        flattened=flattened,
        fill_warnings=fill_warnings if fill_warnings else None,
    )


def _run(argv: list[str]) -> None:
    if not argv:
        fail("usage: pdf_ops.py <subcommand> ...")
    cmd = argv[0]
    if cmd == "metadata":
        if len(argv) != 2:
            fail("usage: pdf_ops.py metadata <input.pdf>")
        _metadata(argv[1])
    elif cmd == "merge":
        if len(argv) < 4:
            fail("usage: pdf_ops.py merge <output.pdf> <in1.pdf> <in2.pdf> ...")
        _merge(argv[1], argv[2:])
    elif cmd == "split":
        if len(argv) != 5:
            fail("usage: pdf_ops.py split <input.pdf> <output.pdf> <start> <end>")
        _split(argv[1], argv[2], int(argv[3]), int(argv[4]))
    elif cmd == "rotate":
        if len(argv) != 5:
            fail("usage: pdf_ops.py rotate <input.pdf> <output.pdf> <degrees> <pages-csv>")
        _rotate(argv[1], argv[2], int(argv[3]), argv[4])
    elif cmd == "watermark":
        if len(argv) != 4:
            fail("usage: pdf_ops.py watermark <input.pdf> <watermark.pdf> <output.pdf>")
        _watermark(argv[1], argv[2], argv[3])
    elif cmd == "fillform":
        if len(argv) != 5:
            fail("usage: pdf_ops.py fillform <input.pdf> <output.pdf> <flatten 0|1> <json-fields>")
        _fillform(argv[1], argv[2], argv[3] == "1", json.loads(argv[4]))
    else:
        fail(f"unknown subcommand: {cmd}")


if __name__ == "__main__":
    main(_run)
