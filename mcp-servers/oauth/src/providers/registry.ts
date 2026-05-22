/**
 * Provider registry — single point where {@link OAuthProvider} implementations
 * are registered. Adding a new IdP = one entry here + one file under
 * `providers/<id>.ts`.
 */
import type { OAuthProvider } from './types.js';
import { microsoftProvider } from './microsoft.js';

const REGISTRY: Record<string, OAuthProvider> = {
  [microsoftProvider.id]: microsoftProvider,
};

/**
 * Look up a provider by its id (as stored in `OAuthState.provider`).
 * @param id - provider id
 * @returns the provider, or `undefined` if no implementation is registered
 */
export function getProvider(id: string): OAuthProvider | undefined {
  if (!id) return undefined;
  return REGISTRY[id];
}

/** List the ids of every registered provider — used in error messages. */
export function knownProviderIds(): readonly string[] {
  return Object.keys(REGISTRY);
}
