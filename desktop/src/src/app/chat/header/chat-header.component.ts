import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { ProjectPillComponent } from '../../project-switcher/project-pill.component';
import { IconComponent } from '../../shared/icon.component';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { ManagedMarkComponent } from '../../shared/managed-mark.component';
import { ManagementService } from '../../services/management.service';
import {
  complianceLabel,
  complianceTone,
  deploymentLabel,
  riskLabel,
} from '../../models/management';

/**
 * Chat header strip — terminal-minimal layout. Full mode shows conversation controls (history/memory/new) plus the project pill.
 * `compact` hides the conversation controls so blocked chat states (no-provider, auth-required) still expose the project switcher.
 */
@Component({
  selector: 'app-chat-header',
  imports: [ProjectPillComponent, IconComponent, TooltipDirective, ManagedMarkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block flex-shrink-0' },
  template: `
    <div
      data-testid="chat-header"
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
    >
      @if (!compact()) {
        <button
          type="button"
          data-testid="chat-header-history"
          class="inline-flex flex-shrink-0 items-center justify-center text-[var(--ink-mute)] hover:text-[var(--ink)]"
          appTooltip="Conversations"
          tooltipKbd="⌘B"
          aria-label="Toggle conversations sidebar"
          [attr.aria-pressed]="historyOpen()"
          (click)="toggleHistory.emit()"
        >
          <app-icon name="menu-alt" class="h-4 w-4" />
        </button>

        <button
          type="button"
          data-testid="chat-header-memory"
          class="inline-flex flex-shrink-0 items-center justify-center text-[var(--ink-mute)] hover:text-[var(--ink)]"
          appTooltip="Memory"
          aria-label="Toggle project memory panel"
          [attr.aria-pressed]="memoryOpen()"
          (click)="toggleMemory.emit()"
        >
          <app-icon name="brain" class="h-4 w-4" />
        </button>

        <button
          type="button"
          data-testid="chat-header-new"
          class="inline-flex flex-shrink-0 items-center justify-center text-[var(--ink-mute)] hover:text-[var(--ink)]"
          appTooltip="New conversation"
          tooltipKbd="⌘N"
          aria-label="New conversation"
          (click)="newConversation.emit()"
        >
          <app-icon name="plus" class="h-4 w-4" />
        </button>
      }

      <h1
        data-testid="chat-header-title"
        class="view-title view-title-page truncate text-[var(--ink)]"
      >
        {{ viewTitle() }}
      </h1>

      <div class="ml-auto flex min-w-0 items-center gap-3">
        @if (managedProject(); as p) {
          <span
            data-testid="chat-header-managed"
            class="mono hidden min-w-0 max-w-[420px] items-center gap-2 rounded border border-[var(--line)] px-2 py-0.5 text-[11px] sm:inline-flex"
            [appTooltip]="managedDetail()"
            placement="bottom"
          >
            <app-managed-mark class="h-3.5 w-3.5 text-[var(--ink)]" />
            <span class="truncate text-[var(--ink)]" data-testid="chat-header-managed-use-case">{{
              p.use_case?.name || 'No use case'
            }}</span>
            <span class="flex flex-shrink-0 items-center gap-1 text-[var(--ink-mute)]">
              <span [style.color]="managedTone()">●</span
              ><span data-testid="chat-header-managed-compliance">{{
                managedComplianceLabel()
              }}</span>
            </span>
          </span>
        }
        <app-project-pill />
      </div>
    </div>
  `,
})
export class ChatHeaderComponent {
  /** Conversation title (or default "Chat" when none set yet). */
  readonly viewTitle = input<string>('Chat');
  /** Whether the memory panel is currently open (drives aria-pressed). */
  readonly memoryOpen = input<boolean>(false);
  /** Whether the conversations drawer is currently open (drives aria-pressed). */
  readonly historyOpen = input<boolean>(false);
  /** Hide conversation controls, keep the project pill (blocked chat states). */
  readonly compact = input<boolean>(false);

  /** Toggle the memory panel drawer. */
  readonly toggleMemory = output<void>();
  /** Toggle the conversations drawer (hamburger button → ⌘B). */
  readonly toggleHistory = output<void>();
  /** Start a new conversation (plus button → ⌘N). */
  readonly newConversation = output<void>();

  private readonly management = inject(ManagementService);

  /** Under a managed policy: the use case this project realises, and its compliance with the provider. */
  protected readonly managedProject = computed(() => {
    const s = this.management.active();
    return s?.managed ? s.project : null;
  });
  protected readonly managedComplianceLabel = computed(() =>
    complianceLabel(this.managedProject()?.use_case?.compliance)
  );
  protected readonly managedTone = computed(
    () =>
      ({ ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', none: 'var(--ink-mute)' })[
        complianceTone(this.managedProject()?.use_case?.compliance)
      ]
  );
  protected readonly managedDetail = computed(() => {
    const p = this.managedProject();
    const s = this.management.active();
    if (!p) return '';
    const uc = p.use_case;
    return [
      `${s?.provider ?? 'Managed'} · ${s?.organization ?? 'your organisation'}`,
      uc ? `Use case: ${uc.name ?? uc.node_id}` : 'No use case',
      `Compliance: ${complianceLabel(uc?.compliance)} · risk ${riskLabel(uc?.compliance?.riskCategory)}`,
      `Deployment: ${deploymentLabel(p.deployment)}`,
      p.access === 'SUSPENDED' ? 'Access: suspended' : 'Access: allowed',
    ].join(' · ');
  });
}
