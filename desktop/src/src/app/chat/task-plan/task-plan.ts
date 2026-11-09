import { normalizeToolInput } from '../../models/tool-input';

/** One task of the current plan. */
export interface PlannedTask {
  id: string;
  subject: string;
  status: string;
  activeForm?: string;
}

interface TaskToolCall {
  tool_name: string;
  input_json: string;
  result: string | null;
  is_error: boolean;
}

const CREATED_TASK_ID = /#(\d+)/;

/**
 * Folds the session's tool calls into the current task plan, or null when there is none.
 * @param calls - Tool calls in transcript order.
 */
export function foldTaskPlan(calls: readonly TaskToolCall[]): readonly PlannedTask[] | null {
  let plan: PlannedTask[] = [];
  let family: 'todo' | 'task' | null = null;
  let created = 0;
  for (const call of calls) {
    if (call.is_error) continue;
    const input = normalizeToolInput(call.tool_name, call.input_json);
    switch (input.kind) {
      case 'todo_write':
        family = 'todo';
        plan = input.todos.map((todo, i) => ({
          id: String(i + 1),
          subject: todo.content,
          status: todo.status,
          activeForm: todo.activeForm,
        }));
        break;
      case 'task_create':
        if (family !== 'task') {
          family = 'task';
          plan = [];
        }
        created += 1;
        plan = [
          ...plan,
          {
            id: createdTaskId(call.result) ?? String(created),
            subject: input.subject,
            status: 'pending',
            activeForm: input.activeForm,
          },
        ];
        break;
      case 'task_update':
        if (family !== 'task') break;
        plan =
          input.status === 'deleted'
            ? plan.filter((t) => t.id !== input.task_id)
            : plan.map((t) =>
                t.id === input.task_id
                  ? {
                      ...t,
                      status: input.status ?? t.status,
                      subject: input.subject ?? t.subject,
                      activeForm: input.activeForm ?? t.activeForm,
                    }
                  : t
              );
        break;
    }
  }
  return plan.length > 0 ? plan : null;
}

function createdTaskId(result: string | null): string | null {
  return result?.match(CREATED_TASK_ID)?.[1] ?? null;
}
