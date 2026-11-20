import { describe, it, expect } from 'vitest';
import type { ConversationTranscript, SubagentCall } from '../../models/chat';
import {
  NO_AGENT_RUNS,
  agentRunsFromTranscript,
  agentStatusGlyph,
  foldAgents,
  isStoppedResult,
  sameAgents,
  withAgentActivity,
  withAgentStatus,
  type AgentRun,
  type AgentRuns,
} from './agents';

type AgentCall = Parameters<typeof foldAgents>[0][number];

function agentCall(
  tool_id: string,
  input: Record<string, unknown>,
  result: string | null = null,
  tool_name = 'Agent',
  is_error = false
): AgentCall {
  return { tool_id, tool_name, input: JSON.stringify(input), result, is_error };
}

function bash(tool_id: string, command: string): SubagentCall {
  return { tool_id, tool_name: 'Bash', input_json: JSON.stringify({ command }) };
}

function runs(entries: Record<string, Partial<AgentRun>>): AgentRuns {
  return new Map(
    Object.entries(entries).map(([id, run]): [string, AgentRun] => [
      id,
      { activities: [], state: null, summary: '', ...run },
    ])
  );
}

describe('foldAgents', () => {
  it('has no agents without an Agent or Task call', () => {
    expect(foldAgents([], NO_AGENT_RUNS)).toEqual([]);
    expect(foldAgents([agentCall('b1', { command: 'ls' }, '', 'Bash')], NO_AGENT_RUNS)).toEqual([]);
  });

  it('reads an agent from the Agent call and from the Task call alike', () => {
    const input = { description: 'Explore code', subagent_type: 'Explore' };
    const [agent, task] = foldAgents(
      [agentCall('a1', input), agentCall('a2', input, null, 'Task')],
      NO_AGENT_RUNS
    );
    expect(agent).toMatchObject({ id: 'a1', label: 'Explore code', type: 'Explore' });
    expect(task).toMatchObject({ id: 'a2', label: 'Explore code', type: 'Explore' });
  });

  it('labels an agent by its type, then by a plain word, when it has no description', () => {
    const [typed, bare] = foldAgents(
      [agentCall('a1', { subagent_type: 'general-purpose' }), agentCall('a2', {})],
      NO_AGENT_RUNS
    );
    expect(typed.label).toBe('general-purpose');
    expect(bare.label).toBe('subagent');
  });

  it('runs a foreground agent until its call is answered, then completes or fails it', () => {
    const [running, done, failed] = foldAgents(
      [
        agentCall('a1', {}),
        agentCall('a2', {}, 'report'),
        agentCall('a3', {}, 'It failed', 'Agent', true),
      ],
      NO_AGENT_RUNS
    );
    expect([running.status, done.status, failed.status]).toEqual(['running', 'completed', 'error']);
    expect(done.result).toBe('report');
  });

  it('keeps a background agent running after its launch result until a final status', () => {
    const call = agentCall('a1', { run_in_background: true }, 'Async agent launched');
    expect(foldAgents([call], runs({ a1: { state: 'running' } }))[0]).toMatchObject({
      status: 'running',
      background: true,
    });
    expect(
      foldAgents([call], runs({ a1: { state: 'completed', summary: 'all quiet' } }))[0]
    ).toMatchObject({ status: 'completed', result: 'all quiet' });
  });

  it('calls an interrupted foreground agent stopped, and any other error failed', () => {
    const [interrupted, stopped, failed] = foldAgents(
      [
        agentCall('a1', {}, 'Interrupted', 'Agent', true),
        agentCall('a2', {}, 'Stopped by the user', 'Agent', true),
        agentCall('a3', {}, 'boom', 'Agent', true),
      ],
      NO_AGENT_RUNS
    );
    expect([interrupted.status, stopped.status, failed.status]).toEqual([
      'stopped',
      'stopped',
      'error',
    ]);
  });

  it('shows the report of a background agent only once it arrives, not its launch result', () => {
    const call = agentCall('a1', { run_in_background: true }, 'Async agent launched');
    expect(foldAgents([call], NO_AGENT_RUNS)[0].result).toBeNull();
    expect(foldAgents([call], runs({ a1: { summary: 'all quiet' } }))[0].result).toBe('all quiet');
  });

  it('shows the status the session reported over the state of the call', () => {
    const answered = agentCall('a1', {}, 'report');
    expect(foldAgents([answered], runs({ a1: { state: 'error' } }))[0].status).toBe('error');
    expect(foldAgents([answered], runs({ a1: { state: 'stopped' } }))[0].status).toBe('stopped');
    expect(foldAgents([answered], runs({ a1: { state: 'running' } }))[0].status).toBe('completed');
  });

  it('takes an agent without a status of its own from its call, background or not', () => {
    const launched = agentCall('a1', { run_in_background: true }, 'Async agent launched');
    expect(foldAgents([launched], NO_AGENT_RUNS)[0].status).toBe('completed');
  });

  it('counts the tool calls of each parallel agent and names the last one', () => {
    const agents = foldAgents(
      [agentCall('a1', { description: 'One' }), agentCall('a2', { description: 'Two' })],
      runs({
        a1: { activities: [bash('s1', 'ls'), bash('s2', 'make test')] },
        a2: {
          activities: [{ tool_id: 's3', tool_name: 'Read', input_json: '{"file_path":"/x"}' }],
        },
      })
    );
    expect(agents.map((a) => [a.id, a.toolCount, a.lastActivity])).toEqual([
      ['a1', 2, 'Bash $ make test'],
      ['a2', 1, 'Read /x'],
    ]);
  });

  it('names a tool the normalizer does not know by its name alone', () => {
    const [agent] = foldAgents(
      [agentCall('a1', {})],
      runs({ a1: { activities: [{ tool_id: 's1', tool_name: 'Mystery', input_json: '{}' }] } })
    );
    expect(agent.lastActivity).toBe('Mystery');
  });

  it('keeps the call order', () => {
    const agents = foldAgents(
      [agentCall('a2', {}), agentCall('b1', {}, '', 'Bash'), agentCall('a1', {})],
      NO_AGENT_RUNS
    );
    expect(agents.map((a) => a.id)).toEqual(['a2', 'a1']);
  });
});

describe('agent runs', () => {
  it('adds a tool call to the run of its parent once', () => {
    const first = withAgentActivity(NO_AGENT_RUNS, 'a1', bash('s1', 'ls'));
    const again = withAgentActivity(first, 'a1', bash('s1', 'ls'));
    expect(again).toBe(first);
    expect(withAgentActivity(first, 'a1', bash('s2', 'pwd')).get('a1')?.activities).toHaveLength(2);
  });

  it('keeps the earlier summary when a later status has none', () => {
    const done = withAgentStatus(NO_AGENT_RUNS, 'a1', 'completed', 'report');
    expect(withAgentStatus(done, 'a1', 'error', '').get('a1')).toMatchObject({
      state: 'error',
      summary: 'report',
    });
  });

  it('does not take a final status back with a later running', () => {
    const done = withAgentStatus(NO_AGENT_RUNS, 'a1', 'completed', '');
    expect(withAgentStatus(done, 'a1', 'running', '')).toBe(done);
  });

  it('reads the tool calls of agents out of a transcript, without a status', () => {
    const transcript: ConversationTranscript = {
      session_id: 's',
      messages: [
        {
          role: 'assistant',
          content: '',
          timestamp: null,
          blocks: [
            { type: 'text', content: 'hi' },
            {
              type: 'tool_use',
              tool_id: 'a1',
              tool_name: 'Agent',
              input: '{}',
              result: null,
              is_error: false,
              activities: [bash('s1', 'ls')],
            },
            {
              type: 'tool_use',
              tool_id: 'b1',
              tool_name: 'Bash',
              input: '{}',
              result: null,
              is_error: false,
              activities: [],
            },
          ],
        },
        { role: 'user', content: 'plain', timestamp: null },
      ],
    };
    const result = agentRunsFromTranscript(transcript);
    expect([...result.keys()]).toEqual(['a1']);
    expect(result.get('a1')).toEqual({ activities: [bash('s1', 'ls')], state: null, summary: '' });
  });
});

describe('isStoppedResult', () => {
  it('matches stopped and interrupted results in any case', () => {
    expect(['Interrupted', 'Stopped by user', 'boom'].map(isStoppedResult)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe('sameAgents', () => {
  const [agent] = foldAgents([agentCall('a1', { description: 'One' })], NO_AGENT_RUNS);

  it('is true for equal lists and false for a changed field or length', () => {
    expect(sameAgents([agent], [{ ...agent }])).toBe(true);
    expect(sameAgents([agent], [{ ...agent, toolCount: 1 }])).toBe(false);
    expect(sameAgents([agent], [])).toBe(false);
  });
});

describe('agentStatusGlyph', () => {
  it('has one glyph per status', () => {
    expect(
      (['running', 'completed', 'error', 'stopped'] as const).map((s) => agentStatusGlyph(s))
    ).toEqual(['▸', '✓', '✗', '⊘']);
  });
});
