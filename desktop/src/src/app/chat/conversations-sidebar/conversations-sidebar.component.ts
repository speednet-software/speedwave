import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type { ConversationSummary } from '../../models/chat';

/**
 * Left-drawer conversations sidebar listing past sessions for the active project.
 *
 * Matches the terminal-minimal mockup: a 280px absolute drawer anchored to the
 * left edge, with a mono `conversations` header, close button, a `+ new` button,
 * and a scrollable list of conversation rows (preview, timestamp, message count).
 *
 * Each row exposes two actions — view (read-only transcript) and resume (continue
 * session) — matching the legacy chat.component behaviour. The active row is
 * highlighted with an `accent` border-left and bold text.
 *
 * Uses `@Input`/`@Output` decorators rather than signal input()/output() to stay
 * compatible with the project's Vitest runner (no AOT compiler pass).
 */
@Component({
  selector: 'app-conversations-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open) {
      <aside
        class="absolute left-0 top-0 h-full w-[280px] bg-bg-1 ring-1 ring-line flex flex-col z-10"
        role="navigation"
        aria-label="Conversations"
        data-testid="conversations-sidebar"
      >
        <div class="flex h-11 items-center gap-2 border-b border-line px-3">
          <span class="font-mono text-[11px] text-ink-mute">conversations</span>
          <span class="font-mono text-[10px] text-ink-mute ml-1">{{ conversations.length }}</span>
          <button
            type="button"
            class="ml-auto font-mono text-[11px] text-accent hover:underline"
            data-testid="conversations-sidebar-new"
            aria-label="New conversation"
            (click)="newConversation.emit()"
          >
            + new
          </button>
          <button
            type="button"
            class="text-ink-mute hover:text-ink text-sm px-1"
            data-testid="conversations-sidebar-close"
            aria-label="Close conversations sidebar"
            (click)="closed.emit()"
          >
            ×
          </button>
        </div>
        <div class="flex-1 overflow-y-auto py-1">
          @for (conv of conversations; track conv.session_id) {
            @let active = conv.session_id === currentSessionId;
            <div
              class="flex items-stretch border-l-2"
              [class.border-accent]="active"
              [class.border-transparent]="!active"
              [class.bg-bg-2]="active"
              data-testid="conversations-sidebar-row"
            >
              <button
                type="button"
                class="flex-1 min-w-0 px-3 py-2 text-left hover:bg-bg-2"
                [attr.data-testid]="'conversation-view-' + conv.session_id"
                [attr.aria-current]="active ? 'true' : null"
                (click)="viewConversation.emit(conv)"
              >
                <div
                  class="truncate text-[13px]"
                  [class.text-accent]="active"
                  [class.text-ink]="!active"
                >
                  {{ conv.preview || 'untitled' }}
                </div>
                <div class="font-mono mt-0.5 text-[10px] text-ink-mute">
                  {{ conv.message_count }} · {{ conv.timestamp ?? 'unknown' }}
                </div>
              </button>
              <button
                type="button"
                class="font-mono text-[10px] text-ink-mute hover:text-accent px-2"
                [attr.data-testid]="'conversation-resume-' + conv.session_id"
                aria-label="Resume conversation"
                (click)="resumeConversation.emit(conv)"
              >
                resume
              </button>
            </div>
          } @empty {
            <div class="p-4 text-center font-mono text-[11.5px] text-ink-mute">
              no conversations yet
            </div>
          }
        </div>
      </aside>
    }
  `,
})
export class ConversationsSidebarComponent {
  @Input() open = false;
  @Input({ required: true }) conversations!: readonly ConversationSummary[];
  @Input() currentSessionId: string | null = null;
  @Output() readonly closed = new EventEmitter<void>();
  @Output() readonly newConversation = new EventEmitter<void>();
  @Output() readonly viewConversation = new EventEmitter<ConversationSummary>();
  @Output() readonly resumeConversation = new EventEmitter<ConversationSummary>();
}
