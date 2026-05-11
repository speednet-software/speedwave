"""Render a chart spec to a PNG/SVG image (matplotlib, Agg backend — headless).

Usage: ``python3 render_chart.py <output.(png|svg)> <json-spec>``
`json-spec` = {"type": "bar"|"line"|"pie"|"scatter"|"area", "title"?, "xlabel"?, "ylabel"?,
              "format"?, "width"?, "height"?, "data": {"labels": [...], "series": [{"name", "values"}]}}
Output: {"ok": true, "path": "<output>"}
"""

from __future__ import annotations

import json

# Force the non-interactive backend before importing pyplot — no X11, works under read-only rootfs.
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from script_runner import main, ok, fail  # noqa: E402


def _validate(spec: dict) -> None:
    """Re-check the spec server-side (the TS layer also validates; defence in depth)."""
    if spec.get("type") not in ("bar", "line", "pie", "scatter", "area"):
        fail("spec.type must be one of bar|line|pie|scatter|area")
    data = spec.get("data") or {}
    labels = data.get("labels")
    series = data.get("series")
    if not isinstance(labels, list) or not all(isinstance(x, str) for x in labels):
        fail("spec.data.labels must be a list of strings")
    if not isinstance(series, list) or not series:
        fail("spec.data.series must be a non-empty list")
    for i, ser in enumerate(series):
        if not isinstance(ser.get("name"), str) or not ser["name"]:
            fail(f"spec.data.series[{i}].name must be a non-empty string")
        vals = ser.get("values")
        if not isinstance(vals, list) or not all(isinstance(v, (int, float)) for v in vals):
            fail(f"spec.data.series[{i}].values must be a list of numbers")
        if len(vals) != len(labels):
            fail(f"spec.data.series[{i}].values length {len(vals)} != labels length {len(labels)}")


def _run(argv: list[str]) -> None:
    if len(argv) != 2:
        fail("usage: render_chart.py <output.(png|svg)> <json-spec>")
    output, spec = argv[0], json.loads(argv[1])
    _validate(spec)
    kind = spec["type"]
    labels = spec["data"]["labels"]
    series = spec["data"]["series"]
    width = float(spec.get("width") or 8)
    height = float(spec.get("height") or 5)
    fmt = spec.get("format") or "png"

    fig, ax = plt.subplots(figsize=(width, height))
    try:
        if kind == "pie":
            # Pie uses the first series only.
            ax.pie(series[0]["values"], labels=labels, autopct="%1.1f%%")
            ax.axis("equal")
        elif kind == "scatter":
            x = list(range(len(labels)))
            for ser in series:
                ax.scatter(x, ser["values"], label=ser["name"])
            ax.set_xticks(x)
            ax.set_xticklabels(labels, rotation=45, ha="right")
            ax.legend()
        elif kind == "line" or kind == "area":
            x = list(range(len(labels)))
            for ser in series:
                if kind == "area":
                    ax.fill_between(x, ser["values"], alpha=0.4, label=ser["name"])
                else:
                    ax.plot(x, ser["values"], marker="o", label=ser["name"])
            ax.set_xticks(x)
            ax.set_xticklabels(labels, rotation=45, ha="right")
            ax.legend()
        else:  # bar
            import numpy as np

            x = np.arange(len(labels))
            n = len(series)
            bar_w = 0.8 / n
            for idx, ser in enumerate(series):
                ax.bar(x + idx * bar_w - 0.4 + bar_w / 2, ser["values"], bar_w, label=ser["name"])
            ax.set_xticks(x)
            ax.set_xticklabels(labels, rotation=45, ha="right")
            ax.legend()

        if spec.get("title"):
            ax.set_title(str(spec["title"]))
        if spec.get("xlabel") and kind != "pie":
            ax.set_xlabel(str(spec["xlabel"]))
        if spec.get("ylabel") and kind != "pie":
            ax.set_ylabel(str(spec["ylabel"]))
        fig.tight_layout()
        fig.savefig(output, format=fmt)
    finally:
        plt.close(fig)
    ok(path=output)


if __name__ == "__main__":
    main(_run)
