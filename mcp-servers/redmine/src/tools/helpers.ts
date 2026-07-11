/**
 * Redmine Helper Functions
 */

import type { RedmineMappings } from '../client.js';

/**
 * Friendly-name fields resolveParams maps to a mapping-derived `*_id`.
 * SSOT for formatValidationError's hint-attribution keys; do not duplicate this list.
 */
export const MAPPABLE_FIELDS = ['status', 'priority', 'tracker', 'activity'] as const;

/**
 * Error thrown when a friendly field name cannot be resolved to an ID
 */
export class MappingError extends Error {
  public readonly field: string;
  public readonly value: unknown;
  public readonly availableValues: string[];

  /**
   * Create a new MappingError
   * @param field - The field name that failed mapping (e.g., 'status', 'priority')
   * @param value - The value that could not be mapped
   * @param availableValues - List of valid values for the field
   */
  constructor(field: string, value: unknown, availableValues: string[]) {
    super(
      `Unknown ${field}: "${value}". Available values: ${availableValues.length > 0 ? availableValues.join(', ') : 'none configured'}`
    );
    this.name = 'MappingError';
    this.field = field;
    this.value = value;
    this.availableValues = availableValues;
  }
}

/**
 * Get available values for a given field type from mappings
 * @param mappings - Parameter mappings
 * @param prefix - Field prefix (e.g., 'status_', 'priority_')
 */
function getAvailableValues(mappings: RedmineMappings, prefix: string): string[] {
  return Object.keys(mappings)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.replace(prefix, ''));
}

/**
 * Resolve friendly names to IDs using project-specific mappings.
 * Throws MappingError if a friendly name is provided but no mapping exists.
 * @param params - Tool parameters
 * @param mappings - Parameter mappings
 * @throws {MappingError} If a friendly field name has no corresponding mapping
 */
export function resolveParams(
  params: Record<string, unknown>,
  mappings: RedmineMappings
): Record<string, unknown> {
  const resolved = { ...params };

  for (const field of MAPPABLE_FIELDS) {
    const idField = `${field}_id`;
    if (resolved[field] && !resolved[idField]) {
      const key = `${field}_${resolved[field]}`;
      const id = mappings[key];
      if (id) {
        resolved[idField] = id;
      } else {
        throw new MappingError(field, resolved[field], getAvailableValues(mappings, `${field}_`));
      }
      delete resolved[field];
    }
  }

  return resolved;
}
