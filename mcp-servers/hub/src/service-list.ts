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
