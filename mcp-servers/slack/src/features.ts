/**
 * Slack features the user enables in Speedwave Desktop (@module slack/features): Desktop writes the enabled ids next to `access_token` at every sign-in; tools read them per call.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { tokensDir, type ToolResult } from '@speedwave/mcp-shared';

/** Filename of the enabled-features JSON. SSOT mirror of Rust `consts::SLACK_FEATURES_FILE` (cross-read test `slack_features_file_and_ids_match_mcp_slack_ts`). */
export const SLACK_FEATURES_FILE = 'features.json';

/** Feature ids; mirror of the ids in Rust `consts::SLACK_FEATURES` (cross-read test `slack_features_file_and_ids_match_mcp_slack_ts`). */
export const SLACK_FEATURE_IDS = {
  fileUpload: 'file_upload',
} as const;

/** One of the {@link SLACK_FEATURE_IDS} values. */
export type SlackFeatureId = (typeof SLACK_FEATURE_IDS)[keyof typeof SLACK_FEATURE_IDS];

/**
 * True when the feature may be used. A missing features file (a grant saved before Desktop wrote it) allows everything and leaves enforcement to Slack's scope check; an unreadable or malformed file allows nothing until the next sign-in rewrites it.
 * @param feature - Feature id to check.
 */
export async function isFeatureEnabled(feature: SlackFeatureId): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path.join(tokensDir(), SLACK_FEATURES_FILE), 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  try {
    const enabled = (JSON.parse(raw) as { enabled?: unknown } | null)?.enabled;
    return Array.isArray(enabled) && enabled.includes(feature);
  } catch {
    return false;
  }
}

/**
 * Teaching failure for a tool whose feature the user has not enabled; raised before any Slack call.
 * @param feature - Feature id the tool needs.
 * @param tool - Name of the tool that was called.
 */
export function featureNotEnabledResult(feature: SlackFeatureId, tool: string): ToolResult {
  return {
    success: false,
    error: {
      code: 'FEATURE_NOT_ENABLED',
      message: `${tool} needs the Slack feature ${feature}, which is not enabled for this Slack sign-in. No Slack request was made. Ask the user to enable it in the feature list of the Slack card in Speedwave Desktop, Integrations, Slack, then retry.`,
    },
  };
}
