/**
 * Service List - Dynamic service enumeration.
 * Parses ENABLED_SERVICES env var; zero hub-module imports.
 */

/**
 * Get explicitly enabled service names from ENABLED_SERVICES env var.
 * @returns Array of enabled service names
 */
export function getAllServiceNames(): string[] {
  const envVal = process.env.ENABLED_SERVICES;
  if (!envVal) return [];
  return envVal
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Sandbox global for a service: dashes camelCased away, because a dashed plugin slug
 * (e.g. `my-plugin`) is an invalid AsyncFunction parameter name and breaks the whole sandbox.
 * @param service - Service name as it appears in ENABLED_SERVICES
 * @returns Valid JS identifier used as the execute_code global
 */
export function sandboxGlobalName(service: string): string {
  return service.replace(/-+([a-zA-Z0-9])?/g, (_, c: string | undefined) =>
    c ? c.toUpperCase() : ''
  );
}
