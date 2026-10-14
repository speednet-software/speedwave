/** Tailwind classes of one usage threshold: `bar` fills a meter, `text` colours a stroke. */
export interface UsageColor {
  bar: string;
  text: string;
}

/**
 * Threshold colours shared by the context ring and the plan limit bars: green below 50%,
 * amber from 50%, red from 77%.
 * @param pct - Percentage in the range 0-100.
 */
export function usageColor(pct: number): UsageColor {
  if (pct >= 77) return { bar: 'bg-red-500', text: 'text-red-500' };
  if (pct >= 50) return { bar: 'bg-[var(--amber)]', text: 'text-[var(--amber)]' };
  return { bar: 'bg-[var(--green)]', text: 'text-[var(--green)]' };
}
