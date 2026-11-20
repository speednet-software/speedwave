import type { ConversationTranscript, SubagentCall, SubagentState } from '../../models/chat';
import type { ToolUseState } from '../../models/state-tree';
import { normalizeToolInput } from '../../models/tool-input';
import { toolSummary } from '../blocks/tool-summary';

/** What the live session knows about one subagent beyond its tool block: its tool calls and its task status. */
export interface AgentRun {
  activities: readonly SubagentCall[];
  state: SubagentState | null;
  summary: string;
}

/** Subagent runs keyed by the tool-use id of the `Agent` or `Task` call that started them. */
export type AgentRuns = ReadonlyMap<string, AgentRun>;

/** One subagent as the transcript block and the agent panel show it. */
export interface AgentView {
  id: string;
  label: string;
  type: string | null;
  background: boolean;
  status: SubagentState;
  toolCount: number;
  lastActivity: string;
  result: string | null;
}

type AgentCall = Pick<ToolUseState, 'tool_id' | 'tool_name' | 'input' | 'result' | 'is_error'>;

const NO_RUN: AgentRun = { activities: [], state: null, summary: '' };

export const NO_AGENT_RUNS: AgentRuns = new Map();

export const NO_AGENT_VIEWS: ReadonlyMap<string, AgentView> = new Map();

/**
 * Adds a tool call a subagent made to its run; a call already recorded is ignored.
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
 * Records the status of a subagent; a final status is not taken back by a later `running`.
 * @param runs - Current runs.
 * @param toolId - Tool-use id of the subagent's own call.
 * @param state - The status the session reported.
 * @param summary - The agent's result text; empty keeps the one already known.
 */
export function withAgentStatus(
  runs: AgentRuns,
  toolId: string,
  state: SubagentState,
  summary: string
): AgentRuns {
  const run = runs.get(toolId) ?? NO_RUN;
  if (state === 'running' && run.state !== null && run.state !== 'running') return runs;
  return new Map(runs).set(toolId, { ...run, state, summary: summary || run.summary });
}

/**
 * Subagent runs a resumed transcript carries: the tool calls, no status.
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

function statusOf(call: AgentCall, run: AgentRun, background: boolean): SubagentState {
  if (run.state !== null && run.state !== 'running') return run.state;
  if (run.state === 'running' && background) return 'running';
  if (call.result === null) return 'running';
  return call.is_error ? 'error' : 'completed';
}

function describeActivity(call: SubagentCall): string {
  return `${call.tool_name} ${toolSummary(normalizeToolInput(call.tool_name, call.input_json))}`.trim();
}

/**
 * Folds the session's tool calls and subagent runs into the agents of the session, in call order.
 * A background agent that reported running stays running until its final status arrives.
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
      result: run.summary || call.result,
    });
  }
  return agents;
}

/**
 * Whether two agent lists show the same thing, so a recomputed list does not redraw the chat.
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
 * Glyph for an agent's status.
 * @param status - The agent's status.
 */
export function agentStatusGlyph(status: SubagentState): string {
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
export function agentStatusColor(status: SubagentState): string {
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
