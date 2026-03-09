/**
 * Slack: Send Channel
 *
 * Send a message to a channel where bot Speedwave is a member.
 * Messages are sent as the user (not as bot) for authenticity.
 * Security notes:
 * - Bot membership check required (access control)
 * - User token used for sending (authenticity)
 * - Kick bot from channel = instant access revoke
 * @param {string} channel - Channel name (#general) or channel ID (C0123ABC)
 * @param {string} message - Message text to send
 * @returns {object} Result with timestamp of sent message
 * @example
 * // Send message to #general
 * const result = await slack.sendChannel({
 *   channel: "#general",
 *   message: "Hello from Speedwave!"
 * });
 */

import { ToolMetadata } from '../../hub-types.js';

export const metadata: ToolMetadata = {
  name: 'sendChannel',
  service: 'slack',
  category: 'write',
  deferLoading: false,
  description: 'Send a message to a Slack channel (writes as user, not bot)',
  keywords: ['slack', 'send', 'message', 'channel', 'post', 'write'],
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name (e.g., #general) or channel ID' },
      message: { type: 'string', description: 'Message text to send' },
    },
    required: ['channel', 'message'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message_ts: { type: 'string', description: 'Timestamp/ID of sent message' },
      channel: { type: 'string', description: 'Channel ID where message was sent' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await slack.sendChannel({ channel: "#general", message: "Hello!" })`,
  inputExamples: [
    {
      description: 'Minimal: send simple message',
      input: { channel: '#general', message: 'Hello team!' },
    },
    {
      description: 'Full: send to specific channel ID',
      input: { channel: 'C0123ABC456', message: 'Deployment completed successfully! :rocket:' },
    },
  ],
};

/**
 * Execute send_channel tool
 * Sends a message to a Slack channel where bot Speedwave is a member
 * Messages are sent as the user (not as bot) for authenticity
 * @param params - Send parameters
 * @param params.channel - Channel name (#general) or channel ID (C0123ABC)
 * @param params.message - Message text to send
 * @param context - Execution context with slack service
 * @param context.slack - Slack service bridge instance
 * @param context.slack.sendChannel - Function to send messages to channels
 * @returns Result with timestamp of sent message or error
 */
export async function execute(
  params: { channel: string; message: string },
  context: { slack: { sendChannel: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; timestamp?: string; error?: string }> {
  const { channel, message } = params;

  if (!channel || !message) {
    return {
      success: false,
      error: 'Missing required fields: channel, message',
    };
  }

  try {
    const result = await context.slack.sendChannel({ channel, message });
    return {
      success: true,
      timestamp: (result as { ts?: string })?.ts || new Date().toISOString(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
