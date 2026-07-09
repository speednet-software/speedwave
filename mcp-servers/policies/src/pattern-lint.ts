/**
 * ReDoS defensive lint for user-supplied custom detection patterns, run at policy compile time.
 * @module pattern-lint
 */

/** Contract error codes — stable identifiers consumed by UI messages. */
export type PatternLintErrorCode =
  | 'TOO_LONG'
  | 'SYNTAX'
  | 'BACKREF'
  | 'LOOKAROUND'
  | 'UNBOUNDED_REPEAT'
  | 'NESTED_QUANTIFIER'
  | 'EMPTY_MATCH';

/** Successful lint outcome. */
export interface PatternLintOk {
  ok: true;
}

/** Failed lint outcome, carrying the contract error code and a human-readable reason. */
export interface PatternLintFailure {
  ok: false;
  code: PatternLintErrorCode;
  message: string;
}

/** The outcome of linting a pattern: either a success or a coded, messaged failure. */
export type PatternLintResult = PatternLintOk | PatternLintFailure;

const MIN_LENGTH = 3;
const MAX_LENGTH = 256;
const MAX_QUANTIFIER_COUNT = 128;

/** Numeric (`\1`) or named (`\k<name>`) backreference. */
const BACKREF_RE = /\\[1-9]|\\k</;

/** Lookahead/lookbehind, but not a plain non-capturing group `(?:`. */
const LOOKAROUND_RE = /\(\?(=|!|<=|<!)/;

/** A counted quantifier applied to a group (`){n,m}`); atom quantifiers are exempt from the cap. */
const GROUP_QUANTIFIER_RE = /\)\{(\d+)(?:,(\d*))?\}/g;

/**
 * A group immediately followed by an open-ended repeat. Misses nested-group forms like
 * `((a+)b)+` — the Rust save-gate is the authoritative lint.
 */
const GROUP_THEN_OPEN_ENDED_REPEAT_RE = /\((?:\?:)?((?:[^()]|\\.)*)\)(\*|\+|\{\d+,\})/g;

/**
 * True if `text` ends in a quantifier capable of more than one repetition with no upper bound.
 * @param text - Regex source fragment to check
 * @returns True if the fragment's trailing quantifier is open-ended
 */
function endsWithOpenEndedRepeat(text: string): boolean {
  return /(?:[*+]|\{\d+,\})$/.test(text);
}

/**
 * Validate a user-supplied regex source against the ReDoS contract rules.
 * @param pattern - Regex source (never a `RegExp` literal — the raw string as stored/edited)
 * @param caseInsensitive - Whether the pattern will be compiled with the `i` flag
 * @returns `{ ok: true }` or `{ ok: false, code, message }` naming the first rule violated
 */
export function lintPattern(pattern: string, caseInsensitive = false): PatternLintResult {
  if (pattern.length < MIN_LENGTH || pattern.length > MAX_LENGTH) {
    return {
      ok: false,
      code: 'TOO_LONG',
      message: `pattern length ${pattern.length} is outside the allowed ${MIN_LENGTH}..${MAX_LENGTH} range`,
    };
  }

  const flags = caseInsensitive ? 'i' : '';
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, flags);
  } catch (err) {
    return {
      ok: false,
      code: 'SYNTAX',
      /* c8 ignore next — the RegExp constructor only ever throws a SyntaxError instance */
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (BACKREF_RE.test(pattern)) {
    return { ok: false, code: 'BACKREF', message: 'backreferences are not allowed' };
  }

  if (LOOKAROUND_RE.test(pattern)) {
    return { ok: false, code: 'LOOKAROUND', message: 'lookahead/lookbehind are not allowed' };
  }

  for (const match of pattern.matchAll(GROUP_QUANTIFIER_RE)) {
    const bounds = [match[1], match[2]].filter((v): v is string => !!v);
    if (bounds.some((v) => Number(v) > MAX_QUANTIFIER_COUNT)) {
      return {
        ok: false,
        code: 'UNBOUNDED_REPEAT',
        message: `group quantifier "${match[0]}" exceeds the maximum of ${MAX_QUANTIFIER_COUNT}`,
      };
    }
  }

  for (const match of pattern.matchAll(GROUP_THEN_OPEN_ENDED_REPEAT_RE)) {
    const [, inner] = match;
    if (endsWithOpenEndedRepeat(inner)) {
      return {
        ok: false,
        code: 'NESTED_QUANTIFIER',
        message: `"${match[0]}" nests an open-ended repeat inside another open-ended repeat`,
      };
    }
  }

  if (compiled.test('')) {
    return { ok: false, code: 'EMPTY_MATCH', message: 'pattern matches the empty string' };
  }

  return { ok: true };
}
