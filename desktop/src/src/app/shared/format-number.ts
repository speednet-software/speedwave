/** Shared token/USD formatters — one Intl instance (allocations are not free). */
const NUMBER_FMT = new Intl.NumberFormat('en-US');

/**
 * Formats a token count with en-US thousands separators.
 * @param n - Raw token count.
 */
export function formatTokens(n: number): string {
  return NUMBER_FMT.format(n);
}

/**
 * Formats a USD amount as `$X.XX`; `decimals` defaults to 4, each call site passes its own precision.
 * @param n - Amount in dollars.
 * @param decimals - Fixed decimal places (default 4).
 */
export function formatUsd(n: number, decimals = 4): string {
  return `$${n.toFixed(decimals)}`;
}
