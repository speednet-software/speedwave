# Contrast Report

WCAG 2.1 AA contrast tracking for the Desktop UI.

## Automated sweep

`desktop/src/src/app/a11y.spec.ts` runs axe-core against every reachable view in
every `(effective-mode × accent)` pair the app ships — both `light` and `dark`
effective modes crossed with all six accents (crimson, mint, amber, iris, cyan,
sand). The `auto` mode resolves to one of the two effective modes and is covered
by the `ThemeService` unit tests rather than re-swept here.

A failing run blocks merge: any view that introduces text/icon contrast below
WCAG AA against the active background fails the sweep with the offending rule,
node count, and the `(mode, accent)` pair.

## Accent calibration

Accent colors are defined as CSS custom properties in
`desktop/src/src/styles.css`:

- Dark mode (`:root` + `[data-theme='…']`) uses the original terminal-minimal
  palette.
- Light mode (`:root:not(.dark)` + `:root:not(.dark)[data-theme='…']`) uses
  darker, more saturated accent hexes so each accent clears AA contrast against
  the light `--bg`.

`--on-accent` (text/icon drawn on a filled accent, e.g. `.btn-outline-accent`
on hover) is tuned per accent per mode for ≥4.5:1 (WCAG AA normal text):

| accent  | dark `--on-accent` | ratio | light `--on-accent` | ratio |
| ------- | ------------------ | ----- | ------------------- | ----- |
| crimson | `#07090f`          | 6.19  | `#ffffff`           | 6.00  |
| mint    | `#07090f`          | 13.46 | `#ffffff`           | 5.28  |
| amber   | `#07090f`          | 11.28 | `#ffffff`           | 4.69  |
| iris    | `#07090f`          | 7.31  | `#ffffff`           | 7.10  |
| cyan    | `#07090f`          | 9.29  | `#ffffff`           | 5.36  |
| sand    | `#07090f`          | 8.94  | `#ffffff`           | 5.87  |

Dark mode keeps dark ink on every accent — white would fail crimson (3.21:1)
and iris (2.72:1). Light mint uses `--accent: #0a7a64` (not `#0d8a72`, which was
4.29:1) so the filled button and the `text-accent` usage both clear AA.

## Coverage limits

The axe-core sweep validates structural a11y (roles, labels, focus order) and
DOM-resolved contrast. It runs in jsdom, which does **not** resolve CSS custom
properties, so accent/`--on-accent` contrast on filled surfaces is **not**
caught by the automated sweep — those ratios are verified by calculation (the
table above) and must be re-checked by hand when an accent hex changes.

## Waivers

None. Every shipped `(mode × accent)` pair clears WCAG AA per the table above.
Add an entry here (rule id, surface, justification) only if a future change
requires accepting a documented exception.
