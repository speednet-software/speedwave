import type { OAuthProvider, ProviderId } from './types.js';
import { microsoftProvider } from './microsoft.js';

const REGISTRY: Record<ProviderId, OAuthProvider> = {
  microsoft: microsoftProvider,
};

/**
 * Look up by id; `undefined` when not registered.
 * @param id - provider id as stored in `OAuthState.provider`
 */
export function getProvider(id: string): OAuthProvider | undefined {
  if (!id) return undefined;
  return REGISTRY[id as ProviderId];
}

/**
 * Type-guard narrowing `string → ProviderId`.
 * @param id - provider id to check
 */
export function isKnownProviderId(id: string): id is ProviderId {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id);
}

/** Registered ids, for error messages. */
export function knownProviderIds(): readonly ProviderId[] {
  return Object.keys(REGISTRY) as ProviderId[];
}
