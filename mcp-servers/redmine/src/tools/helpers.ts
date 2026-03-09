/**
 * Redmine Helper Functions
 */

import { RedmineMappings } from '../client.js';

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

  // Map status → status_id
  if (resolved.status && !resolved.status_id) {
    const key = `status_${resolved.status}`;
    const id = mappings[key];
    if (id) {
      resolved.status_id = id;
    } else {
      throw new MappingError('status', resolved.status, getAvailableValues(mappings, 'status_'));
    }
    delete resolved.status;
  }

  // Map priority → priority_id
  if (resolved.priority && !resolved.priority_id) {
    const key = `priority_${resolved.priority}`;
    const id = mappings[key];
    if (id) {
      resolved.priority_id = id;
    } else {
      throw new MappingError(
        'priority',
        resolved.priority,
        getAvailableValues(mappings, 'priority_')
      );
    }
    delete resolved.priority;
  }

  // Map tracker → tracker_id
  if (resolved.tracker && !resolved.tracker_id) {
    const key = `tracker_${resolved.tracker}`;
    const id = mappings[key];
    if (id) {
      resolved.tracker_id = id;
    } else {
      throw new MappingError('tracker', resolved.tracker, getAvailableValues(mappings, 'tracker_'));
    }
    delete resolved.tracker;
  }

  // Map activity → activity_id
  if (resolved.activity && !resolved.activity_id) {
    const key = `activity_${resolved.activity}`;
    const id = mappings[key];
    if (id) {
      resolved.activity_id = id;
    } else {
      throw new MappingError(
        'activity',
        resolved.activity,
        getAvailableValues(mappings, 'activity_')
      );
    }
    delete resolved.activity;
  }

  return resolved;
}
