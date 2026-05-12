"""Tests for the dependency-free Python helpers (`markdown_utils`, `script_runner`).

These have no third-party imports and run on any interpreter. The library-driven scripts
(`docx_build.py`, `xlsx_build.py`, `pptx_build.py`, `pdf_ops.py`, `render_chart.py`,
`python_docx_extract.py`) are covered by `test_scripts.py`, which self-skips when its deps
(python-docx / openpyxl / python-pptx / pypdf / matplotlib) are absent.
"""

from __future__ import annotations

import json
import sys

import markdown_utils
import script_runner


def test_rows_to_markdown_table_basic() -> None:
    md = markdown_utils.rows_to_markdown_table([["Name", "Score"], ["Ada", 10]])
    lines = md.splitlines()
    assert lines[0] == "| Name | Score |"
    assert lines[1] == "| --- | --- |"
    assert lines[2] == "| Ada | 10 |"


def test_rows_to_markdown_table_escapes_pipes_and_pads_short_rows() -> None:
    md = markdown_utils.rows_to_markdown_table([["A", "B", "C"], ["x|y"]])
    lines = md.splitlines()
    assert lines[2] == "| x\\|y |  |  |"


def test_rows_to_markdown_table_empty() -> None:
    assert markdown_utils.rows_to_markdown_table([]) == ""


def test_join_blocks_skips_empty() -> None:
    assert markdown_utils.join_blocks(["a", "", "b", None]) == "a\n\nb"


def test_io_ok_prints_json_and_exits_zero(capsys) -> None:
    try:
        script_runner.ok(value=7)
    except SystemExit as exc:
        assert exc.code == 0
    out = json.loads(capsys.readouterr().out)
    assert out == {"ok": True, "value": 7}


def test_io_fail_prints_json_and_exits_one(capsys) -> None:
    try:
        script_runner.fail("boom")
    except SystemExit as exc:
        assert exc.code == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"ok": False, "error": "boom"}
    assert "boom" in captured.err


def test_io_main_turns_exceptions_into_failure(capsys) -> None:
    def bad(_argv: list[str]) -> None:
        raise ValueError("nope")

    saved_argv = sys.argv
    sys.argv = ["script.py"]
    try:
        script_runner.main(bad)
    except SystemExit as exc:
        assert exc.code == 1
    finally:
        sys.argv = saved_argv
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert "ValueError: nope" in out["error"]


def test_io_main_passes_argv_tail(capsys) -> None:
    received: list[str] = []

    def collect(argv: list[str]) -> None:
        received.extend(argv)
        script_runner.ok()

    saved_argv = sys.argv
    sys.argv = ["script.py", "a", "b"]
    try:
        script_runner.main(collect)
    except SystemExit:
        pass
    finally:
        sys.argv = saved_argv
    assert received == ["a", "b"]
    capsys.readouterr()
