import { describe, it, expect } from 'vitest';
import { foldTaskPlan } from './task-plan';

type TaskToolCall = Parameters<typeof foldTaskPlan>[0][number];

function call(
  tool_name: string,
  input: Record<string, unknown>,
  result: string | null = '',
  is_error = false
): TaskToolCall {
  return { tool_name, input_json: JSON.stringify(input), result, is_error };
}

function create(subject: string, id: number | null, activeForm?: string): TaskToolCall {
  return call(
    'TaskCreate',
    { subject, description: `${subject} in detail`, activeForm },
    id === null ? null : `Task #${id} created successfully: ${subject}`
  );
}

describe('foldTaskPlan', () => {
  it('has no plan without task tool calls', () => {
    expect(foldTaskPlan([])).toBeNull();
    expect(foldTaskPlan([call('Bash', { command: 'ls' })])).toBeNull();
  });

  it('collects created tasks as pending, in order, with the id from the result', () => {
    expect(foldTaskPlan([create('Write tests', 1, 'Writing tests'), create('Ship', 2)])).toEqual([
      { id: '1', subject: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
      { id: '2', subject: 'Ship', status: 'pending', activeForm: undefined },
    ]);
  });

  it('applies updates by id: status, subject and active form', () => {
    const plan = foldTaskPlan([
      create('Write tests', 4),
      create('Ship', 5),
      call('TaskUpdate', { taskId: '4', status: 'completed' }, 'Updated task #4 status'),
      call('TaskUpdate', { taskId: '5', status: 'in_progress', subject: 'Ship it' }),
      call('TaskUpdate', { taskId: '5', activeForm: 'Shipping' }),
    ]);
    expect(plan).toEqual([
      { id: '4', subject: 'Write tests', status: 'completed', activeForm: undefined },
      { id: '5', subject: 'Ship it', status: 'in_progress', activeForm: 'Shipping' },
    ]);
  });

  it('removes a task updated to deleted, and has no plan once every task is gone', () => {
    const calls = [
      create('A', 1),
      create('B', 2),
      call('TaskUpdate', { taskId: '1', status: 'deleted' }),
    ];
    expect(foldTaskPlan(calls)?.map((t) => t.subject)).toEqual(['B']);
    expect(
      foldTaskPlan([...calls, call('TaskUpdate', { taskId: '2', status: 'deleted' })])
    ).toBeNull();
  });

  it('ignores an update for an unknown id instead of inventing a task', () => {
    expect(
      foldTaskPlan([create('A', 1), call('TaskUpdate', { taskId: '9', status: 'completed' })])
    ).toEqual([{ id: '1', subject: 'A', status: 'pending', activeForm: undefined }]);
    expect(foldTaskPlan([call('TaskUpdate', { taskId: '1', status: 'completed' })])).toBeNull();
  });

  it('numbers a create by creation order while its call runs or when its result does not parse', () => {
    const plan = foldTaskPlan([
      create('A', 1),
      call('TaskCreate', { subject: 'B' }, 'Created.'),
      create('C', null),
      call('TaskUpdate', { taskId: '3', status: 'in_progress' }),
    ]);
    expect(plan?.map((t) => [t.id, t.subject, t.status])).toEqual([
      ['1', 'A', 'pending'],
      ['2', 'B', 'pending'],
      ['3', 'C', 'in_progress'],
    ]);
  });

  it('skips a create or an update that failed', () => {
    const plan = foldTaskPlan([
      create('A', 1),
      call('TaskCreate', { subject: 'B' }, 'boom', true),
      call('TaskUpdate', { taskId: '1', status: 'completed' }, 'boom', true),
    ]);
    expect(plan).toEqual([{ id: '1', subject: 'A', status: 'pending', activeForm: undefined }]);
  });

  it('leaves the plan unchanged on TaskList and TaskGet', () => {
    const before = [create('A', 1)];
    expect(
      foldTaskPlan([
        ...before,
        call('TaskList', {}, '#1 [pending] A'),
        call('TaskGet', { taskId: '1' }),
      ])
    ).toEqual(foldTaskPlan(before));
  });

  it('takes a TodoWrite list as the whole plan', () => {
    const plan = foldTaskPlan([
      call('TodoWrite', {
        todos: [
          { content: 'Read code', status: 'completed', activeForm: 'Reading code' },
          { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
        ],
      }),
    ]);
    expect(plan).toEqual([
      { id: '1', subject: 'Read code', status: 'completed', activeForm: 'Reading code' },
      { id: '2', subject: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
    ]);
  });

  it('lets the most recent family win in a mixed session', () => {
    const todo = call('TodoWrite', { todos: [{ content: 'Old todo', status: 'pending' }] });
    expect(foldTaskPlan([create('Task A', 1), todo])?.map((t) => t.subject)).toEqual(['Old todo']);
    expect(foldTaskPlan([todo, create('Task A', 1)])?.map((t) => t.subject)).toEqual(['Task A']);
    expect(
      foldTaskPlan([todo, call('TaskUpdate', { taskId: '1', status: 'completed' })])?.map(
        (t) => t.status
      )
    ).toEqual(['pending']);
  });

  it('keeps counting creates across a TodoWrite in between when no result carries the id', () => {
    const plan = foldTaskPlan([
      create('A', null),
      call('TodoWrite', { todos: [{ content: 'Todo', status: 'pending' }] }),
      create('B', null),
      call('TaskUpdate', { taskId: '2', status: 'completed' }),
    ]);
    expect(plan).toEqual([{ id: '2', subject: 'B', status: 'completed', activeForm: undefined }]);
  });

  it('has no plan for an empty TodoWrite list or malformed input', () => {
    expect(foldTaskPlan([call('TodoWrite', { todos: [] })])).toBeNull();
    expect(
      foldTaskPlan([
        { tool_name: 'TaskCreate', input_json: '{not json', result: '', is_error: false },
      ])
    ).toBeNull();
  });
});
