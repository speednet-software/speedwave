/**
 * Service List - Dynamic service enumeration for plugin support
 * @module service-list
 *
 * Parses ENABLED_SERVICES env var to build a unified service list
 * that includes both built-in and plugin services.
 *
 * IMPORTANT: This module has ZERO imports from other hub modules
 * to prevent import cycles. It reads process.env directly.
 */

/**
 * Built-in service names (logical IDs, not compose names).
 * These are the services shipped with Speedwave.
 */
export const BUILT_IN_SERVICES = ['slack', 'sharepoint', 'redmine', 'gitlab', 'os'] as const;

/**
 * Parse ENABLED_SERVICES env var into a Set.
 * @returns Set of enabled service names
 */
function parseEnabledServices(): Set<string> {
  const envVal = process.env.ENABLED_SERVICES;
  if (!envVal) return new Set();
  return new Set(
    envVal
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Get all service names: built-in + any plugin services found in ENABLED_SERVICES.
 * Plugin services are those present in ENABLED_SERVICES but not in BUILT_IN_SERVICES.
 * @returns Array of all service names (built-in first, then plugins)
 */
export function getAllServiceNames(): string[] {
  const enabled = parseEnabledServices();
  const builtIn = new Set<string>(BUILT_IN_SERVICES);
  const pluginServices = [...enabled].filter((s) => !builtIn.has(s));
  return [...BUILT_IN_SERVICES, ...pluginServices];
}

/**
 * Check if a service is a plugin (not a built-in service).
 * @param service - Service name to check
 * @returns true if the service is not in BUILT_IN_SERVICES
 */
export function isPluginService(service: string): boolean {
  return !(BUILT_IN_SERVICES as readonly string[]).includes(service);
}
