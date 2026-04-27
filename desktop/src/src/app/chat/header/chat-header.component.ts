import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/**
 * Chat header strip — terminal-minimal layout.
 *
 * Mirrors the mockup (lines 488–506):
 * - Hamburger button (⌘B) opens the conversations drawer.
 * - Plus button (⌘N) starts a new conversation.
 * - Title (`view-title` font) — the active conversation's name.
 * - Right cluster: book-icon button toggles the memory panel, divider,
 *   monogram-prefixed project pill opens the project switcher.
 */
@Component({
  selector: 'app-chat-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block flex-shrink-0' },
  template: `
    <div
      data-testid="chat-header"
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
    >
      <button
        type="button"
        data-testid="chat-header-history"
        class="flex-shrink-0 text-[var(--ink-mute)] hover:text-[var(--ink)]"
        title="Conversations (⌘B)"
        aria-label="Toggle conversations sidebar"
        [attr.aria-pressed]="historyOpen()"
        (click)="toggleHistory.emit()"
      >
        <svg
          class="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          stroke-width="1.75"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h10M4 18h16" />
        </svg>
      </button>

      <button
        type="button"
        data-testid="chat-header-new"
        class="flex-shrink-0 text-[var(--ink-mute)] hover:text-[var(--ink)]"
        title="New conversation (⌘N)"
        aria-label="New conversation"
        (click)="newConversation.emit()"
      >
        <svg
          class="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          stroke-width="1.75"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>

      <h1 data-testid="chat-header-title" class="view-title truncate text-[14px] text-[var(--ink)]">
        {{ title() }}
      </h1>

      <div class="ml-auto flex flex-shrink-0 items-center gap-3">
        <button
          type="button"
          data-testid="chat-header-memory"
          class="flex-shrink-0 text-[var(--ink-mute)] hover:text-[var(--ink)]"
          title="Memory"
          aria-label="Toggle project memory panel"
          [attr.aria-pressed]="memoryOpen()"
          (click)="toggleMemory.emit()"
        >
          <svg
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            stroke-width="1.75"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
            />
          </svg>
        </button>
        @if (projectName()) {
          <span class="text-[var(--line-strong)]" aria-hidden="true">·</span>
          <button
            type="button"
            data-testid="chat-header-project"
            class="mono flex items-center gap-1.5 text-[11px] text-[var(--ink)] hover:text-[var(--accent)]"
            title="Switch project"
            aria-label="Switch project"
            (click)="openProjectSwitcher.emit()"
          >
            <span
              class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-[var(--violet)] text-[8px] font-bold text-[#07090f]"
              aria-hidden="true"
            >
              {{ monogram() }}
            </span>
            <span>{{ projectName() }}</span>
          </button>
        }
      </div>
    </div>
  `,
})
export class ChatHeaderComponent {
  /** Conversation title (or default "Chat" when none set yet). */
  readonly title = input<string>('Chat');
  /** Active project name — when empty, the project pill is hidden. */
  readonly projectName = input<string>('');
  /** Whether the memory panel is currently open (drives aria-pressed). */
  readonly memoryOpen = input<boolean>(false);
  /** Whether the conversations drawer is currently open (drives aria-pressed). */
  readonly historyOpen = input<boolean>(false);

  /** Toggle the memory panel drawer. */
  readonly toggleMemory = output<void>();
  /** Toggle the conversations drawer (hamburger button → ⌘B). */
  readonly toggleHistory = output<void>();
  /** Start a new conversation (plus button → ⌘N). */
  readonly newConversation = output<void>();
  /** Open the project switcher dropdown (project pill click). */
  readonly openProjectSwitcher = output<void>();

  /** First two letters of the project name for the violet monogram square. */
  protected readonly monogram = computed(() => {
    const name = this.projectName().trim();
    if (!name) return '';
    return name.slice(0, 2).toLowerCase();
  });
}
