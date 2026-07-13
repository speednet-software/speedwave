/**
 * SSOT for strict numeric-id normalization shared by github/gitlab: positive-integer number or its
 * string form (optionally prefixed, e.g. '#'/'!').
 * @module shared/numeric-id
 */

/** Teaching data for a rejected numeric id (assignable to `TeachingErrorParams`). */
export interface NumericIdError {
  /** Name of the invalid parameter. */
  paramName: string;
  /** The value that was actually received. */
  received: unknown;
  /** Suggested next step for the model to take. */
  nextStep: string;
}

/** Result of {@link normalizeNumericId}: the parsed number, or teaching-error data. */
export type NumericIdResult = { ok: true; value: number } | { ok: false; error: NumericIdError };

/** Options controlling how a numeric id is parsed. */
export interface NumericIdOptions {
  /** Single-character prefixes strippable from a string form (e.g. `['#', '!']`). */
  prefixes?: readonly string[];
}

/**
 * Build the teaching next-step string for a rejected numeric id.
 * @param paramName - Name of the invalid parameter.
 * @param prefixes - Single-character prefixes allowed on the string form.
 */
function numericIdNextStep(paramName: string, prefixes: readonly string[]): string {
  if (prefixes.length === 0) {
    return `Pass ${paramName} as a positive integer or its digit string (e.g. 42 or "42").`;
  }
  const quoted = prefixes.map((p) => `'${p}'`).join(' or ');
  return `Pass ${paramName} as a positive integer or its digit string, optionally prefixed with ${quoted} (e.g. 42 or "${prefixes[0]}42").`;
}

/**
 * Normalize one numeric id. A number must be a positive integer; a string must be all digits after
 * stripping one allowed prefix (rejects "4.5", "-3", "0x2A", "1e3").
 * @param value - The raw value to normalize.
 * @param paramName - Name of the parameter (used in teaching-error output).
 * @param options - Options controlling prefix stripping.
 */
export function normalizeNumericId(
  value: unknown,
  paramName: string,
  options?: NumericIdOptions
): NumericIdResult {
  const prefixes = options?.prefixes ?? [];
  const fail = (): NumericIdResult => ({
    ok: false,
    error: { paramName, received: value, nextStep: numericIdNextStep(paramName, prefixes) },
  });
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? { ok: true, value } : fail();
  }
  if (typeof value === 'string') {
    let s = value.trim();
    for (const p of prefixes) {
      if (p !== '' && s.startsWith(p)) {
        s = s.slice(p.length).trim();
        break;
      }
    }
    if (!/^\d+$/.test(s)) return fail();
    const n = Number(s);
    return Number.isInteger(n) && n > 0 ? { ok: true, value: n } : fail();
  }
  return fail();
}

/** Result of {@link normalizeNumericIdParams}: the coerced params, or teaching-error data. */
export type NumericIdParamsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: NumericIdError };

/**
 * Normalize the named numeric-id params of a params object in place (on a copy). Params absent or
 * `undefined` are left untouched; present params are validated via {@link normalizeNumericId}.
 * @param params - The params object to normalize (not mutated).
 * @param paramNames - Names of the params to validate as numeric ids.
 * @param options - Options controlling prefix stripping, forwarded to {@link normalizeNumericId}.
 */
export function normalizeNumericIdParams(
  params: Record<string, unknown>,
  paramNames: readonly string[],
  options?: NumericIdOptions
): NumericIdParamsResult {
  let result = params;
  for (const key of paramNames) {
    if (!(key in result)) continue;
    const value = result[key];
    if (value === undefined) continue;
    const normalized = normalizeNumericId(value, key, options);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    result = { ...result, [key]: normalized.value };
  }
  return { ok: true, value: result };
}
