/**
 * Reads the resolved policy the host wrote for this project. Absent `POLICY_FILE` → default;
 * a present-yet-broken file throws (fail-closed) — callers must log and exit non-zero.
 * @module resolve
 */

import { existsSync, readFileSync } from 'fs';
import { defaultResolvedPolicy, parseResolvedPolicy } from './resolved-policy.js';
import type { ResolvedPolicy } from './types.js';

/**
 * Reason a value could not be turned into a message string (non-Error throw).
 * @param err - The caught value
 * @returns A best-effort message string
 */
function reasonOf(err: unknown): string {
  /* c8 ignore next — fs sync calls and JSON.parse only ever throw a real Error instance */
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the policy for this process: the default when `POLICY_FILE` is unset or absent;
 * otherwise read and strictly validate it, throwing on any failure.
 * @param env - Environment to read `POLICY_FILE` from (defaults to `process.env`)
 * @returns The resolved policy
 */
export function resolvePolicy(
  env: Record<string, string | undefined> = process.env
): ResolvedPolicy {
  const policyFile = env.POLICY_FILE;
  if (!policyFile || !existsSync(policyFile)) {
    return defaultResolvedPolicy();
  }

  let raw: string;
  try {
    raw = readFileSync(policyFile, 'utf-8');
  } catch (err) {
    throw new Error(`policy file "${policyFile}" could not be read: ${reasonOf(err)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`policy file "${policyFile}" is not valid JSON: ${reasonOf(err)}`);
  }

  return parseResolvedPolicy(json);
}
