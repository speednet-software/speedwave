/**
 * Mail Tools — OS Mail integration
 */

import { Tool, ToolDefinition, withDeclaredParams } from '@speedwave/mcp-shared';
import { withValidation, ToolResult } from './validation.js';
import {
  detectMailClientsTool,
  listMailboxesTool,
  listEmailsTool,
  getEmailTool,
  searchEmailsTool,
  handleDetectMailClients,
  handleListMailboxes,
  handleListEmails,
  handleGetEmail,
  handleSearchEmails,
} from './mail-reading.js';
import {
  deleteEmailsTool,
  markEmailsReadTool,
  flagEmailsTool,
  moveEmailsTool,
  copyEmailsTool,
  archiveEmailsTool,
  createMailboxTool,
  markEmailsSpamTool,
  handleDeleteEmails,
  handleMarkEmailsRead,
  handleFlagEmails,
  handleMoveEmails,
  handleCopyEmails,
  handleArchiveEmails,
  handleCreateMailbox,
  handleMarkEmailsSpam,
} from './mail-organizing.js';
import {
  sendEmailTool,
  replyToEmailTool,
  forwardEmailTool,
  redirectEmailTool,
  saveDraftTool,
  listMailSignaturesTool,
  handleSendEmail,
  handleReplyToEmail,
  handleForwardEmail,
  handleRedirectEmail,
  handleSaveDraft,
  handleListMailSignatures,
} from './mail-sending.js';
import {
  listMailRulesTool,
  checkMailTool,
  handleListMailRules,
  handleCheckMail,
} from './mail-rules.js';

/** Creates tool definitions for all mail operations. */
export function createMailTools(): ToolDefinition[] {
  return [
    guardedTool(detectMailClientsTool, handleDetectMailClients),
    guardedTool(listMailboxesTool, handleListMailboxes),
    guardedTool(listEmailsTool, handleListEmails),
    guardedTool(getEmailTool, handleGetEmail),
    guardedTool(searchEmailsTool, handleSearchEmails),
    guardedTool(sendEmailTool, handleSendEmail),
    guardedTool(replyToEmailTool, handleReplyToEmail),
    guardedTool(forwardEmailTool, handleForwardEmail),
    guardedTool(redirectEmailTool, handleRedirectEmail),
    guardedTool(listMailRulesTool, handleListMailRules),
    guardedTool(checkMailTool, handleCheckMail),
    guardedTool(deleteEmailsTool, handleDeleteEmails),
    guardedTool(markEmailsReadTool, handleMarkEmailsRead),
    guardedTool(flagEmailsTool, handleFlagEmails),
    guardedTool(moveEmailsTool, handleMoveEmails),
    guardedTool(copyEmailsTool, handleCopyEmails),
    guardedTool(archiveEmailsTool, handleArchiveEmails),
    guardedTool(createMailboxTool, handleCreateMailbox),
    guardedTool(markEmailsSpamTool, handleMarkEmailsSpam),
    guardedTool(saveDraftTool, handleSaveDraft),
    guardedTool(listMailSignaturesTool, handleListMailSignatures),
  ];
}

/**
 * Pairs a tool with its validated handler, rejecting any argument its inputSchema does not declare.
 * @param tool - Tool definition.
 * @param handler - Handler returning a ToolResult.
 */
function guardedTool<T>(
  tool: Tool,
  handler: (params: T) => ToolResult | Promise<ToolResult>
): ToolDefinition {
  return { tool, handler: withDeclaredParams(tool, withValidation(handler)) };
}
