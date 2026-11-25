import type { TaskState, WorkflowAgent, WorkflowPhase } from '../../models/chat';
import type { ToolUseState } from '../../models/state-tree';
import { isStoppedResult } from './agents';

/** What the session knows about one workflow run beyond its tool block. */
export interface WorkflowRun {
  state: TaskState | null;
  phases: readonly WorkflowPhase[];
  agents: readonly WorkflowAgent[];
}

/** Workflow runs keyed by the tool-use id of the `Workflow` call that started them. */
export type WorkflowRuns = ReadonlyMap<string, WorkflowRun>;

/** One workflow agent as the tool block shows it. */
export interface WorkflowAgentView {
  label: string;
  state: TaskState;
  lastTool: string;
  toolCount: number;
  duration: string;
  result: string | null;
}

/** One phase of a workflow with its agents. */
export interface WorkflowPhaseView {
  index: number;
  title: string;
  agents: readonly WorkflowAgentView[];
}

/** One workflow as the tool block shows it. */
export interface WorkflowView {
  status: TaskState;
  phaseCounter: string;
  phases: readonly WorkflowPhaseView[];
}

type WorkflowCall = Pick<ToolUseState, 'tool_id' | 'tool_name' | 'result' | 'is_error'>;

const NO_RUN: WorkflowRun = { state: null, phases: [], agents: [] };

export const NO_WORKFLOW_RUNS: WorkflowRuns = new Map();

export const NO_WORKFLOW_VIEWS: ReadonlyMap<string, WorkflowView> = new Map();

const WORKFLOW_TOOL = 'Workflow';

/**
 * Records the status of a workflow.
 * @param runs - Current runs.
 * @param toolId - Tool-use id of the workflow's own call.
 * @param state - The status the session reported.
 */
export function withWorkflowStatus(
  runs: WorkflowRuns,
  toolId: string,
  state: TaskState
): WorkflowRuns {
  const run = runs.get(toolId) ?? NO_RUN;
  if (state === 'running' && run.state !== null && run.state !== 'running') return runs;
  return new Map(runs).set(toolId, { ...run, state });
}

/**
 * Replaces the snapshot of a workflow.
 * @param runs - Current runs.
 * @param toolId - Tool-use id of the workflow's own call.
 * @param phases - All phases of the workflow.
 * @param agents - All agents of the workflow.
 */
export function withWorkflowProgress(
  runs: WorkflowRuns,
  toolId: string,
  phases: readonly WorkflowPhase[],
  agents: readonly WorkflowAgent[]
): WorkflowRuns {
  const run = runs.get(toolId) ?? NO_RUN;
  return new Map(runs).set(toolId, { ...run, phases, agents });
}

function statusOf(call: WorkflowCall, run: WorkflowRun): TaskState {
  if (run.state !== null) return run.state;
  if (call.result === null) return 'running';
  if (!call.is_error) return 'completed';
  return isStoppedResult(call.result) ? 'stopped' : 'error';
}

function currentPhase(phases: readonly WorkflowPhase[], agents: readonly WorkflowAgent[]): number {
  const running = agents.filter((a) => a.state === 'running').map((a) => a.phase_index);
  return running.length > 0 ? Math.min(...running) : Math.max(...phases.map((p) => p.index));
}

function phaseCounter(phases: readonly WorkflowPhase[], agents: readonly WorkflowAgent[]): string {
  return phases.length === 0 ? '' : `phase ${currentPhase(phases, agents)}/${phases.length}`;
}

function lastTool(agent: WorkflowAgent): string {
  return `${agent.last_tool_name ?? ''} ${agent.last_tool_summary ?? ''}`.trim();
}

/**
 * Duration as a short label.
 * @param ms - Duration in milliseconds.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const whole = Math.round(ms / 1000);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

function agentView(agent: WorkflowAgent): WorkflowAgentView {
  return {
    label: agent.label,
    state: agent.state,
    lastTool: lastTool(agent),
    toolCount: agent.tool_calls,
    duration: formatDuration(agent.duration_ms),
    result: agent.state !== 'running' && agent.result_preview ? agent.result_preview : null,
  };
}

function phaseViews(
  phases: readonly WorkflowPhase[],
  agents: readonly WorkflowAgent[]
): readonly WorkflowPhaseView[] {
  return [...phases]
    .sort((a, b) => a.index - b.index)
    .map((phase) => ({
      index: phase.index,
      title: phase.title,
      agents: agents.filter((a) => a.phase_index === phase.index).map(agentView),
    }));
}

/**
 * Folds the session's `Workflow` calls and workflow runs into what each block shows.
 * @param calls - Tool calls in transcript order.
 * @param runs - What the session reported about each workflow.
 */
export function foldWorkflows(
  calls: readonly WorkflowCall[],
  runs: WorkflowRuns
): ReadonlyMap<string, WorkflowView> {
  const views = new Map<string, WorkflowView>();
  for (const call of calls) {
    const run = runs.get(call.tool_id);
    if (call.tool_name !== WORKFLOW_TOOL || run === undefined) continue;
    views.set(call.tool_id, {
      status: statusOf(call, run),
      phaseCounter: phaseCounter(run.phases, run.agents),
      phases: phaseViews(run.phases, run.agents),
    });
  }
  return views;
}

/**
 * Whether two workflow view maps show the same thing.
 * @param a - Previous views.
 * @param b - Recomputed views.
 */
export function sameWorkflows(
  a: ReadonlyMap<string, WorkflowView>,
  b: ReadonlyMap<string, WorkflowView>
): boolean {
  return (
    a.size === b.size &&
    [...a].every(([id, x]) => {
      const y = b.get(id);
      return y !== undefined && JSON.stringify(x) === JSON.stringify(y);
    })
  );
}
