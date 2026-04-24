# Color Contrast Report

WCAG 2.1 AA contrast measurements for every foreground/background token pair in
the Speedwave terminal-minimal design system. Tokens are defined in
[`desktop/src/src/styles.css`](../../desktop/src/src/styles.css) and ported
from [`design-proposals/06-terminal-minimal.html`](../../design-proposals/06-terminal-minimal.html).

WCAG AA targets:

- Body text: **4.5:1**
- Large text and UI chrome: **3.0:1**
- Non-text UI components (focus indicators, dividers): **3.0:1**

Each section below lists the measured ratio and a PASS/FAIL verdict for the
token pair. The `TBD` rows are filled in by the accessibility sweep unit
(Wave 6) using a reproducible tool (axe-core / Stark / Contrast Finder).

## Token inventory

Base palette (shared across every theme):

| Token           | Hex                       |
| --------------- | ------------------------- |
| `--bg`          | `#07090f`                 |
| `--bg-1`        | `#0b0e18`                 |
| `--bg-2`        | `#10141f`                 |
| `--bg-3`        | `#161b2a`                 |
| `--line`        | `#1a2030`                 |
| `--line-strong` | `#252c42`                 |
| `--ink`         | `#e8edf7`                 |
| `--ink-dim`     | `#9aa3ba`                 |
| `--ink-mute`    | `#707a96`                 |
| `--accent`      | `#ff4d6d` (rose, default) |
| `--accent-dim`  | `#c9304e`                 |
| `--teal`        | `#22d3b7`                 |
| `--amber`       | `#f5b942`                 |
| `--green`       | `#34d399`                 |
| `--violet`      | `#a78bfa`                 |

Accent overrides per theme:

| Theme          | `--accent` | `--accent-dim` |
| -------------- | ---------- | -------------- |
| default (rose) | `#ff4d6d`  | `#c9304e`      |
| `mint`         | `#5eead4`  | `#2dd4bf`      |
| `amber`        | `#f5b942`  | `#d99a24`      |
| `iris`         | `#a78bfa`  | `#8b5cf6`      |
| `cyan`         | `#38bdf8`  | `#0ea5e9`      |
| `sand`         | `#d4a574`  | `#a97f4e`      |

## Body text on backgrounds

<!-- Content to be written: Wave 6 fills with measured ratios. -->

| Foreground   | Background | Ratio | Minimum | Status |
| ------------ | ---------- | ----- | ------- | ------ |
| `--ink`      | `--bg`     | TBD   | 4.5:1   | TBD    |
| `--ink`      | `--bg-1`   | TBD   | 4.5:1   | TBD    |
| `--ink`      | `--bg-2`   | TBD   | 4.5:1   | TBD    |
| `--ink`      | `--bg-3`   | TBD   | 4.5:1   | TBD    |
| `--ink-dim`  | `--bg`     | TBD   | 4.5:1   | TBD    |
| `--ink-dim`  | `--bg-1`   | TBD   | 4.5:1   | TBD    |
| `--ink-dim`  | `--bg-2`   | TBD   | 4.5:1   | TBD    |
| `--ink-dim`  | `--bg-3`   | TBD   | 4.5:1   | TBD    |
| `--ink-mute` | `--bg`     | TBD   | 4.5:1   | TBD    |
| `--ink-mute` | `--bg-1`   | TBD   | 4.5:1   | TBD    |
| `--ink-mute` | `--bg-2`   | TBD   | 4.5:1   | TBD    |
| `--ink-mute` | `--bg-3`   | TBD   | 4.5:1   | TBD    |

## Accent text on backgrounds (per theme)

<!-- Content to be written: Wave 6 fills per-theme measurements. -->

### Default (rose)

| Foreground     | Background | Ratio | Minimum | Status |
| -------------- | ---------- | ----- | ------- | ------ |
| `--accent`     | `--bg`     | TBD   | 4.5:1   | TBD    |
| `--accent`     | `--bg-1`   | TBD   | 4.5:1   | TBD    |
| `--accent-dim` | `--bg`     | TBD   | 4.5:1   | TBD    |

### Mint, Amber, Iris, Cyan, Sand

TBD — Wave 6 fills with measured ratios per theme.

## Semantic colors on backgrounds

<!-- Content to be written: Wave 6 fills with measured ratios. -->

| Foreground | Background | Ratio | Minimum | Status |
| ---------- | ---------- | ----- | ------- | ------ |
| `--teal`   | `--bg`     | TBD   | 4.5:1   | TBD    |
| `--teal`   | `--bg-1`   | TBD   | 4.5:1   | TBD    |
| `--amber`  | `--bg`     | TBD   | 4.5:1   | TBD    |
| `--amber`  | `--bg-1`   | TBD   | 4.5:1   | TBD    |
| `--green`  | `--bg`     | TBD   | 4.5:1   | TBD    |
| `--green`  | `--bg-1`   | TBD   | 4.5:1   | TBD    |
| `--violet` | `--bg`     | TBD   | 4.5:1   | TBD    |
| `--violet` | `--bg-1`   | TBD   | 4.5:1   | TBD    |

## UI chrome (dividers, borders)

Non-text contrast target: 3.0:1 per WCAG 1.4.11.

<!-- Content to be written: Wave 6 fills with measured ratios. -->

| Element         | Against  | Ratio | Minimum | Status |
| --------------- | -------- | ----- | ------- | ------ |
| `--line`        | `--bg`   | TBD   | 3.0:1   | TBD    |
| `--line`        | `--bg-1` | TBD   | 3.0:1   | TBD    |
| `--line-strong` | `--bg`   | TBD   | 3.0:1   | TBD    |
| `--line-strong` | `--bg-1` | TBD   | 3.0:1   | TBD    |

## Focus indicator

The global `:focus-visible` style uses a double-ring pattern — 2px `--accent`
wrapped by 2px `--bg`. The outer `--bg` ring ensures the inner accent ring
remains distinguishable against any neighbouring color.

<!-- Content to be written: Wave 6 measures accent-on-bg contrast per theme. -->

TBD — Wave 6 fills with measured ratios.

## Methodology

<!-- Content to be written: Wave 6 documents the tool used and steps. -->

TBD.

## Remediations

<!-- Content to be written: Wave 6 lists any failing pair and the proposed replacement. -->

TBD.
