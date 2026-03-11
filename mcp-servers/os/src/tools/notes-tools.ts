/**
 * Notes Tools — OS Notes integration
 */

import { Tool, ToolDefinition } from '@speedwave/mcp-shared';
import { withValidation, ToolResult, validateAll, asRecord, MAX_LENGTHS } from './validation.js';
import { runCommand } from '../platform-runner.js';

//=============================================================================
// Types
//=============================================================================

/** Input parameters for the listNoteFolders tool (no params required). */
type ListNoteFoldersParams = Record<string, never>;

/** Input parameters for the listNotes tool. */
interface ListNotesParams {
  /** Filter by folder ID. */
  folder_id?: string;
  /** Max notes to return. */
  limit?: number;
}

/** Input parameters for the getNote tool. */
interface GetNoteParams {
  /** Note ID. */
  id: string;
}

/** Input parameters for the searchNotes tool. */
interface SearchNotesParams {
  /** Search query string. */
  query: string;
  /** Limit search to specific folder. */
  folder_id?: string;
  /** Max results to return. */
  limit?: number;
}

/** Input parameters for the createNote tool. */
interface CreateNoteParams {
  /** Note title. */
  title: string;
  /** Note body content. */
  body?: string;
  /** Target folder ID. */
  folder_id?: string;
}

/** Input parameters for the updateNote tool. */
interface UpdateNoteParams {
  /** Note ID to update. */
  id: string;
  /** New title. */
  title?: string;
  /** New body content. */
  body?: string;
}

/** Input parameters for the deleteNote tool. */
interface DeleteNoteParams {
  /** Note ID to delete. */
  id: string;
}

//=============================================================================
// Tool Definitions
//=============================================================================

const listNoteFoldersTool: Tool = {
  name: 'listNoteFolders',
  description: 'List all note folders/notebooks available on this device',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const listNotesTool: Tool = {
  name: 'listNotes',
  description: 'List notes, optionally filtered by folder',
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: { type: 'string', description: 'Filter by folder ID' },
      limit: { type: 'number', description: 'Max notes to return (default 50)' },
    },
  },
};

const getNoteTool: Tool = {
  name: 'getNote',
  description: 'Get a specific note by ID with full body content',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID' },
    },
    required: ['id'],
  },
};

const searchNotesTool: Tool = {
  name: 'searchNotes',
  description: 'Search notes by query string',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (searches title and body)' },
      folder_id: { type: 'string', description: 'Limit search to specific folder' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['query'],
  },
};

const createNoteTool: Tool = {
  name: 'createNote',
  description: 'Create a new note',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title' },
      body: { type: 'string', description: 'Note body content (plain text or HTML)' },
      folder_id: { type: 'string', description: 'Target folder ID (uses default if omitted)' },
    },
    required: ['title'],
  },
};

const updateNoteTool: Tool = {
  name: 'updateNote',
  description: 'Update an existing note',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID to update' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body content' },
    },
    required: ['id'],
  },
};

const deleteNoteTool: Tool = {
  name: 'deleteNote',
  description: 'Delete a note',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID to delete' },
    },
    required: ['id'],
  },
};

//=============================================================================
// Handlers
//=============================================================================

/**
 * Lists all note folders/notebooks available on this device.
 * @param _params - Unused tool input parameters.
 */
export async function handleListNoteFolders(_params: ListNoteFoldersParams): Promise<ToolResult> {
  const result = await runCommand('notes', 'list_folders');
  return { success: true, data: result.parsed };
}

/**
 * Lists notes, optionally filtered by folder.
 * @param params - Tool input parameters.
 */
export async function handleListNotes(params: ListNotesParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    strings: [['folder_id', MAX_LENGTHS.id, false]],
    numbers: [['limit', 1, 10_000]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('notes', 'list_notes', p);
  return { success: true, data: result.parsed };
}

/**
 * Gets a specific note by ID with full body content.
 * @param params - Tool input parameters.
 */
export async function handleGetNote(params: GetNoteParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [['id', MAX_LENGTHS.id, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('notes', 'get_note', p);
  return { success: true, data: result.parsed };
}

/**
 * Searches notes by query string.
 * @param params - Tool input parameters.
 */
export async function handleSearchNotes(params: SearchNotesParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['query'],
    strings: [
      ['query', MAX_LENGTHS.short, false],
      ['folder_id', MAX_LENGTHS.id, false],
    ],
    numbers: [['limit', 1, 10_000]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('notes', 'search_notes', p);
  return { success: true, data: result.parsed };
}

/**
 * Creates a new note.
 * @param params - Tool input parameters.
 */
export async function handleCreateNote(params: CreateNoteParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['title'],
    strings: [
      ['title', MAX_LENGTHS.short, false],
      ['body', MAX_LENGTHS.body, true],
      ['folder_id', MAX_LENGTHS.id, false],
    ],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('notes', 'create_note', p);
  return { success: true, data: result.parsed };
}

/**
 * Updates an existing note.
 * @param params - Tool input parameters.
 */
export async function handleUpdateNote(params: UpdateNoteParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [
      ['id', MAX_LENGTHS.id, false],
      ['title', MAX_LENGTHS.short, false],
      ['body', MAX_LENGTHS.body, true],
    ],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('notes', 'update_note', p);
  return { success: true, data: result.parsed };
}

/**
 * Deletes a note.
 * @param params - Tool input parameters.
 */
export async function handleDeleteNote(params: DeleteNoteParams): Promise<ToolResult> {
  const p = asRecord(params);
  const v = validateAll(p, {
    required: ['id'],
    strings: [['id', MAX_LENGTHS.id, false]],
  });
  if (!v.valid) return v.error;
  const result = await runCommand('notes', 'delete_note', p);
  return { success: true, data: result.parsed };
}

//=============================================================================
// Export
//=============================================================================

/** Creates tool definitions for all notes operations. */
export function createNoteTools(): ToolDefinition[] {
  return [
    { tool: listNoteFoldersTool, handler: withValidation(handleListNoteFolders) },
    { tool: listNotesTool, handler: withValidation(handleListNotes) },
    { tool: getNoteTool, handler: withValidation(handleGetNote) },
    { tool: searchNotesTool, handler: withValidation(handleSearchNotes) },
    { tool: createNoteTool, handler: withValidation(handleCreateNote) },
    { tool: updateNoteTool, handler: withValidation(handleUpdateNote) },
    { tool: deleteNoteTool, handler: withValidation(handleDeleteNote) },
  ];
}
