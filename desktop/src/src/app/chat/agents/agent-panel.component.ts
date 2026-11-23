import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { TaskState } from '../../models/chat';
import {
  agentStatusColor,
  agentStatusGlyph,
  agentStatusWord,
  toolCountLabel,
  type AgentView,
} from './agents';

const SUMMARY_ORDER: readonly TaskState[] = ['running', 'completed', 'error', 'stopped'];

/** Pinned view of the subagents at work or just finished, above the composer. */
@Component({
  selector: 'app-agent-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (agents().length > 0) {
      <section
        data-testid="agent-panel"
        class="mono mb-2 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-1.5 text-[11.5px]"
      >
        <button
          type="button"
          data-testid="agent-panel-toggle"
          [attr.aria-expanded]="expanded()"
          [attr.aria-controls]="listId"
          class="flex w-full items-center gap-2 text-left"
          (click)="expandedChange.emit(!expanded())"
        >
          <span data-testid="agent-panel-summary" aria-live="polite" class="text-[var(--ink-dim)]">
            {{ summary() }}
          </span>
          <span aria-hidden="true" class="ml-auto text-[var(--ink-mute)]">{{
            expanded() ? '▾' : '▸'
          }}</span>
        </button>
        @if (expanded()) {
          <ul [id]="listId" data-testid="agent-panel-list" class="mt-1.5 list-none space-y-1">
            @for (agent of agents(); track agent.id) {
              <li data-testid="agent-panel-item" [attr.data-status]="agent.status">
                <div class="flex items-baseline gap-2" [class]="statusColor(agent.status)">
                  <span aria-hidden="true">{{ statusGlyph(agent.status) }}</span>
                  <span data-testid="agent-panel-label" class="truncate">{{ agent.label }}</span>
                  @if (agent.type) {
                    <span data-testid="agent-panel-type" class="text-[var(--ink-mute)]">{{
                      agent.type
                    }}</span>
                  }
                  <span
                    data-testid="agent-panel-meta"
                    class="ml-auto shrink-0 text-[var(--ink-mute)]"
                    >{{ statusWord(agent.status) }} · {{ toolCountLabel(agent.toolCount) }}</span
                  >
                </div>
                @if (agent.lastActivity) {
                  <div
                    data-testid="agent-panel-activity"
                    class="truncate pl-4 text-[var(--ink-mute)]"
                  >
                    {{ agent.lastActivity }}
                  </div>
                }
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
})
export class AgentPanelComponent {
  readonly agents = input.required<readonly AgentView[]>();
  readonly expanded = input.required<boolean>();
  readonly expandedChange = output<boolean>();

  private static nextInstance = 0;
  protected readonly listId = `agent-panel-list-${++AgentPanelComponent.nextInstance}`;

  protected readonly summary = computed(() => {
    const agents = this.agents();
    const parts = SUMMARY_ORDER.flatMap((status) => {
      const count = agents.filter((a) => a.status === status).length;
      return count > 0 ? [`${count} ${agentStatusWord(status)}`] : [];
    });
    return `Agents ${parts.join(', ')}`;
  });

  protected readonly statusGlyph = agentStatusGlyph;
  protected readonly statusColor = agentStatusColor;
  protected readonly statusWord = agentStatusWord;
  protected readonly toolCountLabel = toolCountLabel;
}
