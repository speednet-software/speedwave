import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * Minimal terminal-style chat header bar.
 *
 * Renders the conversation title, an optional project pill, and toggle buttons
 * for the memory and history panels. Purely presentational — all state lives in
 * the parent component and is wired through the inputs/outputs.
 *
 * NOTE: uses decorator-based `@Input`/`@Output` to match the current codebase
 * convention (tests run via raw vitest without the Angular compiler plugin,
 * which is required to wire up signal-based `input()`/`output()`). A future
 * codebase-wide migration to signals will flip this over — the public API
 * (template binding names) stays identical.
 */
@Component({
  selector: 'app-chat-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      data-testid="chat-header"
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line,#16213e)] bg-[var(--bg-1,#12122a)] px-4"
    >
      <h1 data-testid="chat-header-title" class="truncate text-[14px] text-[var(--ink,#e0e0e0)]">
        {{ title }}
      </h1>

      @if (projectName) {
        <span
          data-testid="chat-header-project"
          class="mono rounded bg-[var(--bg-1,#12122a)] px-2 py-0.5 text-[11px] text-[var(--teal,#4ecdc4)] ring-1 ring-[var(--line,#16213e)]"
        >
          {{ projectName }}
        </span>
      }

      <div class="ml-auto flex flex-shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="chat-header-memory"
          class="mono rounded px-2 py-1 text-[11px] text-[var(--ink-mute,#888888)] hover:text-[var(--ink,#e0e0e0)]"
          [class.!text-[var(--accent,#e94560)]]="memoryOpen"
          [attr.aria-pressed]="memoryOpen"
          aria-label="Toggle project memory panel"
          (click)="toggleMemory.emit()"
        >
          memory
        </button>
        <button
          type="button"
          data-testid="chat-header-history"
          class="mono rounded px-2 py-1 text-[11px] text-[var(--ink-mute,#888888)] hover:text-[var(--ink,#e0e0e0)]"
          [class.!text-[var(--accent,#e94560)]]="historyOpen"
          [attr.aria-pressed]="historyOpen"
          aria-label="Toggle conversation history panel"
          (click)="toggleHistory.emit()"
        >
          history
        </button>
      </div>
    </div>
  `,
})
export class ChatHeaderComponent {
  @Input() title = 'Chat';
  @Input() projectName = '';
  @Input() memoryOpen = false;
  @Input() historyOpen = false;

  @Output() toggleMemory = new EventEmitter<void>();
  @Output() toggleHistory = new EventEmitter<void>();
}
