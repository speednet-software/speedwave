import { describe, it, expect } from 'vitest';
import type { WorkflowAgent, WorkflowPhase } from '../../models/chat';
import {
  NO_WORKFLOW_RUNS,
  foldWorkflows,
  formatDuration,
  sameWorkflows,
  withWorkflowProgress,
  withWorkflowStatus,
} from './workflows';

type WorkflowCall = Parameters<typeof foldWorkflows>[0][number];

const PHASES: WorkflowPhase[] = [
  { index: 1, title: 'Prepare' },
  { index: 2, title: 'Finish' },
];

const FIXTURE_AGENTS: WorkflowAgent[] = [
  {
    label: 'agent-a',
    phase_index: 1,
    state: 'completed',
    last_tool_name: 'Bash',
    last_tool_summary: 'echo REC-WFA-ok',
    tool_calls: 1,
    duration_ms: 8157,
    result_preview: 'agent done',
  },
  {
    label: 'agent-b',
    phase_index: 1,
    state: 'completed',
    last_tool_name: 'Bash',
    last_tool_summary: 'echo REC-WFB-ok',
    tool_calls: 1,
    duration_ms: 8085,
    result_preview: 'agent done',
  },
  { label: 'agent-c', phase_index: 2, state: 'error', tool_calls: 0, duration_ms: 23 },
];

function call(
  result: string | null = null,
  is_error = false,
  tool_name = 'Workflow'
): WorkflowCall {
  return { tool_id: 'w1', tool_name, result, is_error };
}

function agent(overrides: Partial<WorkflowAgent>): WorkflowAgent {
  return {
    label: 'a',
    phase_index: 1,
    state: 'running',
    tool_calls: 0,
    duration_ms: 0,
    ...overrides,
  };
}

function fold(
  agents: WorkflowAgent[],
  state: Parameters<typeof withWorkflowStatus>[2] | null = 'running',
  phases: WorkflowPhase[] = PHASES
) {
  let runs = withWorkflowProgress(NO_WORKFLOW_RUNS, 'w1', phases, agents);
  if (state !== null) runs = withWorkflowStatus(runs, 'w1', state);
  return foldWorkflows([call('launched')], runs).get('w1');
}

describe('foldWorkflows', () => {
  it('has no view without a Workflow call or without a run', () => {
    const runs = withWorkflowProgress(NO_WORKFLOW_RUNS, 'w1', PHASES, []);
    expect(foldWorkflows([], runs).size).toBe(0);
    expect(foldWorkflows([call('x', false, 'Agent')], runs).size).toBe(0);
    expect(foldWorkflows([call()], NO_WORKFLOW_RUNS).size).toBe(0);
  });

  it('folds the snapshot of the recorded workflow', () => {
    const view = fold(FIXTURE_AGENTS, 'completed');
    expect(view?.status).toBe('completed');
    expect(view?.phaseCounter).toBe('phase 2/2');
    expect(view?.phases.map((p) => [p.index, p.title, p.agents.map((a) => a.label)])).toEqual([
      [1, 'Prepare', ['agent-a', 'agent-b']],
      [2, 'Finish', ['agent-c']],
    ]);
    expect(view?.phases[0].agents[0]).toEqual({
      label: 'agent-a',
      state: 'completed',
      lastTool: 'Bash echo REC-WFA-ok',
      toolCount: 1,
      duration: '8.2s',
      result: 'agent done',
    });
    expect(view?.phases[1].agents[0]).toMatchObject({
      state: 'error',
      lastTool: '',
      duration: '23ms',
      result: null,
    });
  });

  it('counts the lowest phase with a running agent as the current one', () => {
    const view = fold([
      agent({ phase_index: 2 }),
      agent({ phase_index: 1, state: 'completed' }),
      agent({ phase_index: 2, state: 'completed' }),
    ]);
    expect(view?.phaseCounter).toBe('phase 2/2');
    expect(fold([agent({ phase_index: 1 }), agent({ phase_index: 2 })])?.phaseCounter).toBe(
      'phase 1/2'
    );
  });

  it('counts the last phase as current while no agent runs', () => {
    expect(fold([])?.phaseCounter).toBe('phase 2/2');
    expect(fold([agent({ state: 'completed' })])?.phaseCounter).toBe('phase 2/2');
  });

  it('shows no counter without phases', () => {
    expect(fold([], 'running', [])?.phaseCounter).toBe('');
  });

  it('orders phases by index and keeps agents of unknown phases out', () => {
    const view = fold([agent({ label: 'x', phase_index: 9 })], 'running', [
      { index: 2, title: 'B' },
      { index: 1, title: 'A' },
    ]);
    expect(view?.phases.map((p) => p.title)).toEqual(['A', 'B']);
    expect(view?.phases.every((p) => p.agents.length === 0)).toBe(true);
  });

  it('shows a result preview only for an agent in a finished state', () => {
    const view = fold([
      agent({ label: 'r', state: 'running', result_preview: 'partial' }),
      agent({ label: 'c', state: 'completed', result_preview: 'done' }),
      agent({ label: 'e', state: 'error', result_preview: 'boom' }),
      agent({ label: 's', state: 'stopped', result_preview: 'cut' }),
      agent({ label: 'n', state: 'completed' }),
    ]);
    expect(view?.phases[0].agents.map((a) => a.result)).toEqual([
      null,
      'done',
      'boom',
      'cut',
      null,
    ]);
  });

  it('names the last tool from the name alone or the summary alone', () => {
    const view = fold([agent({ last_tool_name: 'Read' }), agent({ last_tool_summary: 'x' })]);
    expect(view?.phases[0].agents.map((a) => a.lastTool)).toEqual(['Read', 'x']);
  });

  it('takes the status from the reported state, else from the call', () => {
    const runs = withWorkflowProgress(NO_WORKFLOW_RUNS, 'w1', PHASES, []);
    const status = (c: WorkflowCall) => foldWorkflows([c], runs).get('w1')?.status;
    expect(status(call())).toBe('running');
    expect(status(call('ok'))).toBe('completed');
    expect(status(call('boom', true))).toBe('error');
    expect(status(call('Interrupted by user', true))).toBe('stopped');
    const reported = withWorkflowStatus(runs, 'w1', 'running');
    expect(foldWorkflows([call('launched')], reported).get('w1')?.status).toBe('running');
  });
});

describe('withWorkflowStatus', () => {
  it('records the state and keeps the snapshot', () => {
    const runs = withWorkflowStatus(
      withWorkflowProgress(NO_WORKFLOW_RUNS, 'w1', PHASES, FIXTURE_AGENTS),
      'w1',
      'completed'
    );
    expect(runs.get('w1')).toEqual({
      state: 'completed',
      phases: PHASES,
      agents: FIXTURE_AGENTS,
    });
  });

  it('ignores a running status after a final one', () => {
    const done = withWorkflowStatus(NO_WORKFLOW_RUNS, 'w1', 'error');
    expect(withWorkflowStatus(done, 'w1', 'running')).toBe(done);
  });

  it('does not change the input map', () => {
    withWorkflowStatus(NO_WORKFLOW_RUNS, 'w1', 'running');
    expect(NO_WORKFLOW_RUNS.size).toBe(0);
  });
});

describe('withWorkflowProgress', () => {
  it('replaces the whole previous snapshot', () => {
    const first = withWorkflowProgress(NO_WORKFLOW_RUNS, 'w1', PHASES, FIXTURE_AGENTS);
    const second = withWorkflowProgress(first, 'w1', [PHASES[0]], [FIXTURE_AGENTS[0]]);
    expect(second.get('w1')?.phases).toEqual([PHASES[0]]);
    expect(second.get('w1')?.agents).toEqual([FIXTURE_AGENTS[0]]);
  });

  it('keeps the reported state', () => {
    const running = withWorkflowStatus(NO_WORKFLOW_RUNS, 'w1', 'running');
    expect(withWorkflowProgress(running, 'w1', PHASES, []).get('w1')?.state).toBe('running');
  });
});

describe('sameWorkflows', () => {
  it('compares what the views show', () => {
    const a = new Map([['w1', fold(FIXTURE_AGENTS, 'completed')!]]);
    const b = new Map([['w1', fold(FIXTURE_AGENTS, 'completed')!]]);
    const c = new Map([['w1', fold(FIXTURE_AGENTS, 'error')!]]);
    expect(sameWorkflows(a, b)).toBe(true);
    expect(sameWorkflows(a, c)).toBe(false);
    expect(sameWorkflows(a, new Map())).toBe(false);
    expect(sameWorkflows(a, new Map([['w2', fold(FIXTURE_AGENTS, 'completed')!]]))).toBe(false);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [23, '23ms'],
    [999, '999ms'],
    [1000, '1.0s'],
    [8157, '8.2s'],
    [59_949, '59.9s'],
    [60_000, '1m 0s'],
    [125_400, '2m 5s'],
  ])('formats %i ms as %s', (ms, label) => {
    expect(formatDuration(ms)).toBe(label);
  });
});
