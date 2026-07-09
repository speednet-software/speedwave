/**
 * PII policy — startup file read (mirrors auth-tokens.ts).
 * @module policy
 *
 * Reads the resolved policy the host wrote for this project via `POLICY_FILE`. Absent/missing
 * → the compiled-in default (all categories on). Present-but-invalid → throws; `index.ts` is the
 * single process-death point, so this module never calls `process.exit`.
 */

import { resolvePolicy, compilePolicy, defaultResolvedPolicy } from '@speedwave/policy-engine';
import type { CompiledPolicy } from '@speedwave/policy-engine';

let compiledPolicy: CompiledPolicy | undefined;

/**
 * Load and compile the policy for this process. Called once at server startup.
 * Throws (never exits) when `POLICY_FILE` is present but invalid — fail-closed.
 */
export function loadPolicy(): void {
  compiledPolicy = compilePolicy(resolvePolicy());
}

/**
 * Get the compiled policy for this process, lazily compiling the default when
 * `loadPolicy()` has not run yet.
 * @returns The compiled policy in effect for this process
 */
export function getCompiledPolicy(): CompiledPolicy {
  if (!compiledPolicy) {
    compiledPolicy = compilePolicy(defaultResolvedPolicy());
  }
  return compiledPolicy;
}
