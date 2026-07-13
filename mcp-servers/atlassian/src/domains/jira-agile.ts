/**
 * Jira Agile (Software) — boards, sprints, board config, moving issues (`/rest/agile/1.0/*`).
 * @module mcp-atlassian/domains/jira-agile
 */

import { clampPageSize } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';
import {
  ScopeError,
  assertJiraIssueKeyAllowed,
  assertJiraProjectAllowed,
  filterByAllowlist,
} from '../scope.js';
import type { JiraBoard, JiraBoardConfiguration, JiraSprint } from '../types.js';

/** Agile API hard cap on issues per `moveIssuesToSprint` call (SSOT). */
export const MOVE_ISSUES_MAX = 50;

/** Client for Jira Agile operations. */
export interface JiraAgileClient {
  /** List Agile boards (filtered by the configured project allowlist, if any). */
  listBoards(options?: {
    name?: string;
    projectKeyOrId?: string;
    maxResults?: number;
  }): Promise<JiraBoard[]>;
  /** Get a single board by ID. */
  getBoard(boardId: number): Promise<JiraBoard>;
  /** Get a board's configuration (filter + columns). */
  getBoardConfiguration(boardId: number): Promise<JiraBoardConfiguration>;
  /** List sprints on a board, optionally filtered by state. */
  listSprints(
    boardId: number,
    options?: { state?: 'active' | 'future' | 'closed'; maxResults?: number }
  ): Promise<JiraSprint[]>;
  /** Get a single sprint by ID. */
  getSprint(sprintId: number): Promise<JiraSprint>;
  /** Move issues into a sprint. Rejects a batch over {@link MOVE_ISSUES_MAX}. */
  moveIssuesToSprint(sprintId: number, issueKeysOrIds: string[]): Promise<void>;
}

/**
 * Create a Jira Agile client.
 * @param client - The shared Atlassian HTTP client.
 */
export function createJiraAgileClient(client: AtlassianClient): JiraAgileClient {
  /**
   * Enforce the project allowlist for a board (by its associated project).
   * @param boardId - The Jira Agile board ID.
   */
  const enforceBoard = async (boardId: number): Promise<JiraBoard> => {
    const board = await getBoardRaw(client, boardId);
    assertJiraProjectAllowed(board.project_key, client.jiraProjectKeys);
    return board;
  };

  /**
   * Enforce the project allowlist for a sprint whose board ID may be absent.
   * @param sprintId - The sprint ID (for the error message only).
   * @param boardId - The sprint's `originBoardId`, or `undefined` if absent.
   */
  const enforceSprintBoard = async (
    sprintId: number,
    boardId: number | undefined
  ): Promise<void> => {
    if (boardId !== undefined) {
      await enforceBoard(boardId);
      return;
    }
    if (client.jiraProjectKeys.length > 0) {
      throw new ScopeError(
        `Cannot determine the board for sprint ${sprintId}; access is restricted to: ${client.jiraProjectKeys.join(', ')}`
      );
    }
  };

  return {
    async listBoards(options = {}) {
      const params: Record<string, unknown> = {
        maxResults: clampPageSize(options.maxResults, 50, 100),
      };
      if (options.name) params.name = options.name;
      if (options.projectKeyOrId) params.projectKeyOrId = options.projectKeyOrId;
      const res = await client.get<{ values?: unknown[] }>('/rest/agile/1.0/board', params);
      const boards = (res.values ?? []).map(mapBoard);
      return filterByAllowlist(boards, (b) => b.project_key, client.jiraProjectKeys);
    },

    async getBoard(boardId) {
      return enforceBoard(boardId);
    },

    async getBoardConfiguration(boardId) {
      await enforceBoard(boardId);
      const raw = await client.get<unknown>(`/rest/agile/1.0/board/${boardId}/configuration`);
      return mapBoardConfiguration(raw);
    },

    async listSprints(boardId, options = {}) {
      await enforceBoard(boardId);
      const params: Record<string, unknown> = {
        maxResults: clampPageSize(options.maxResults, 50, 100),
      };
      if (options.state) params.state = options.state;
      const res = await client.get<{ values?: unknown[] }>(
        `/rest/agile/1.0/board/${boardId}/sprint`,
        params
      );
      return (res.values ?? []).map((s) => mapSprint(s, boardId));
    },

    async getSprint(sprintId) {
      const raw = await client.get<unknown>(`/rest/agile/1.0/sprint/${sprintId}`);
      const sprint = mapSprint(raw);
      await enforceSprintBoard(sprintId, sprint.board_id);
      return sprint;
    },

    async moveIssuesToSprint(sprintId, issueKeysOrIds) {
      const sprint = await client.get<{ originBoardId?: number }>(
        `/rest/agile/1.0/sprint/${sprintId}`
      );
      await enforceSprintBoard(
        sprintId,
        typeof sprint.originBoardId === 'number' ? sprint.originBoardId : undefined
      );
      // Each issue may belong to a different project than the sprint's board,
      // so every issue is scope-checked before the call-size cap is applied.
      for (const ref of issueKeysOrIds) assertJiraIssueKeyAllowed(ref, client.jiraProjectKeys);
      if (issueKeysOrIds.length > MOVE_ISSUES_MAX) {
        throw new Error(
          `Cannot move ${issueKeysOrIds.length} issues in one call; the Agile API accepts at most ${MOVE_ISSUES_MAX} per call.`
        );
      }
      await client.post<void>(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
        issues: issueKeysOrIds,
      });
    },
  };
}

/**
 * Fetch + normalise a board by ID.
 * @param client - The shared Atlassian HTTP client.
 * @param boardId - The Jira Agile board ID.
 */
async function getBoardRaw(client: AtlassianClient, boardId: number): Promise<JiraBoard> {
  return mapBoard(await client.get<unknown>(`/rest/agile/1.0/board/${boardId}`));
}

/**
 * Map a raw Agile board to {@link JiraBoard}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapBoard(raw: unknown): JiraBoard {
  const o = (raw ?? {}) as Record<string, unknown>;
  const location = (o.location ?? {}) as Record<string, unknown>;
  return {
    id: Number(o.id ?? 0),
    name: String(o.name ?? ''),
    type: String(o.type ?? ''),
    project_key: location.projectKey ? String(location.projectKey) : undefined,
  };
}

/**
 * Map a raw Agile sprint to {@link JiraSprint}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @param fallbackBoardId - Board ID to use when the payload omits one.
 */
export function mapSprint(raw: unknown, fallbackBoardId?: number): JiraSprint {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: Number(o.id ?? 0),
    name: String(o.name ?? ''),
    state: String(o.state ?? ''),
    board_id: typeof o.originBoardId === 'number' ? o.originBoardId : fallbackBoardId,
    goal: o.goal ? String(o.goal) : undefined,
    start_date: o.startDate ? String(o.startDate) : undefined,
    end_date: o.endDate ? String(o.endDate) : undefined,
    complete_date: o.completeDate ? String(o.completeDate) : undefined,
  };
}

/**
 * Map a raw Agile board configuration to {@link JiraBoardConfiguration}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapBoardConfiguration(raw: unknown): JiraBoardConfiguration {
  const o = (raw ?? {}) as Record<string, unknown>;
  const filter = (o.filter ?? {}) as Record<string, unknown>;
  const columnConfig = (o.columnConfig ?? {}) as Record<string, unknown>;
  const columns = Array.isArray(columnConfig.columns) ? (columnConfig.columns as unknown[]) : [];
  return {
    id: Number(o.id ?? 0),
    name: String(o.name ?? ''),
    filter_id: filter.id ? String(filter.id) : undefined,
    column_names: columns.map((c) => String((c as Record<string, unknown>).name ?? '')),
  };
}
