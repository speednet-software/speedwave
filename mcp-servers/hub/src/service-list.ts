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
 * Camel-cases dashes out of a service name: a dashed slug (`my-plugin`) is an invalid
 * AsyncFunction parameter and breaks the sandbox. Caller (`executor.ts`) validates the result.
 * @param service - Service name as it appears in ENABLED_SERVICES
 * @returns The service name with dashes removed and following chars upper-cased
 */
export function sandboxGlobalName(service: string): string {
  return service.replace(/-+([a-zA-Z0-9])?/g, (_, c: string | undefined) =>
    c ? c.toUpperCase() : ''
  );
}
