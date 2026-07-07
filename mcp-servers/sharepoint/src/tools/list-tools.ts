/**
 * List Tools — CRUD for SharePoint Lists, items, and columns + page deletion.
 *
 * 13 tools:
 *   listLists, getList, createList, updateList, deleteList,
 *   addListColumn, removeListColumn,
 *   listItems, getItem, createItem, updateItem, deleteItem,
 *   deletePage (deletion-ops bundle)
 *
 * Site-policy by omission (ADR-060): no tool accepts `site_id`. Worker uses
 * `client.getSiteId()` from `/tokens/site_id`.
 *
 * Scope requirement: `Sites.Manage.All` (consts.rs SHAREPOINT_OAUTH_SCOPES).
 * `createList` formally requires Sites.Manage.All per Microsoft Graph.
 *
 * Column-type schema for `addListColumn` limited to documented Graph types:
 * text, number, boolean, dateTime, choice, lookup. Other types (calculated,
 * geolocation, term) are out of scope.
 */

import {
  Tool,
  ToolDefinition,
  notConfiguredMessage,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { withValidation, validateGraphId, ToolResult } from './validation.js';
import { SharePointClient } from '../client.js';
import { ListsClient } from '../graph/lists-client.js';
import { ColumnsClient } from '../graph/columns-client.js';
import { PagesClient } from '../graph/pages-client.js';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/** Minimal Graph list projection used by the tools. */
export interface SharePointList {
  id: string;
  displayName?: string;
  description?: string;
  webUrl?: string;
  list?: { template?: string };
  columns?: ColumnDefinition[];
}

/** Allowed column types in `addListColumn` (PR5 scope). */
export type ColumnType = 'text' | 'number' | 'boolean' | 'dateTime' | 'choice' | 'lookup';

/** Column definition projection. Graph returns much more; this is what tools accept/return. */
export interface ColumnDefinition {
  id: string;
  name: string;
  displayName?: string;
  required?: boolean;
  text?: Record<string, unknown>;
  number?: Record<string, unknown>;
  boolean?: Record<string, unknown>;
  dateTime?: Record<string, unknown>;
  choice?: { choices: string[]; allowTextEntry?: boolean; displayAs?: string };
  lookup?: { listId: string; columnName: string; allowMultipleValues?: boolean };
}

/** Minimal list item projection (fields are the user-defined columns). */
export interface SharePointListItem {
  id: string;
  fields?: Record<string, unknown>;
  webUrl?: string;
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool schemas
//═══════════════════════════════════════════════════════════════════════════════

const listListsTool: Tool = {
  name: 'listLists',
  description:
    'List all SharePoint lists in the configured site (returns both document libraries and custom lists — Graph does not separate them at this endpoint). Provides the listId used by getList/updateList/deleteList/listItems/getItem/createItem/updateItem/deleteItem/addListColumn/removeListColumn.',
  inputSchema: { type: 'object', properties: {} },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists'],
  example: 'const lists = await sharepoint.listLists()',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      lists: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            description: { type: 'string' },
            webUrl: { type: 'string' },
          },
        },
      },
    },
    required: ['success'],
  },
};

const getListTool: Tool = {
  name: 'getList',
  description: 'Get a list with its column schema. Get listId from listLists.',
  inputSchema: {
    type: 'object',
    properties: { listId: { type: 'string', description: 'Graph list id, from listLists.' } },
    required: ['listId'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'get'],
  example: 'const list = await sharepoint.getList({ listId: "L1" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, list: { type: 'object' } },
    required: ['success'],
  },
};

const createListTool: Tool = {
  name: 'createList',
  description:
    'Create a new SharePoint list (requires Sites.Manage.All). To add columns after creation, use addListColumn instead of the columns param below (simpler and avoids the per-type payload shape).',
  inputSchema: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
      template: { type: 'string', description: 'List template, e.g. "genericList"' },
      columns: {
        type: 'array',
        description:
          'Optional initial column definitions, one Graph ColumnDefinition object per column (name, displayName, required, plus one type-specific sub-object: text/number/boolean/dateTime/choice/lookup — the same shape addListColumn builds). Prefer calling addListColumn after creation unless you already have this exact shape.',
        items: { type: 'object' },
      },
    },
    required: ['displayName'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'create'],
  example: 'const list = await sharepoint.createList({ displayName: "Tasks" })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      listId: { type: 'string' },
      webUrl: { type: 'string' },
    },
    required: ['success'],
  },
};

const updateListTool: Tool = {
  name: 'updateList',
  description: 'Rename or update description of a list. Get listId from listLists.',
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'Graph list id, from listLists.' },
      displayName: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['listId'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'update', 'rename'],
  example: 'await sharepoint.updateList({ listId: "L1", displayName: "Renamed" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const deleteListTool: Tool = {
  name: 'deleteList',
  description: 'Delete a list. Destructive. Get listId from listLists.',
  inputSchema: {
    type: 'object',
    properties: { listId: { type: 'string', description: 'Graph list id, from listLists.' } },
    required: ['listId'],
  },
  annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true },
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'delete'],
  example: 'await sharepoint.deleteList({ listId: "L1" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const addListColumnTool: Tool = {
  name: 'addListColumn',
  description:
    "Add a column to a list. Supported types: text, number, boolean, dateTime, choice, lookup. Get listId from listLists. For type 'lookup', lookupListId must be the Graph id of an existing list (get it via listLists) and lookupColumnName must be an existing column name on that list (get it via getList).",
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'Graph list id, from listLists.' },
      name: { type: 'string' },
      displayName: { type: 'string' },
      type: {
        type: 'string',
        enum: ['text', 'number', 'boolean', 'dateTime', 'choice', 'lookup'],
      },
      required: { type: 'boolean' },
      // Type-specific config (one of these is consulted based on `type`)
      choices: { type: 'array', items: { type: 'string' } },
      lookupListId: {
        type: 'string',
        description: "Graph id of the source list (type: 'lookup' only), from listLists.",
      },
      lookupColumnName: {
        type: 'string',
        description: "Existing column name on the source list (type: 'lookup' only), from getList.",
      },
    },
    required: ['listId', 'name', 'type'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'column', 'schema', 'add'],
  example:
    'await sharepoint.addListColumn({ listId: "L1", name: "Status", type: "choice", choices: ["Open","Closed"] })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, columnId: { type: 'string' } },
    required: ['success'],
  },
};

const removeListColumnTool: Tool = {
  name: 'removeListColumn',
  description:
    'Remove a column from a list by id. Destructive. Get listId from listLists and columnId from getList (columns[].id).',
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'Graph list id, from listLists.' },
      columnId: { type: 'string', description: 'Graph column id, from getList (columns[].id).' },
    },
    required: ['listId', 'columnId'],
  },
  annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true },
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'column', 'remove', 'delete'],
  example: 'await sharepoint.removeListColumn({ listId: "L1", columnId: "C1" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const listItemsTool: Tool = {
  name: 'listItems',
  description:
    'List items in a list, expanding their fields. Only list-defined fields are returned: creator/last-editor identity (createdBy/lastModifiedBy) is not exposed. Get listId from listLists. To scope by the current user ("items assigned to me" or "items I created"), call getCurrentUser first to resolve the caller\'s email/id, then build filter against a list-specific author/assignee column, e.g. fields/AssignedTo/EMail eq \'<email>\' (inspect getList\'s column schema first to find the right column name).',
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'Graph list id, from listLists.' },
      filter: {
        type: 'string',
        description:
          "Optional OData $filter expression. String literals use single quotes, e.g. fields/Status eq 'Open'.",
      },
      top: { type: 'number', description: 'Optional max items (default Graph paging)' },
    },
    required: ['listId'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: {
    [META_KEYS.DEFER_LOADING]: false,
    [META_KEYS.USER_SCOPED]: true,
    [META_KEYS.CURRENT_USER_TOOL]: 'getCurrentUser',
  },
  keywords: ['sharepoint', 'lists', 'items', 'list'],
  example: 'const items = await sharepoint.listItems({ listId: "L1" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, items: { type: 'array' } },
    required: ['success'],
  },
};

const getItemTool: Tool = {
  name: 'getItem',
  description:
    'Get a single list item with its fields. Only list-defined fields are returned, not creator/modifier metadata. Get listId from listLists and itemId from listItems.',
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'Graph list id, from listLists.' },
      itemId: { type: 'string', description: 'Graph item id, from listItems.' },
    },
    required: ['listId', 'itemId'],
  },
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'items', 'get'],
  example: 'const item = await sharepoint.getItem({ listId: "L1", itemId: "1" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, item: { type: 'object' } },
    required: ['success'],
  },
};

const createItemTool: Tool = {
  name: 'createItem',
  description: 'Create a new list item with the given fields. Get listId from listLists.',
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'Graph list id, from listLists.' },
      fields: {
        type: 'object',
        description: 'Field name → value mapping',
        additionalProperties: true,
      },
    },
    required: ['listId', 'fields'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'items', 'create'],
  example: 'const item = await sharepoint.createItem({ listId: "L1", fields: { Title: "X" } })',
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      itemId: { type: 'string' },
    },
    required: ['success'],
  },
};

const updateItemTool: Tool = {
  name: 'updateItem',
  description:
    'Update fields on a list item (PATCH on /fields). Get listId from listLists and itemId from listItems.',
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'Graph list id, from listLists.' },
      itemId: { type: 'string', description: 'Graph item id, from listItems.' },
      fields: {
        type: 'object',
        description: 'Field name → new value mapping (replaces matching keys only)',
        additionalProperties: true,
      },
    },
    required: ['listId', 'itemId', 'fields'],
  },
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'items', 'update'],
  example: 'await sharepoint.updateItem({ listId: "L1", itemId: "1", fields: { Status: "Done" } })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const deleteItemTool: Tool = {
  name: 'deleteItem',
  description:
    'Delete a list item. Destructive. Get listId from listLists and itemId from listItems.',
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'Graph list id, from listLists.' },
      itemId: { type: 'string', description: 'Graph item id, from listItems.' },
    },
    required: ['listId', 'itemId'],
  },
  annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true },
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'lists', 'items', 'delete'],
  example: 'await sharepoint.deleteItem({ listId: "L1", itemId: "1" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

const deletePageTool: Tool = {
  name: 'deletePage',
  description:
    'Delete a SharePoint page. Destructive (bundled with PR5 delete ops). Get pageId from listPages.',
  inputSchema: {
    type: 'object',
    properties: { pageId: { type: 'string', description: 'Graph page id, from listPages.' } },
    required: ['pageId'],
  },
  annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true },
  _meta: { [META_KEYS.DEFER_LOADING]: false },
  keywords: ['sharepoint', 'pages', 'delete'],
  example: 'await sharepoint.deletePage({ pageId: "P1" })',
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' } },
    required: ['success'],
  },
};

//═══════════════════════════════════════════════════════════════════════════════
// Handlers
//═══════════════════════════════════════════════════════════════════════════════

function lists(client: SharePointClient): ListsClient {
  return new ListsClient(client);
}

function columns(client: SharePointClient): ColumnsClient {
  return new ColumnsClient(client);
}

function pages(client: SharePointClient): PagesClient {
  return new PagesClient(client);
}

function wrapErr(code: string, error: unknown): ToolResult {
  return {
    success: false,
    error: { code, message: SharePointClient.formatError(error) },
  };
}

/**
 * Build the Graph column definition for `addListColumn`. Graph requires one
 * type-specific sub-object (text/number/boolean/dateTime/choice/lookup).
 * @param params - flat tool params (see `addListColumnTool` schema)
 * @param params.name - internal column name
 * @param params.displayName - human-readable label (defaults to `name`)
 * @param params.type - column type (text/number/boolean/dateTime/choice/lookup)
 * @param params.required - whether the column is required
 * @param params.choices - allowed values when type === "choice"
 * @param params.lookupListId - source list id when type === "lookup"
 * @param params.lookupColumnName - source column when type === "lookup"
 */
function buildColumnPayload(params: {
  name: string;
  displayName?: string;
  type: ColumnType;
  required?: boolean;
  choices?: string[];
  lookupListId?: string;
  lookupColumnName?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: params.name,
    displayName: params.displayName ?? params.name,
    required: params.required ?? false,
  };
  switch (params.type) {
    case 'text':
      body.text = {};
      break;
    case 'number':
      body.number = {};
      break;
    case 'boolean':
      body.boolean = {};
      break;
    case 'dateTime':
      body.dateTime = {};
      break;
    case 'choice':
      body.choice = { choices: params.choices ?? [], displayAs: 'dropDownMenu' };
      break;
    case 'lookup':
      body.lookup = {
        listId: params.lookupListId ?? '',
        columnName: params.lookupColumnName ?? 'Title',
      };
      break;
  }
  return body;
}

/**
 * Handler for `listLists` — GET all lists in the configured site.
 * @param client - the SharePoint client
 */
async function handleListLists(client: SharePointClient): Promise<ToolResult> {
  try {
    const resp = (await lists(client).listLists()) as { value?: SharePointList[] } | undefined;
    return {
      success: true,
      data: {
        lists: (resp?.value ?? []).map((l) => ({
          id: l.id,
          displayName: l.displayName,
          description: l.description,
          webUrl: l.webUrl,
        })),
      },
    };
  } catch (e) {
    return wrapErr('LIST_LISTS_FAILED', e);
  }
}

/**
 * Handler for `getList` — GET one list with `$expand=columns`.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 */
async function handleGetList(
  client: SharePointClient,
  params: { listId: string }
): Promise<ToolResult> {
  const e = validateGraphId(params.listId, 'listId', 'listLists');
  if (e) return e;
  try {
    const list = (await lists(client).getList(params.listId)) as SharePointList | undefined;
    return { success: true, data: { list } };
  } catch (e) {
    return wrapErr('GET_LIST_FAILED', e);
  }
}

/**
 * Handler for `createList` — POST a new list (requires Sites.Manage.All).
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.displayName - human-readable list name
 * @param params.description - optional description
 * @param params.template - optional list template (e.g. "genericList")
 * @param params.columns - optional initial column definitions
 */
async function handleCreateList(
  client: SharePointClient,
  params: {
    displayName: string;
    description?: string;
    template?: string;
    columns?: ColumnDefinition[];
  }
): Promise<ToolResult> {
  try {
    const body: Record<string, unknown> = { displayName: params.displayName };
    if (params.description) body.description = params.description;
    body.list = { template: params.template ?? 'genericList' };
    if (params.columns?.length) body.columns = params.columns;
    const created = (await lists(client).createList(body)) as SharePointList | undefined;
    return {
      success: true,
      data: { listId: created?.id ?? '', webUrl: created?.webUrl ?? '' },
    };
  } catch (e) {
    return wrapErr('CREATE_LIST_FAILED', e);
  }
}

/**
 * Handler for `updateList` — PATCH list metadata.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 * @param params.displayName - new display name
 * @param params.description - new description
 */
async function handleUpdateList(
  client: SharePointClient,
  params: { listId: string; displayName?: string; description?: string }
): Promise<ToolResult> {
  const e = validateGraphId(params.listId, 'listId', 'listLists');
  if (e) return e;
  try {
    const body: Record<string, unknown> = {};
    if (params.displayName !== undefined) body.displayName = params.displayName;
    if (params.description !== undefined) body.description = params.description;
    await lists(client).updateList(params.listId, body);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('UPDATE_LIST_FAILED', e);
  }
}

/**
 * Handler for `deleteList` — DELETE a list.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 */
async function handleDeleteList(
  client: SharePointClient,
  params: { listId: string }
): Promise<ToolResult> {
  const e = validateGraphId(params.listId, 'listId', 'listLists');
  if (e) return e;
  try {
    await lists(client).deleteList(params.listId);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('DELETE_LIST_FAILED', e);
  }
}

/**
 * Handler for `addListColumn` — POST a new column on a list.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 * @param params.name - internal column name
 * @param params.displayName - optional human-readable label
 * @param params.type - column type (text/number/boolean/dateTime/choice/lookup)
 * @param params.required - whether the column is required
 * @param params.choices - choice values when type === "choice"
 * @param params.lookupListId - source list id when type === "lookup"
 * @param params.lookupColumnName - source column when type === "lookup"
 */
async function handleAddListColumn(
  client: SharePointClient,
  params: {
    listId: string;
    name: string;
    displayName?: string;
    type: ColumnType;
    required?: boolean;
    choices?: string[];
    lookupListId?: string;
    lookupColumnName?: string;
  }
): Promise<ToolResult> {
  const e1 = validateGraphId(params.listId, 'listId', 'listLists');
  if (e1) return e1;
  if (params.lookupListId !== undefined) {
    const e2 = validateGraphId(params.lookupListId, 'lookupListId', 'listLists');
    if (e2) return e2;
  }
  try {
    const payload = buildColumnPayload(params);
    const col = (await columns(client).addColumn(params.listId, payload)) as
      | ColumnDefinition
      | undefined;
    return { success: true, data: { columnId: col?.id ?? '' } };
  } catch (e) {
    return wrapErr('ADD_LIST_COLUMN_FAILED', e);
  }
}

/**
 * Handler for `removeListColumn` — DELETE a column from a list.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 * @param params.columnId - id of the column to remove
 */
async function handleRemoveListColumn(
  client: SharePointClient,
  params: { listId: string; columnId: string }
): Promise<ToolResult> {
  const e1 = validateGraphId(params.listId, 'listId', 'listLists');
  if (e1) return e1;
  const e2 = validateGraphId(params.columnId, 'columnId', 'getList');
  if (e2) return e2;
  try {
    await columns(client).removeColumn(params.listId, params.columnId);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('REMOVE_LIST_COLUMN_FAILED', e);
  }
}

/**
 * Handler for `listItems` — GET items with $expand=fields.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 * @param params.filter - optional OData $filter expression
 * @param params.top - optional max items
 */
async function handleListItems(
  client: SharePointClient,
  params: { listId: string; filter?: string; top?: number }
): Promise<ToolResult> {
  const e = validateGraphId(params.listId, 'listId', 'listLists');
  if (e) return e;
  try {
    const extra: string[] = [];
    if (params.filter) extra.push(`$filter=${encodeURIComponent(params.filter)}`);
    if (params.top) extra.push(`$top=${params.top}`);
    const resp = (await lists(client).listItems(params.listId, extra)) as
      | { value?: SharePointListItem[] }
      | undefined;
    return {
      success: true,
      data: {
        items: (resp?.value ?? []).map((i) => ({
          id: i.id,
          fields: i.fields,
          webUrl: i.webUrl,
        })),
      },
    };
  } catch (e) {
    // A malformed $filter (e.g. double-quoted string literals) surfaces as a raw
    // Graph 400 — steer the model to the fix instead of an opaque error dump.
    const hint = params.filter?.includes('"')
      ? " OData $filter requires single-quoted string literals, e.g. fields/Status eq 'Open' (not double quotes)."
      : '';
    return {
      success: false,
      error: { code: 'LIST_ITEMS_FAILED', message: `${SharePointClient.formatError(e)}${hint}` },
    };
  }
}

/**
 * Handler for `getItem` — GET one item with $expand=fields.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 * @param params.itemId - target item id
 */
async function handleGetItem(
  client: SharePointClient,
  params: { listId: string; itemId: string }
): Promise<ToolResult> {
  const e1 = validateGraphId(params.listId, 'listId', 'listLists');
  if (e1) return e1;
  const e2 = validateGraphId(params.itemId, 'itemId', 'listItems');
  if (e2) return e2;
  try {
    const item = (await lists(client).getItem(params.listId, params.itemId)) as
      | SharePointListItem
      | undefined;
    return { success: true, data: { item } };
  } catch (e) {
    return wrapErr('GET_ITEM_FAILED', e);
  }
}

/**
 * Handler for `createItem` — POST a new list item.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 * @param params.fields - field name → value mapping for the new item
 */
async function handleCreateItem(
  client: SharePointClient,
  params: { listId: string; fields: Record<string, unknown> }
): Promise<ToolResult> {
  const e = validateGraphId(params.listId, 'listId', 'listLists');
  if (e) return e;
  try {
    const created = (await lists(client).createItem(params.listId, {
      fields: params.fields,
    })) as SharePointListItem | undefined;
    return { success: true, data: { itemId: created?.id ?? '' } };
  } catch (e) {
    return wrapErr('CREATE_ITEM_FAILED', e);
  }
}

/**
 * Handler for `updateItem` — PATCH item fields.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 * @param params.itemId - target item id
 * @param params.fields - field updates (replaces matching keys only)
 */
async function handleUpdateItem(
  client: SharePointClient,
  params: { listId: string; itemId: string; fields: Record<string, unknown> }
): Promise<ToolResult> {
  const e1 = validateGraphId(params.listId, 'listId', 'listLists');
  if (e1) return e1;
  const e2 = validateGraphId(params.itemId, 'itemId', 'listItems');
  if (e2) return e2;
  try {
    await lists(client).updateItem(params.listId, params.itemId, params.fields);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('UPDATE_ITEM_FAILED', e);
  }
}

/**
 * Handler for `deleteItem` — DELETE a list item.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.listId - target list id
 * @param params.itemId - target item id
 */
async function handleDeleteItem(
  client: SharePointClient,
  params: { listId: string; itemId: string }
): Promise<ToolResult> {
  const e1 = validateGraphId(params.listId, 'listId', 'listLists');
  if (e1) return e1;
  const e2 = validateGraphId(params.itemId, 'itemId', 'listItems');
  if (e2) return e2;
  try {
    await lists(client).deleteItem(params.listId, params.itemId);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('DELETE_ITEM_FAILED', e);
  }
}

/**
 * Handler for `deletePage` — DELETE a SharePoint page.
 * @param client - the SharePoint client
 * @param params - input parameters
 * @param params.pageId - target page id
 */
async function handleDeletePage(
  client: SharePointClient,
  params: { pageId: string }
): Promise<ToolResult> {
  const e = validateGraphId(params.pageId, 'pageId', 'listPages');
  if (e) return e;
  try {
    await pages(client).deletePage(params.pageId);
    return { success: true, data: {} };
  } catch (e) {
    return wrapErr('DELETE_PAGE_FAILED', e);
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Factory
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the list / item / column / deletion tool definitions.
 * @param client - the initialized SharePoint client (or null when not configured)
 */
export function createListTools(client: SharePointClient | null): ToolDefinition[] {
  const withClient =
    <T>(handler: (c: SharePointClient, p: T) => Promise<ToolResult>) =>
    async (params: T): Promise<ToolResult> => {
      if (!client) {
        return {
          success: false,
          error: {
            code: 'NOT_CONFIGURED',
            message: notConfiguredMessage('SharePoint'),
          },
        };
      }
      return handler(client, params);
    };

  return [
    {
      tool: listListsTool,
      handler: withValidation<Record<string, never>>(withClient((c) => handleListLists(c))),
    },
    {
      tool: getListTool,
      handler: withValidation<{ listId: string }>(withClient(handleGetList)),
    },
    {
      tool: createListTool,
      handler: withValidation<{
        displayName: string;
        description?: string;
        template?: string;
        columns?: ColumnDefinition[];
      }>(withClient(handleCreateList)),
    },
    {
      tool: updateListTool,
      handler: withValidation<{
        listId: string;
        displayName?: string;
        description?: string;
      }>(withClient(handleUpdateList)),
    },
    {
      tool: deleteListTool,
      handler: withValidation<{ listId: string }>(withClient(handleDeleteList)),
    },
    {
      tool: addListColumnTool,
      handler: withValidation<{
        listId: string;
        name: string;
        displayName?: string;
        type: ColumnType;
        required?: boolean;
        choices?: string[];
        lookupListId?: string;
        lookupColumnName?: string;
      }>(withClient(handleAddListColumn)),
    },
    {
      tool: removeListColumnTool,
      handler: withValidation<{ listId: string; columnId: string }>(
        withClient(handleRemoveListColumn)
      ),
    },
    {
      tool: listItemsTool,
      handler: withValidation<{ listId: string; filter?: string; top?: number }>(
        withClient(handleListItems)
      ),
    },
    {
      tool: getItemTool,
      handler: withValidation<{ listId: string; itemId: string }>(withClient(handleGetItem)),
    },
    {
      tool: createItemTool,
      handler: withValidation<{
        listId: string;
        fields: Record<string, unknown>;
      }>(withClient(handleCreateItem)),
    },
    {
      tool: updateItemTool,
      handler: withValidation<{
        listId: string;
        itemId: string;
        fields: Record<string, unknown>;
      }>(withClient(handleUpdateItem)),
    },
    {
      tool: deleteItemTool,
      handler: withValidation<{ listId: string; itemId: string }>(withClient(handleDeleteItem)),
    },
    {
      tool: deletePageTool,
      handler: withValidation<{ pageId: string }>(withClient(handleDeletePage)),
    },
  ];
}

// Schemas exported for the site-policy regression test (assert no site_id leak).
export const LIST_TOOL_SCHEMAS = [
  listListsTool,
  getListTool,
  createListTool,
  updateListTool,
  deleteListTool,
  addListColumnTool,
  removeListColumnTool,
  listItemsTool,
  getItemTool,
  createItemTool,
  updateItemTool,
  deleteItemTool,
  deletePageTool,
];
