/**
 * Mail Tools — OS Mail integration
 */

import { Tool, ToolDefinition } from '@speedwave/mcp-shared';
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
  markEmailsNotSpamTool,
  renameMailboxTool,
  handleDeleteEmails,
  handleMarkEmailsRead,
  handleFlagEmails,
  handleMoveEmails,
  handleCopyEmails,
  handleArchiveEmails,
  handleCreateMailbox,
  handleMarkEmailsSpam,
  handleMarkEmailsNotSpam,
  handleRenameMailbox,
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
    validatedTool(detectMailClientsTool, handleDetectMailClients),
    validatedTool(listMailboxesTool, handleListMailboxes),
    validatedTool(listEmailsTool, handleListEmails),
    validatedTool(getEmailTool, handleGetEmail),
    validatedTool(searchEmailsTool, handleSearchEmails),
    validatedTool(sendEmailTool, handleSendEmail),
    validatedTool(replyToEmailTool, handleReplyToEmail),
    validatedTool(forwardEmailTool, handleForwardEmail),
    validatedTool(redirectEmailTool, handleRedirectEmail),
    validatedTool(listMailRulesTool, handleListMailRules),
    validatedTool(checkMailTool, handleCheckMail),
    validatedTool(deleteEmailsTool, handleDeleteEmails),
    validatedTool(markEmailsReadTool, handleMarkEmailsRead),
    validatedTool(flagEmailsTool, handleFlagEmails),
    validatedTool(moveEmailsTool, handleMoveEmails),
    validatedTool(copyEmailsTool, handleCopyEmails),
    validatedTool(archiveEmailsTool, handleArchiveEmails),
    validatedTool(createMailboxTool, handleCreateMailbox),
    validatedTool(markEmailsSpamTool, handleMarkEmailsSpam),
    validatedTool(markEmailsNotSpamTool, handleMarkEmailsNotSpam),
    validatedTool(renameMailboxTool, handleRenameMailbox),
    validatedTool(saveDraftTool, handleSaveDraft),
    validatedTool(listMailSignaturesTool, handleListMailSignatures),
  ];
}

/**
 * Pairs a tool with its validated handler.
 * @param tool - Tool definition.
 * @param handler - Handler returning a ToolResult.
 */
function validatedTool<T>(
  tool: Tool,
  handler: (params: T) => ToolResult | Promise<ToolResult>
): ToolDefinition {
  return { tool, handler: withValidation(handler) };
}
