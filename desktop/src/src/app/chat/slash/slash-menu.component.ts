import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { SlashService, type SlashCommand } from './slash.service';

/**
 * Popover listing every slash command Claude Code exposes for the active
 * session. Filters the list by the `query` input using a "startsWith
 * above substring" ranking, and exposes keyboard navigation via host
 * bindings.
 *
 * Uses legacy `\@Input` / `\@Output` decorators to stay compatible with the
 * project's current vitest-based test harness, which does not run the
 * Angular compiler and therefore cannot resolve `input()`/`output()`
 * signal metadata at test time. Migrate to signal inputs once the
 * harness adds an Angular-compiler vitest plugin.
 */
@Component({
  selector: 'app-slash-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    '[class.hidden]': '!open',
    '(document:keydown.arrowdown)': 'handleArrowDown($event)',
    '(document:keydown.arrowup)': 'handleArrowUp($event)',
    '(document:keydown.home)': 'handleHome($event)',
    '(document:keydown.end)': 'handleEnd($event)',
    '(document:keydown.enter)': 'handleEnter($event)',
    '(document:keydown.escape)': 'handleEscape($event)',
  },
  template: `
    <div
      data-testid="slash-menu"
      role="listbox"
      aria-label="Slash commands"
      [attr.aria-activedescendant]="activeDescendantId()"
      class="absolute bottom-full left-0 mb-2 w-[360px] max-h-[280px] overflow-y-auto ring-1 rounded shadow-lg z-20"
      [style.background]="'var(--bg-1, #1a1a1a)'"
      [style.--tw-ring-color]="'var(--line-strong, #2a2a2a)'"
    >
      @if (service.isLoadingEmpty()) {
        <div
          data-testid="slash-menu-loading"
          class="px-3 py-2 text-[11px] mono"
          [style.color]="'var(--ink-mute, #888)'"
          role="status"
          aria-live="polite"
        >
          discovering…
        </div>
      } @else if (filtered().length === 0) {
        <div
          data-testid="slash-menu-empty"
          class="px-3 py-2 text-[11px] mono"
          [style.color]="'var(--ink-mute, #888)'"
        >
          no matches
        </div>
      } @else {
        <ul>
          @for (cmd of filtered(); let i = $index; track cmd.name) {
            <li
              [id]="optionId(i)"
              role="option"
              tabindex="-1"
              [attr.aria-selected]="i === highlighted()"
              data-testid="slash-menu-item"
              class="px-3 py-2 cursor-pointer flex items-center gap-2 mono text-[12px]"
              [style.background]="i === highlighted() ? 'var(--bg-2, #222)' : 'transparent'"
              (mouseenter)="highlighted.set(i)"
              (click)="select(cmd)"
              (keydown.enter)="select(cmd)"
              (keydown.space)="select(cmd)"
            >
              <span class="font-medium" [style.color]="'var(--accent, #e11d48)'"
                >/{{ cmd.name }}</span
              >
              @if (cmd.argument_hint) {
                <span class="text-[11px]" [style.color]="'var(--ink-mute, #888)'">{{
                  cmd.argument_hint
                }}</span>
              }
              <span class="flex-1 truncate text-[11px]" [style.color]="'var(--ink-dim, #aaa)'">{{
                cmd.description || ''
              }}</span>
              <span
                data-testid="slash-menu-badge"
                class="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-widest"
                [style.background]="badgeBackground(cmd)"
                [style.color]="badgeForeground(cmd)"
                >{{ badgeText(cmd) }}</span
              >
            </li>
          }
        </ul>
      }
      @if (service.source() === 'Fallback') {
        <div
          data-testid="slash-menu-fallback"
          class="px-3 py-1.5 text-[10px] border-t mono"
          [style.color]="'var(--ink-mute, #888)'"
          [style.border-color]="'var(--line, #2a2a2a)'"
        >
          offline · showing built-in commands
        </div>
      }
    </div>
  `,
})
export class SlashMenuComponent implements OnChanges {
  /** Current filter query (the text after `/` in the composer). */
  @Input() query = '';
  /** Whether the popover is visible. Host binding hides the element when false. */
  @Input() open = false;

  /** Fires when the user picks a command (Enter or click). */
  @Output() readonly selected = new EventEmitter<SlashCommand>();
  /** Fires when the user dismisses the popover (Escape). */
  @Output() readonly closed = new EventEmitter<void>();

  readonly service = inject(SlashService);
  readonly highlighted = signal(0);

  /** Commands filtered by the current query, with startsWith ranked above substring. */
  readonly filtered = computed<readonly SlashCommand[]>(() => {
    const q = this.queryForCompute().trim().toLowerCase();
    const all = this.service.commands();
    if (!q) {
      return [...all];
    }

    const starts: SlashCommand[] = [];
    const contains: SlashCommand[] = [];
    for (const cmd of all) {
      const name = cmd.name.toLowerCase();
      const desc = (cmd.description ?? '').toLowerCase();
      if (name.startsWith(q)) {
        starts.push(cmd);
      } else if (name.includes(q) || desc.includes(q)) {
        contains.push(cmd);
      }
    }
    return [...starts, ...contains];
  });

  /** Writable copy so `computed` can track query changes when parent calls setInput. */
  private readonly queryForCompute = signal<string>('');

  /** Sync the signal when the @Input is set from outside. */
  ngOnChanges(): void {
    this.queryForCompute.set(this.query);
  }

  readonly activeDescendantId = computed(() => {
    const list = this.filtered();
    if (list.length === 0) return null;
    const idx = Math.min(this.highlighted(), list.length - 1);
    return this.optionId(idx);
  });

  /**
   * DOM id for the option at `index`, used by `aria-activedescendant`.
   * @param index - Zero-based index into `filtered()`.
   */
  optionId(index: number): string {
    return `slash-menu-option-${index}`;
  }

  /**
   * Returns the short label for the command's kind badge.
   * @param cmd - The slash command to label.
   */
  badgeText(cmd: SlashCommand): string {
    switch (cmd.kind) {
      case 'Builtin':
        return 'built-in';
      case 'Skill':
        return 'skill';
      case 'Command':
        return 'cmd';
      case 'Plugin':
        return cmd.plugin ? `plugin:${cmd.plugin}` : 'plugin';
      case 'Agent':
        return 'agent';
    }
  }

  /**
   * Background colour for a kind badge, using semantic CSS variables.
   * @param cmd - The slash command being rendered.
   */
  badgeBackground(cmd: SlashCommand): string {
    switch (cmd.kind) {
      case 'Builtin':
        return 'var(--green, #22c55e)';
      case 'Skill':
        return 'var(--teal, #14b8a6)';
      case 'Plugin':
        return 'var(--violet, #8b5cf6)';
      case 'Agent':
        return 'var(--amber, #f59e0b)';
      case 'Command':
        return 'var(--bg-3, #2a2a2a)';
    }
  }

  /**
   * Foreground colour for a kind badge.
   * @param cmd - The slash command being rendered.
   */
  badgeForeground(cmd: SlashCommand): string {
    return cmd.kind === 'Command' ? 'var(--ink-dim, #aaa)' : 'var(--on-accent, #fff)';
  }

  /** Selects the currently highlighted item. */
  selectHighlighted(): void {
    const list = this.filtered();
    if (list.length === 0) return;
    const idx = Math.min(this.highlighted(), list.length - 1);
    this.select(list[idx]);
  }

  /**
   * Selects a specific command (via click or keyboard).
   * @param cmd - The command chosen by the user.
   */
  select(cmd: SlashCommand): void {
    this.selected.emit(cmd);
  }

  /**
   * Arrow-down handler — advances the highlighted index with wrap-around.
   * @param event - The key event to consume.
   */
  handleArrowDown(event: KeyboardEvent): void {
    if (!this.open) return;
    event.preventDefault();
    const len = this.filtered().length;
    if (len === 0) return;
    this.highlighted.update((i) => (i + 1) % len);
  }

  /**
   * Arrow-up handler — moves the highlight up with wrap-around.
   * @param event - The key event to consume.
   */
  handleArrowUp(event: KeyboardEvent): void {
    if (!this.open) return;
    event.preventDefault();
    const len = this.filtered().length;
    if (len === 0) return;
    this.highlighted.update((i) => (i - 1 + len) % len);
  }

  /**
   * Home-key handler — jumps to the first item.
   * @param event - The key event to consume.
   */
  handleHome(event: KeyboardEvent): void {
    if (!this.open) return;
    event.preventDefault();
    this.highlighted.set(0);
  }

  /**
   * End-key handler — jumps to the last item.
   * @param event - The key event to consume.
   */
  handleEnd(event: KeyboardEvent): void {
    if (!this.open) return;
    event.preventDefault();
    const len = this.filtered().length;
    if (len === 0) return;
    this.highlighted.set(len - 1);
  }

  /**
   * Enter-key handler — emits `selected` with the highlighted command.
   * @param event - The key event to consume.
   */
  handleEnter(event: KeyboardEvent): void {
    if (!this.open) return;
    if (this.filtered().length === 0) return;
    event.preventDefault();
    this.selectHighlighted();
  }

  /**
   * Escape-key handler — emits `closed` so the parent can hide us.
   * @param event - The key event to consume.
   */
  handleEscape(event: KeyboardEvent): void {
    if (!this.open) return;
    event.preventDefault();
    this.closed.emit();
  }
}
