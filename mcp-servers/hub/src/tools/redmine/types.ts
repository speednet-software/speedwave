/**
 * Redmine Shared Types
 * @module tools/redmine/types
 *
 * Centralized type definitions for Redmine-related entities.
 * This is the Single Source of Truth for relation types used across multiple tools.
 */

/**
 * All valid Redmine relation types.
 * Use this array in JSON schemas with [...REDMINE_RELATION_TYPES]
 */
export const REDMINE_RELATION_TYPES = [
  'relates',
  'duplicates',
  'duplicated',
  'blocks',
  'blocked',
  'precedes',
  'follows',
  'copied_to',
  'copied_from',
] as const;

/**
 * Valid relation type string.
 * Derived from REDMINE_RELATION_TYPES for type safety.
 */
export type RelationType = (typeof REDMINE_RELATION_TYPES)[number];

/**
 * Redmine issue relation object.
 */
export interface IssueRelation {
  /** Relation ID */
  id: number;
  /** Source issue ID */
  issue_id: number;
  /** Target issue ID */
  issue_to_id: number;
  /** Type of relation */
  relation_type: RelationType;
  /** Delay in days (only for precedes/follows) */
  delay?: number;
}

/**
 * Check if a string is a valid relation type.
 * @param value - Value to check
 * @returns True if value is a valid RelationType
 */
export function isValidRelationType(value: string): value is RelationType {
  return REDMINE_RELATION_TYPES.includes(value as RelationType);
}
