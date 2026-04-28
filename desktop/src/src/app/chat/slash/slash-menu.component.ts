import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { SlashService, type SlashCommand } from './slash.service';

/**
 * Popover listing every slash command Claude Code exposes for the active
 * session. Filters the list by the `query` input using a "startsWith
 * above substring" ranking, and exposes keyboard navigation via host
 * bindings.
 */
@Component({
  selector: 'app-slash-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    '[class.hidden]': '!open()',
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
      class="absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
    >
      <!-- Header: leading slash, query input, match count, close. -->
      <div class="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
        <span class="mono text-[12px] text-[var(--accent)]" aria-hidden="true">/</span>
        <input
          type="search"
          name="slash-query"
          data-testid="slash-menu-query"
          class="mono w-full bg-transparent text-[12px] text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none"
          placeholder="search skills &amp; commands..."
          aria-label="Filter slash commands"
          [value]="query()"
        />
        <button
          type="button"
          class="text-[var(--ink-mute)] hover:text-[var(--ink)]"
          data-testid="slash-menu-close"
          aria-label="Close slash menu"
          title="Close (esc)"
          (click)="closed.emit()"
        >
          ×
        </button>
      </div>

      <!-- Body: grouped list, status states. -->
      <div class="max-h-72 overflow-y-auto py-1">
        @if (service.isLoadingEmpty()) {
          <div
            data-testid="slash-menu-loading"
            class="mono px-3 py-2 text-[11px] text-[var(--ink-mute)]"
            role="status"
            aria-live="polite"
          >
            discovering…
          </div>
        } @else if (filtered().length === 0) {
          <div
            data-testid="slash-menu-empty"
            class="mono px-3 py-2 text-[11px] text-[var(--ink-mute)]"
          >
            no matches
          </div>
        } @else {
          @for (group of groups(); track group.key) {
            <div
              class="mono px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
              [attr.data-testid]="'slash-menu-group-' + group.key"
            >
              {{ group.label }} · {{ group.items.length }}
            </div>
            @for (entry of group.items; track entry.cmd.name) {
              <button
                type="button"
                role="option"
                tabindex="-1"
                [id]="optionId(entry.flatIndex)"
                [attr.aria-selected]="entry.flatIndex === highlighted()"
                data-testid="slash-menu-item"
                class="flex w-full items-start gap-3 border-l-2 px-3 py-1.5 text-left"
                [class]="
                  entry.flatIndex === highlighted()
                    ? 'border-[var(--accent)] bg-[var(--bg-2)]'
                    : 'border-transparent hover-bg'
                "
                (mouseenter)="highlighted.set(entry.flatIndex)"
                (click)="select(entry.cmd)"
              >
                <span
                  class="mono text-[11px]"
                  [class]="
                    entry.flatIndex === highlighted()
                      ? 'text-[var(--accent)]'
                      : 'text-[var(--ink-mute)]'
                  "
                  aria-hidden="true"
                  >/</span
                >
                <div class="min-w-0 flex-1">
                  <div class="mono flex items-center gap-2 text-[12px] text-[var(--ink)]">
                    @if (entry.cmd.plugin) {
                      <span class="text-[var(--violet)]">{{ entry.cmd.plugin }}:</span>
                    }
                    {{ entry.cmd.name }}
                    <span
                      data-testid="slash-menu-badge"
                      class="pill"
                      [class.teal]="entry.cmd.kind === 'Skill'"
                      [class.violet]="entry.cmd.kind === 'Plugin'"
                      [class.amber]="entry.cmd.kind === 'Agent'"
                      >{{ badgeText(entry.cmd) }}</span
                    >
                    @if (entry.cmd.argument_hint) {
                      <span class="mono text-[10px] text-[var(--ink-mute)]">{{
                        entry.cmd.argument_hint
                      }}</span>
                    }
                  </div>
                  @if (entry.cmd.description) {
                    <div class="mt-0.5 text-[11.5px] text-[var(--ink-dim)]">
                      {{ entry.cmd.description }}
                    </div>
                  }
                </div>
              </button>
            }
          }
        }
      </div>

      <!-- Footer: keybind hints + offline-fallback indicator. -->
      <div
        class="mono flex items-center gap-4 border-t border-[var(--line)] px-3 py-1.5 text-[10px] text-[var(--ink-mute)]"
      >
        <span><span class="kbd">↑↓</span> navigate</span>
        <span><span class="kbd">↵</span> select</span>
        <span><span class="kbd">tab</span> complete</span>
        @if (service.source() === 'Fallback') {
          <span class="text-[var(--amber)]" data-testid="slash-menu-fallback"
            >offline · built-in commands</span
          >
        }
        <span class="ml-auto"><span class="kbd">esc</span> close</span>
      </div>
    </div>
  `,
})
export class SlashMenuComponent {
  /** Current filter query (the text after `/` in the composer). */
  readonly query = input('');
  /** Whether the popover is visible. Host binding hides the element when false. */
  readonly open = input(false);

  /** Fires when the user picks a command (Enter or click). */
  readonly selected = output<SlashCommand>();
  /** Fires when the user dismisses the popover (Escape). */
  readonly closed = output<void>();

  readonly service = inject(SlashService);
  readonly highlighted = signal(0);

  /**
   * Commands filtered by the current query, with startsWith ranked above
   * substring matches.
   *
   * Subagents (`kind === 'Agent'`) are dropped here: Claude Code does not
   * expose them as slash commands — they can only be invoked from inside an
   * Agent tool call. Surfacing them in the slash menu lets the user pick a
   * "/Plan" entry that the model then rejects with `Unknown skill: Plan`.
   */
  readonly filtered = computed<readonly SlashCommand[]>(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.service.commands().filter((c) => c.kind !== 'Agent');
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

  readonly activeDescendantId = computed(() => {
    const list = this.filtered();
    if (list.length === 0) return null;
    const idx = Math.min(this.highlighted(), list.length - 1);
    return this.optionId(idx);
  });

  /**
   * Buckets the filtered list into the mockup's three groups: skills, slash
   * commands, and plugin commands. The flat-index is preserved on every
   * entry so keyboard navigation (which addresses items by their position in
   * `filtered()`) and group rendering stay in sync.
   */
  readonly groups = computed<readonly SlashGroup[]>(() => {
    const list = this.filtered();
    const skills: GroupEntry[] = [];
    const commands: GroupEntry[] = [];
    const plugins: GroupEntry[] = [];
    list.forEach((cmd, i) => {
      const entry: GroupEntry = { cmd, flatIndex: i };
      if (cmd.plugin) plugins.push(entry);
      else if (cmd.kind === 'Skill') skills.push(entry);
      else commands.push(entry);
    });
    const out: SlashGroup[] = [];
    if (skills.length > 0) out.push({ key: 'skills', label: 'skills', items: skills });
    if (commands.length > 0)
      out.push({ key: 'commands', label: 'slash commands', items: commands });
    if (plugins.length > 0) out.push({ key: 'plugins', label: 'from plugins', items: plugins });
    return out;
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
   * @param event - The DOM event to consume; Angular's `host` metadata types
   *   the listener as `Event`, so we accept the wider type and consume it.
   */
  handleArrowDown(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    const len = this.filtered().length;
    if (len === 0) return;
    this.highlighted.update((i) => (i + 1) % len);
  }

  /**
   * Arrow-up handler — moves the highlight up with wrap-around.
   * @param event - DOM event from the document keydown.
   */
  handleArrowUp(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    const len = this.filtered().length;
    if (len === 0) return;
    this.highlighted.update((i) => (i - 1 + len) % len);
  }

  /**
   * Home-key handler — jumps to the first item.
   * @param event - DOM event from the document keydown.
   */
  handleHome(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.highlighted.set(0);
  }

  /**
   * End-key handler — jumps to the last item.
   * @param event - DOM event from the document keydown.
   */
  handleEnd(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    const len = this.filtered().length;
    if (len === 0) return;
    this.highlighted.set(len - 1);
  }

  /**
   * Enter-key handler — emits `selected` with the highlighted command.
   * @param event - DOM event from the document keydown.
   */
  handleEnter(event: Event): void {
    if (!this.open()) return;
    if (this.filtered().length === 0) return;
    event.preventDefault();
    this.selectHighlighted();
  }

  /**
   * Escape-key handler — emits `closed` so the parent can hide us.
   * @param event - DOM event from the document keydown.
   */
  handleEscape(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.closed.emit();
  }
}

/** One entry inside a slash-menu group, carrying the position in `filtered()`. */
interface GroupEntry {
  cmd: SlashCommand;
  flatIndex: number;
}

/** A rendered group: kebab key, mono uppercase label, and member entries. */
interface SlashGroup {
  key: string;
  label: string;
  items: readonly GroupEntry[];
}
