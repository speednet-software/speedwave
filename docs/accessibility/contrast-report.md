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

`--on-accent` (text/icon drawn on top of a filled accent) is tuned per accent
per mode: white on the saturated reds/violets, dark ink on the pastels.

## Waivers

None. Every shipped `(mode × accent)` pair passes the axe-core AA sweep with no
waived rules. Add an entry here (with the rule id, the surface, and the
justification) only if a future change requires accepting a documented
exception.
