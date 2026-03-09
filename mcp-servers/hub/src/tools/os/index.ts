/**
 * OS Tools Index
 * @module tools/os
 *
 * Exports all OS tool metadata for progressive discovery.
 * Tools are loaded dynamically by the search_tools handler.
 *
 * Available tools (25):
 * Reminders (5): listReminderLists, listReminders, getReminder, createReminder, completeReminder
 * Calendar (6): listCalendars, listEvents, getEvent, createEvent, updateEvent, deleteEvent
 * Mail (7): detectMailClients, listMailboxes, listEmails, getEmail, searchEmails, sendEmail, replyToEmail
 * Notes (7): listNoteFolders, listNotes, getNote, searchNotes, createNote, updateNote, deleteNote
 */

import { ToolMetadata } from '../../hub-types.js';

// Reminders
import { metadata as listReminderLists } from './list_reminder_lists.js';
import { metadata as listReminders } from './list_reminders.js';
import { metadata as getReminder } from './get_reminder.js';
import { metadata as createReminder } from './create_reminder.js';
import { metadata as completeReminder } from './complete_reminder.js';

// Calendar
import { metadata as listCalendars } from './list_calendars.js';
import { metadata as listEvents } from './list_events.js';
import { metadata as getEvent } from './get_event.js';
import { metadata as createEvent } from './create_event.js';
import { metadata as updateEvent } from './update_event.js';
import { metadata as deleteEvent } from './delete_event.js';

// Mail
import { metadata as detectMailClients } from './detect_mail_clients.js';
import { metadata as listMailboxes } from './list_mailboxes.js';
import { metadata as listEmails } from './list_emails.js';
import { metadata as getEmail } from './get_email.js';
import { metadata as searchEmails } from './search_emails.js';
import { metadata as sendEmail } from './send_email.js';
import { metadata as replyToEmail } from './reply_to_email.js';

// Notes
import { metadata as listNoteFolders } from './list_note_folders.js';
import { metadata as listNotes } from './list_notes.js';
import { metadata as getNote } from './get_note.js';
import { metadata as searchNotes } from './search_notes.js';
import { metadata as createNote } from './create_note.js';
import { metadata as updateNote } from './update_note.js';
import { metadata as deleteNote } from './delete_note.js';

/**
 * All OS tools metadata (keyed by tool name)
 * Used by search_tools for progressive discovery
 */
export const toolMetadata: Record<string, ToolMetadata> = {
  // Reminders
  listReminderLists,
  listReminders,
  getReminder,
  createReminder,
  completeReminder,
  // Calendar
  listCalendars,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  // Mail
  detectMailClients,
  listMailboxes,
  listEmails,
  getEmail,
  searchEmails,
  sendEmail,
  replyToEmail,
  // Notes
  listNoteFolders,
  listNotes,
  getNote,
  searchNotes,
  createNote,
  updateNote,
  deleteNote,
};

/**
 * All OS tool names
 */
export const tools = Object.keys(toolMetadata) as (keyof typeof toolMetadata)[];

/**
 * Type representing a valid OS tool name
 */
export type OsToolName = keyof typeof toolMetadata;
