/**
 * Slack Tools Index
 * @module tools/slack
 *
 * Exports all Slack tool metadata for progressive discovery.
 * Tools are loaded dynamically by the search_tools handler.
 *
 * Available tools (4):
 * - sendChannel: Send message to a channel
 * - getChannelMessages: Read message history
 * - listChannelIds: List accessible channels
 * - getUsers: Lookup user by email
 */

import { ToolMetadata } from '../../hub-types.js';
import { metadata as sendChannel } from './send_channel.js';
import { metadata as getChannelMessages } from './read_channel.js';
import { metadata as listChannelIds } from './get_channels.js';
import { metadata as getUsers } from './get_users.js';

/**
 * All Slack tools metadata (keyed by tool name)
 * Used by search_tools for progressive discovery
 */
export const toolMetadata: Record<string, ToolMetadata> = {
  sendChannel,
  getChannelMessages,
  listChannelIds,
  getUsers,
};

/**
 * All Slack tool names
 */
export const tools = Object.keys(toolMetadata) as (keyof typeof toolMetadata)[];

/**
 * Type representing a valid Slack tool name
 */
export type SlackToolName = keyof typeof toolMetadata;
