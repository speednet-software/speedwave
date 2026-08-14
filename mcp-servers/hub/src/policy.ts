/**
 * PII policy engine — startup file read (mirrors auth-tokens.ts).
 * @module policy
 *
 * Loads the WASM PII engine from `POLICY_FILE` + its sibling key file via `loadEngine()`.
 * Absent `POLICY_FILE` falls back to the engine's compiled-in default policy. Present-but-invalid
 * policy/key throws; `index.ts` is the single process-death point, so this module never calls
 * `process.exit`.
 */

import { loadEngine } from '@speedwave/policy-engine';
import type { PiiEngine } from '@speedwave/policy-engine';

let engine: PiiEngine | undefined;

/**
 * Load and initialize the PII engine for this process. Called once at server startup.
 * Throws (never exits) when `POLICY_FILE` is present but invalid, or its key is missing/bad
 * — fail-closed.
 */
export function loadPolicy(): void {
  engine = loadEngine();
}

/**
 * Get the PII engine for this process, lazily loading the compiled-in default (ignoring
 * `POLICY_FILE`) when `loadPolicy()` has not run yet.
 * @returns The PII engine in effect for this process
 */
export function getEngine(): PiiEngine {
  if (!engine) {
    engine = loadEngine({});
  }
  return engine;
}
