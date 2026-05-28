/** SSOT for project swatch color — deterministic by position in the project list. */
const SWATCH_TOKENS = ['var(--violet)', 'var(--teal)', 'var(--amber)', 'var(--accent)'] as const;

/**
 * Returns the swatch color for a project at the given list position.
 * @param index - Zero-based position in the project list; negative values are treated as 0.
 */
export function swatchFor(index: number): string {
  const safe = index < 0 ? 0 : index;
  return SWATCH_TOKENS[safe % SWATCH_TOKENS.length];
}
