/**
 * Per-service PII mode: whether tool arguments reach a worker detokenized (`plaintext`) or still tokenized (`tokens`).
 * Read once at startup from the optional `services` field of the hub's own `POLICY_FILE`; never from worker `_meta`.
 * @module pii-mode
 */

import { existsSync, readFileSync } from 'node:fs';
import { CUSTOM_SERVICE_PREFIX } from './service-list.js';

/** How personal data in tool arguments reaches a worker. */
export type PiiMode = 'tokens' | 'plaintext';

let explicitModes: ReadonlyMap<string, PiiMode> = new Map();

/**
 * Whether a value is a non-null, non-array object.
 * @param value - Value to test.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the optional `services` field of a policy document into explicit per-service modes; throws on a malformed field.
 * @param policy - Parsed `policy.json`.
 */
export function parseServicePiiModes(policy: unknown): Map<string, PiiMode> {
  const modes = new Map<string, PiiMode>();
  if (!isRecord(policy) || policy.services === undefined) return modes;
  if (!isRecord(policy.services)) throw new Error('policy "services" must be an object');
  for (const [service, entry] of Object.entries(policy.services)) {
    const mode = isRecord(entry) ? entry.pii_mode : undefined;
    if (mode !== 'tokens' && mode !== 'plaintext') {
      throw new Error(`policy "services.${service}.pii_mode" must be "tokens" or "plaintext"`);
    }
    modes.set(service, mode);
  }
  return modes;
}

/**
 * Load explicit per-service modes from `POLICY_FILE`; an absent file leaves only the defaults. Throws (fail-closed) on a malformed `services` field.
 * @param env - Environment to read `POLICY_FILE` from.
 */
export function loadServicePiiModes(env: Record<string, string | undefined> = process.env): void {
  const file = env.POLICY_FILE;
  if (!file || !existsSync(file)) {
    explicitModes = new Map();
    return;
  }
  explicitModes = parseServicePiiModes(JSON.parse(readFileSync(file, 'utf-8')));
}

/**
 * The PII mode of a service: an explicit policy entry wins, `custom-*` services default to `tokens`, every other service to `plaintext`.
 * @param service - Hub service id.
 */
export function piiModeFor(service: string): PiiMode {
  return (
    explicitModes.get(service) ??
    (service.startsWith(CUSTOM_SERVICE_PREFIX) ? 'tokens' : 'plaintext')
  );
}

/**
 * Test-only: replace the explicit per-service modes.
 * @param modes - Explicit modes to use.
 * @internal
 */
export function _setServicePiiModesForTesting(modes: ReadonlyMap<string, PiiMode>): void {
  explicitModes = modes;
}
