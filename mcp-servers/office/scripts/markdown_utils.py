"""Markdown helpers shared by the office worker's Python support-scripts.

Currently: turning a 2-D list of cell values into a GitHub-flavoured Markdown table
with pipe-escaping. Kept tiny and dependency-free so every script can import it.
"""

from __future__ import annotations

from typing import Iterable, Sequence


def _escape_cell(value: object) -> str:
    """Render a cell value as Markdown-table-safe text (escape ``\\`` then ``|``, collapse newlines)."""
    text = "" if value is None else str(value)
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\r\n", " ").replace("\n", " ")


def rows_to_markdown_table(rows: Sequence[Sequence[object]]) -> str:
    """Render ``rows`` (first row is the header) as a Markdown table.

    Args:
        rows: A non-empty sequence of rows; each row is a sequence of cell values.

    Returns:
        The Markdown table as a string. If ``rows`` is empty, returns an empty string.
    """
    rows = [list(r) for r in rows]
    if not rows:
        return ""
    width = max(len(r) for r in rows)

    def pad(r: list[object]) -> list[str]:
        r = list(r) + [""] * (width - len(r))
        return [_escape_cell(c) for c in r]

    header, *body = rows
    lines = [
        "| " + " | ".join(pad(header)) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
    ]
    for row in body:
        lines.append("| " + " | ".join(pad(row)) + " |")
    return "\n".join(lines)


def join_blocks(blocks: Iterable[str]) -> str:
    """Join non-empty Markdown blocks with blank lines between them."""
    return "\n\n".join(b for b in blocks if b)
