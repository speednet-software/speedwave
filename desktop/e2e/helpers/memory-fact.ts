/**
 * Shared conversation memory fact used across chat specs (09 plants it, 11
 * recalls it after a provider switch). Kept in a helper — NOT a spec file — so
 * importing it does not re-register another spec's `describe` suite.
 */

/** A fact stated in conversation and recalled later — kept in sync across specs.
 *  Phrased as a plain statement (NOT "remember this") so the model answers in
 *  text rather than reaching for a memory/Write tool. */
export const MEMORY_FACT = 'For this chat, my favourite number is 42.';

/** Substring the model's recall answer must contain. */
export const MEMORY_ANSWER = '42';
