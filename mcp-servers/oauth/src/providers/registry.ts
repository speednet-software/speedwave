import type { OAuthProvider, ProviderId } from './types.js';
import { microsoftProvider } from './microsoft.js';
import { genericProvider } from './generic.js';

const REGISTRY: Record<ProviderId, OAuthProvider> = {
  microsoft: microsoftProvider,
  generic: genericProvider,
};

/**
 * Look up by id; `undefined` when not registered.
 * @param id - provider id as stored in `OAuthState.provider`
 */
export function getProvider(id: string): OAuthProvider | undefined {
  if (!id) return undefined;
  return REGISTRY[id as ProviderId];
}

/** Registered ids, for error messages. */
export function knownProviderIds(): readonly ProviderId[] {
  return Object.keys(REGISTRY) as ProviderId[];
}
