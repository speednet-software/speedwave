/**
 * Shared conversation memory fact used across chat specs (09 plants it, 11
 * recalls it after a provider switch). Kept in a helper — NOT a spec file — so
 * importing it does not re-register another spec's `describe` suite.
 */

/** A fact stated in conversation and recalled later — kept in sync across specs.
 *  Phrased as a plain in-conversation statement (NOT "remember this" / not
 *  "your favourite") so the model reads it back from the transcript rather than
 *  reaching for a memory/Read tool. */
export const MEMORY_FACT = 'Note this number for later in our chat: 42.';

/** Substring the model's recall answer must contain. */
export const MEMORY_ANSWER = '42';

/** Recall prompt that points the model at the conversation history explicitly,
 *  so it answers from context instead of probing a memory file. */
export const MEMORY_RECALL_PROMPT =
  'Earlier in this conversation I gave you a number to note. Reply with only that number, nothing else.';

/** A prompt that reliably produces a long, purely-textual stream (no tool use),
 *  so the streaming window stays open long enough to exercise stop/queue. Asking
 *  to "count" tempts models into a task/tool call; a plain-prose essay does not. */
export const LONG_STREAM_PROMPT =
  'Write a detailed 300-word description of a walk through a forest in autumn. ' +
  'Reply with prose only — no lists, no tools, no code.';
