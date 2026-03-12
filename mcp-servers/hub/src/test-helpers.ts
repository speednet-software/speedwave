/**
 * Shared test helpers for hub tests.
 * @module test-helpers
 */

import { TOOL_REGISTRY, _resetRegistryForTesting } from './tool-registry.js';
import { SUPPORTED_SERVICES, getServicePolicies } from './hub-tool-policy.js';
import { buildSkeletonFromPolicy } from './tool-discovery.js';
import type { ToolMetadata } from './hub-types.js';

/**
 * Populate registry with skeleton entries from policies.
 * Simulates what initializeRegistry() does when workers are unavailable.
 * Must be called after _resetRegistryForTesting().
 */
export function populateRegistryFromPolicies(): void {
  // Cast to mutable for test setup — production code uses Readonly export
  const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
  for (const service of SUPPORTED_SERVICES) {
    const policies = getServicePolicies(service);
    mutableRegistry[service] = {};
    for (const [methodName, policy] of Object.entries(policies)) {
      mutableRegistry[service][methodName] = buildSkeletonFromPolicy(service, methodName, policy);
    }
  }
}

export { _resetRegistryForTesting };
