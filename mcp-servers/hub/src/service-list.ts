/**
 * Service List - Dynamic service enumeration
 * @module service-list
 *
 * Parses ENABLED_SERVICES env var to build a service list.
 *
 * IMPORTANT: This module has ZERO imports from other hub modules
 * to prevent import cycles. It reads process.env directly.
 */

/**
 * Get all service names from ENABLED_SERVICES env var.
 * Returns only services that are explicitly enabled.
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
