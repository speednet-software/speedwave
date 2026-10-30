import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';

import { ChatStateService } from './chat-state.service';
import { WindowFocusService } from './window-focus.service';

const REVEAL_MS = 150;

/**
 * State of the Ctrl+Tab chat tab switcher: `ShellComponent` feeds it the keys and
 * `ChatTabSwitcherComponent` renders it.
 */
@Injectable({ providedIn: 'root' })
export class TabSwitcherService {
  private readonly chat = inject(ChatStateService);
  private readonly windowFocus = inject(WindowFocusService);
  private readonly entriesSignal = signal<readonly string[]>([]);
  private readonly highlightedSignal = signal(0);
  private readonly visibleSignal = signal(false);
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private startedOn = '';

  /** Tab ids in switcher order, the most recently active first; empty while no switch runs. */
  readonly entries: Signal<readonly string[]> = this.entriesSignal.asReadonly();
  /** Index into {@link entries} of the highlighted tab. */
  readonly highlighted: Signal<number> = this.highlightedSignal.asReadonly();
  /** Whether the popup shows: Ctrl stayed held past the reveal delay, or Tab was pressed again. */
  readonly visible: Signal<boolean> = this.visibleSignal.asReadonly();
  /** Whether a switch runs: Ctrl+Tab was pressed and Ctrl is not released yet. */
  readonly active: Signal<boolean> = computed(() => this.entriesSignal().length > 0);

  /** Cancels a running switch once the window loses focus or another tab becomes active. */
  constructor() {
    effect(() => {
      if (!this.active()) return;
      if (!this.windowFocus.focused() || this.chat.activeTabId() !== this.startedOn) {
        untracked(() => this.cancel());
      }
    });
  }

  /**
   * Starts a switch on the first Ctrl+Tab, highlighting the previous tab; every later Tab moves the
   * highlight, wrapping around at both ends.
   * @param direction - 1 for Tab (down), -1 for Shift+Tab (up).
   * @returns False when fewer than two tabs are open, so there is nothing to switch to.
   */
  step(direction: 1 | -1): boolean {
    if (this.active()) {
      this.visibleSignal.set(true);
    } else {
      const ids = this.chat.tabsByRecentUse();
      if (ids.length < 2) return false;
      this.startedOn = this.chat.activeTabId();
      this.entriesSignal.set(ids);
      this.revealTimer = setTimeout(() => {
        this.revealTimer = null;
        this.visibleSignal.set(true);
      }, REVEAL_MS);
    }
    const count = this.entriesSignal().length;
    this.highlightedSignal.update((i) => (i + direction + count) % count);
    return true;
  }

  /**
   * Switches to an entry and closes the switcher: on Ctrl's release, or when a row is pressed.
   * @param index - Index into {@link entries}; the highlighted entry by default.
   */
  commit(index = this.highlightedSignal()): void {
    const id = this.entriesSignal()[index];
    this.reset();
    if (id !== undefined) this.chat.activateTab(id);
  }

  /** Closes the switcher without switching: Esc, a press outside it, a lost window focus, or another tab activated meanwhile. */
  cancel(): void {
    this.reset();
  }

  private reset(): void {
    if (this.revealTimer !== null) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    this.entriesSignal.set([]);
    this.highlightedSignal.set(0);
    this.visibleSignal.set(false);
  }
}
