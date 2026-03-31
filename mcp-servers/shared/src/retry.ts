/**
 * Retry utility for MCP client initialization.
 * Exponential backoff with jitter for transient failures (DNS, network, timeout).
 * @module shared/retry
 */

import { ts } from './logger.js';

/** Options for {@link retryAsync}. */
export interface RetryOptions {
  /** Maximum number of retry attempts (not counting the initial attempt). Default: 3 */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 2000 (2 s) */
  baseDelayMs?: number;
  /** Maximum delay in ms (cap). Default: 15000 (15 s) */
  maxDelayMs?: number;
  /** Label for log messages (e.g. "GitLab client init"). */
  label?: string;
}

/**
 * Retry an async function with exponential backoff and jitter.
 *
 * The initial call counts as attempt 0. If it returns `null` **or throws**,
 * and `maxRetries` has not been reached, the function is retried after an
 * increasing delay.
 *
 * Exceptions from `fn` are caught and logged — they do **not** propagate.
 * This is critical because `initializeGitLabClient()` can throw on DNS
 * resolution failures (`TypeError` from fetch) rather than returning `null`.
 * @param fn - Async function to retry. Must return `T` on success or `null` on failure.
 * @param options - Retry configuration
 * @returns The result of `fn`, or `null` if all attempts failed
 */
export async function retryAsync<T>(
  fn: () => Promise<T | null>,
  options: RetryOptions = {}
): Promise<T | null> {
  const { maxRetries = 3, baseDelayMs = 2000, maxDelayMs = 15000, label = 'operation' } = options;

  let result = await tryCall(fn, label);
  if (result !== null) return result;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    // Jitter is additive (0–30% of base delay). maxDelayMs caps only the base
    // component, so totalDelay can exceed maxDelayMs by up to 30%.
    const jitter = Math.floor(Math.random() * delay * 0.3);
    const totalDelay = delay + jitter;

    console.log(`${ts()} ⏳ ${label}: retry ${attempt}/${maxRetries} in ${totalDelay}ms...`);
    await sleep(totalDelay);

    result = await tryCall(fn, label);
    if (result !== null) {
      console.log(`${ts()} ✅ ${label}: succeeded on retry ${attempt}`);
      return result;
    }
  }

  console.warn(`${ts()} ❌ ${label}: all ${maxRetries} retries exhausted`);
  return null;
}

/**
 * Call `fn`, catching any exception and returning `null`.
 * @param fn - Function to call
 * @param label - Label for log messages
 */
async function tryCall<T>(fn: () => Promise<T | null>, label: string): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${ts()} ⚠️ ${label}: attempt failed with error: ${message}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
