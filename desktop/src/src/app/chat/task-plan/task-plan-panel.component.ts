import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { PlannedTask } from './task-plan';
import { taskStatusColor, taskStatusGlyph } from './task-status';

/** Pinned view of the agent's current task plan above the composer. */
@Component({
  selector: 'app-task-plan-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <section
        data-testid="task-plan-panel"
        class="mono mb-2 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-1.5 text-[11.5px]"
      >
        <button
          type="button"
          data-testid="task-plan-toggle"
          [attr.aria-expanded]="expanded()"
          [attr.aria-controls]="listId"
          class="flex w-full items-center gap-2 text-left"
          (click)="expandedChange.emit(!expanded())"
        >
          <span data-testid="task-plan-count" class="text-[var(--ink-dim)]">
            Tasks {{ doneCount() }}/{{ plan()?.length }}
          </span>
          @if (current()) {
            <span data-testid="task-plan-current" class="truncate text-[var(--accent)]">
              {{ current() }}
            </span>
          }
          <span aria-hidden="true" class="ml-auto text-[var(--ink-mute)]">{{
            expanded() ? '▾' : '▸'
          }}</span>
        </button>
        @if (expanded()) {
          <ul [id]="listId" data-testid="task-plan-list" class="mt-1.5 list-none space-y-0.5">
            @for (task of plan(); track task.id) {
              <li data-testid="task-plan-item" [class]="taskStatusColor(task.status)">
                {{ taskStatusGlyph(task.status) }}
                {{ label(task) }}
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
})
export class TaskPlanPanelComponent {
  readonly plan = input.required<readonly PlannedTask[] | null>();
  readonly streaming = input.required<boolean>();
  readonly expanded = input.required<boolean>();
  readonly expandedChange = output<boolean>();

  private static nextInstance = 0;
  protected readonly listId = `task-plan-list-${++TaskPlanPanelComponent.nextInstance}`;

  protected readonly doneCount = computed(
    () => this.plan()?.filter((t) => t.status === 'completed').length ?? 0
  );

  protected readonly visible = computed(() => {
    const plan = this.plan();
    if (plan === null) return false;
    return this.streaming() || this.doneCount() < plan.length;
  });

  protected readonly current = computed(() => {
    const task = this.plan()?.find((t) => t.status === 'in_progress');
    return task ? this.label(task) : '';
  });

  protected readonly taskStatusGlyph = taskStatusGlyph;
  protected readonly taskStatusColor = taskStatusColor;

  protected label(task: PlannedTask): string {
    return task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject;
  }
}
