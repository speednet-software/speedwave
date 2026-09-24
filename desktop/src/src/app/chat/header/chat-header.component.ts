import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { ProjectPillComponent } from '../../project-switcher/project-pill.component';
import { IconComponent } from '../../shared/icon.component';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { BetaService } from '../../services/beta.service';
import { ChatTabsComponent } from '../chat-tabs/chat-tabs.component';

/**
 * Chat header strip — terminal-minimal layout. Full mode shows conversation controls (history/memory/new), the
 * beta-gated inline tab strip, and the project pill. `compact` hides the conversation controls (and the tab
 * strip) so blocked chat states (no-provider, auth-required) still expose only the title and project switcher.
 */
@Component({
  selector: 'app-chat-header',
  imports: [ProjectPillComponent, IconComponent, TooltipDirective, ChatTabsComponent],
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
          appTooltip="Restart current conversation"
          tooltipKbd="⌘R"
          aria-label="Restart current conversation"
          (click)="newConversation.emit()"
        >
          <app-icon name="plus" class="h-4 w-4" />
        </button>
      }

      <h1
        data-testid="chat-header-title"
        class="view-title view-title-page flex-shrink-0 truncate text-[var(--ink)]"
      >
        {{ viewTitle() }}
      </h1>

      @if (!compact() && beta.enabled()) {
        <app-chat-tabs />
      }

      <div class="ml-auto flex flex-shrink-0 items-center gap-3">
        <app-project-pill />
      </div>
    </div>
  `,
})
export class ChatHeaderComponent {
  protected readonly beta = inject(BetaService);

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
  /** Restart the current conversation (plus button → ⌘R). */
  readonly newConversation = output<void>();
}
