import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  model,
  output,
  signal,
} from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { CdkListbox, CdkOption, type ListboxValueChangeEvent } from '@angular/cdk/listbox';
import { SlashService, type SlashCommand } from './slash.service';
import { TooltipDirective } from '../../shared/tooltip.directive';

/**
 * Popover listing every slash command Claude Code exposes for the active
 * session. Filters the list by the `query` input using a "startsWith
 * above substring" ranking, and exposes keyboard navigation via CDK
 * Listbox primitives.
 */
@Component({
  selector: 'app-slash-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [A11yModule, CdkListbox, CdkOption, TooltipDirective],
  host: {
    class: 'block',
    '[class.hidden]': '!open()',
  },
  template: `
    <div
      data-testid="slash-menu"
      cdkTrapFocus
      [cdkTrapFocusAutoCapture]="open()"
      tabindex="-1"
      role="dialog"
      aria-label="Slash command menu"
      class="absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-[0_16px_40px_rgba(0,0,0,0.5)] focus:outline-none"
      (keydown.escape)="onEscape($event)"
    >
      <!-- Header: leading slash, query input, match count, close. -->
      <div class="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
        <span class="mono text-[12px] text-[var(--accent)]" aria-hidden="true">/</span>
        <input
          type="text"
          name="slash-query"
          data-testid="slash-menu-query"
          cdkFocusInitial
          class="mono w-full bg-transparent text-[12px] text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none"
          placeholder="search skills &amp; commands..."
          aria-label="Filter slash commands"
          [value]="query()"
          (input)="onQueryInput($event)"
          (keydown)="onSearchKeydown($event)"
        />
        <button
          type="button"
          class="text-[var(--ink-mute)] hover:text-[var(--ink)]"
          data-testid="slash-menu-close"
          aria-label="Close slash menu"
          appTooltip="Close"
          tooltipKbd="esc"
          placement="bottom"
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
          <ul
            cdkListbox
            cdkListboxUseActiveDescendant
            aria-label="Slash commands"
            (cdkListboxValueChange)="onListboxChange($event)"
            class="m-0 list-none p-0"
          >
            @for (group of groups(); track group.key) {
              <li
                class="mono px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                [attr.data-testid]="'slash-menu-group-' + group.key"
                aria-hidden="true"
              >
                {{ group.label }} · {{ group.items.length }}
              </li>
              @for (entry of group.items; track entry.cmd.name) {
                <li
                  [cdkOption]="entry.cmd"
                  [id]="optionId(entry.flatIndex)"
                  [class.is-active]="entry.flatIndex === activeIndex()"
                  data-testid="slash-menu-item"
                  class="hover-bg flex w-full cursor-pointer items-start gap-3 border-l-2 border-transparent px-3 py-1.5 text-left [&.is-active]:border-[var(--accent)] [&.is-active]:bg-[var(--bg-2)]"
                  (mouseenter)="activeIndex.set(entry.flatIndex)"
                >
                  <span
                    class="mono text-[11px] text-[var(--ink-mute)] [.is-active_&]:text-[var(--accent)]"
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
                </li>
              }
            }
          </ul>
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
  /** Current filter query (the text after `/` in the composer). Two-way bindable. */
  readonly query = model('');
  /** Whether the popover is visible. Two-way bindable. */
  readonly open = model(false);

  /** Fires when the user picks a command (Enter or click). */
  readonly selected = output<SlashCommand>();
  /** Fires when the user dismisses the popover (Escape). */
  readonly closed = output<void>();

  readonly service = inject(SlashService);

  /** Index of the highlighted entry inside `filtered()`. Reset whenever the query changes. */
  protected readonly activeIndex = signal(0);

  /**
   * Sets up an effect that resets the highlighted index whenever the query
   * changes — ensures the first match is always pre-selected so Enter/Tab
   * pick the most relevant entry.
   */
  constructor() {
    effect(() => {
      this.query();
      this.activeIndex.set(0);
    });
  }

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
   * Selects a specific command (via click or keyboard).
   * @param cmd - The command chosen by the user.
   */
  select(cmd: SlashCommand): void {
    this.selected.emit(cmd);
  }

  /**
   * Search input handler — keeps the `query` model in sync with the field.
   * @param event - Native input event.
   */
  onQueryInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.query.set(target.value);
  }

  /**
   * Keyboard navigation while the search input has focus. Drives the
   * highlighted index without giving up focus, then commits a selection on
   * Enter/Tab.
   * @param event - Native keyboard event.
   */
  onSearchKeydown(event: KeyboardEvent): void {
    const list = this.filtered();
    if (list.length === 0) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.activeIndex.update((i) => (i + 1) % list.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.activeIndex.update((i) => (i - 1 + list.length) % list.length);
        break;
      case 'Home':
        event.preventDefault();
        this.activeIndex.set(0);
        break;
      case 'End':
        event.preventDefault();
        this.activeIndex.set(list.length - 1);
        break;
      case 'Enter':
      case 'Tab': {
        event.preventDefault();
        const picked = list[Math.min(this.activeIndex(), list.length - 1)];
        if (picked) this.select(picked);
        break;
      }
    }
  }

  /**
   * CdkListbox change handler — emits the picked command when the user
   * activates an option via space/click.
   * @param event - CDK listbox value-change payload (single-select).
   */
  onListboxChange(event: ListboxValueChangeEvent<unknown>): void {
    const value = event.value[0];
    if (value) this.select(value as SlashCommand);
  }

  /**
   * Escape-key handler — emits `closed` so the parent can hide us.
   * @param event - DOM event from the keydown.
   */
  onEscape(event: Event): void {
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
