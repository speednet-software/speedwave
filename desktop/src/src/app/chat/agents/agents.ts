import type { ConversationTranscript, SubagentCall, TaskState } from '../../models/chat';
import type { ToolUseState } from '../../models/state-tree';
import { normalizeToolInput } from '../../models/tool-input';
import { toolSummary } from '../blocks/tool-summary';

/** What the session knows about one subagent beyond its tool block. */
export interface AgentRun {
  activities: readonly SubagentCall[];
  state: TaskState | null;
  summary: string;
}

/** Subagent runs keyed by the tool-use id of the call that started them. */
export type AgentRuns = ReadonlyMap<string, AgentRun>;

/** One subagent as the transcript block and the agent panel show it. */
export interface AgentView {
  id: string;
  label: string;
  type: string | null;
  background: boolean;
  status: TaskState;
  toolCount: number;
  lastActivity: string;
  result: string | null;
}

type AgentCall = Pick<ToolUseState, 'tool_id' | 'tool_name' | 'input' | 'result' | 'is_error'>;

const NO_RUN: AgentRun = { activities: [], state: null, summary: '' };

export const NO_AGENT_RUNS: AgentRuns = new Map();

export const NO_AGENT_VIEWS: ReadonlyMap<string, AgentView> = new Map();

/**
 * Adds a tool call a subagent made to its run.
 * @param runs - Current runs.
 * @param parentToolId - Tool-use id of the subagent's own call.
 * @param call - The tool call the subagent made.
 */
export function withAgentActivity(
  runs: AgentRuns,
  parentToolId: string,
  call: SubagentCall
): AgentRuns {
  const run = runs.get(parentToolId) ?? NO_RUN;
  if (run.activities.some((a) => a.tool_id === call.tool_id)) return runs;
  return new Map(runs).set(parentToolId, { ...run, activities: [...run.activities, call] });
}

/**
 * Records the status of a subagent.
 * @param runs - Current runs.
 * @param toolId - Tool-use id of the subagent's own call.
 * @param state - The status the session reported.
 * @param summary - The agent's result text.
 */
export function withAgentStatus(
  runs: AgentRuns,
  toolId: string,
  state: TaskState,
  summary: string
): AgentRuns {
  const run = runs.get(toolId) ?? NO_RUN;
  if (state === 'running' && run.state !== null && run.state !== 'running') return runs;
  return new Map(runs).set(toolId, { ...run, state, summary: summary || run.summary });
}

/**
 * Subagent runs a resumed transcript carries.
 * @param transcript - The transcript `get_conversation` returned.
 */
export function agentRunsFromTranscript(transcript: ConversationTranscript): AgentRuns {
  const runs = new Map<string, AgentRun>();
  for (const message of transcript.messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_use' && block.activities.length > 0) {
        runs.set(block.tool_id, { ...NO_RUN, activities: block.activities });
      }
    }
  }
  return runs;
}

/**
 * Whether a tool result is the one a stopped or interrupted call ends with.
 * @param result - The result text of the call.
 */
export function isStoppedResult(result: string): boolean {
  const text = result.toLowerCase();
  return text.includes('stopped') || text.includes('interrupted');
}

function statusOf(call: AgentCall, run: AgentRun, background: boolean): TaskState {
  if (run.state !== null && run.state !== 'running') return run.state;
  if (run.state === 'running' && background) return 'running';
  if (call.result === null) return 'running';
  if (!call.is_error) return 'completed';
  return isStoppedResult(call.result) ? 'stopped' : 'error';
}

function describeActivity(call: SubagentCall): string {
  return `${call.tool_name} ${toolSummary(normalizeToolInput(call.tool_name, call.input_json))}`.trim();
}

/**
 * Folds the session's tool calls and subagent runs into its agents.
 * @param calls - Tool calls in transcript order.
 * @param runs - What the session reported about each subagent.
 */
export function foldAgents(calls: readonly AgentCall[], runs: AgentRuns): readonly AgentView[] {
  const agents: AgentView[] = [];
  for (const call of calls) {
    const input = normalizeToolInput(call.tool_name, call.input);
    if (input.kind !== 'agent') continue;
    const run = runs.get(call.tool_id) ?? NO_RUN;
    const background = input.run_in_background === true;
    const last = run.activities[run.activities.length - 1];
    agents.push({
      id: call.tool_id,
      label: input.description || input.subagent_type || 'subagent',
      type: input.subagent_type ?? null,
      background,
      status: statusOf(call, run, background),
      toolCount: run.activities.length,
      lastActivity: last ? describeActivity(last) : '',
      result: run.summary || (background ? null : call.result),
    });
  }
  return agents;
}

/**
 * Whether two agent lists show the same thing.
 * @param a - Previous list.
 * @param b - Recomputed list.
 */
export function sameAgents(a: readonly AgentView[], b: readonly AgentView[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        x.id === y.id &&
        x.label === y.label &&
        x.type === y.type &&
        x.background === y.background &&
        x.status === y.status &&
        x.toolCount === y.toolCount &&
        x.lastActivity === y.lastActivity &&
        x.result === y.result
      );
    })
  );
}

/**
 * Word for an agent's status in the panel and the block header.
 * @param status - The agent's status.
 */
export function agentStatusWord(status: TaskState): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'error':
      return 'failed';
    case 'stopped':
      return 'stopped';
  }
}

/**
 * Count of tool calls as a label.
 * @param count - Number of tool calls.
 */
export function toolCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'tool' : 'tools'}`;
}

/**
 * Glyph for an agent's status.
 * @param status - The agent's status.
 */
export function agentStatusGlyph(status: TaskState): string {
  switch (status) {
    case 'running':
      return '▸';
    case 'completed':
      return '✓';
    case 'error':
      return '✗';
    case 'stopped':
      return '⊘';
  }
}

/**
 * Tailwind color class for an agent's status.
 * @param status - The agent's status.
 */
export function agentStatusColor(status: TaskState): string {
  switch (status) {
    case 'running':
      return 'text-[var(--accent)]';
    case 'completed':
      return 'text-[var(--green)]';
    case 'error':
      return 'text-red-400';
    case 'stopped':
      return 'text-[var(--ink-mute)]';
  }
}
