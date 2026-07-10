/**
 * SSOT for the "assigned_to_me | created_by_me | all" identity-scope filter shared
 * by listMrIds/listMergeRequests and listIssues.
 * @module identity-scopes
 */

export const IDENTITY_SCOPES = ['assigned_to_me', 'created_by_me', 'all'] as const;

/** One of {@link IDENTITY_SCOPES}. */
export type IdentityScope = (typeof IDENTITY_SCOPES)[number];
