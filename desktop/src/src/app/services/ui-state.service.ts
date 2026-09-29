import { Injectable, signal, type Signal } from '@angular/core';

/** SSOT for transient UI state shared across shell/chat views (sidebar, memory, palette, project switcher toggles). */
@Injectable({ providedIn: 'root' })
export class UiStateService {
  private readonly sidebarOpenSignal = signal<boolean>(false);
  private readonly memoryOpenSignal = signal<boolean>(false);
  private readonly paletteOpenSignal = signal<boolean>(false);
  private readonly projectSwitcherOpenSignal = signal<boolean>(false);
  private readonly restartRequestedSignal = signal<number>(0);

  /** Read-only signal reflecting the conversations sidebar drawer's open state. */
  readonly sidebarOpen: Signal<boolean> = this.sidebarOpenSignal.asReadonly();

  /** Read-only signal reflecting the memory panel drawer's open state. */
  readonly memoryOpen: Signal<boolean> = this.memoryOpenSignal.asReadonly();

  /** Read-only signal reflecting the command palette modal's open state (⌘K). */
  readonly paletteOpen: Signal<boolean> = this.paletteOpenSignal.asReadonly();

  /** Read-only signal reflecting the project switcher dropdown's open state. */
  readonly projectSwitcherOpen: Signal<boolean> = this.projectSwitcherOpenSignal.asReadonly();

  /**
   * One-shot request channel (shell → chat): a monotonically increasing counter bumped by
   * {@link requestRestart}. `ChatComponent` reacts via an effect that compares against the
   * previously seen value, so the shell (⌘R / Ctrl+R) and the chat header's plus button drive
   * the exact same `newConversation()` path without the shell duplicating its logic.
   */
  readonly restartRequested: Signal<number> = this.restartRequestedSignal.asReadonly();

  /** Flips the conversations sidebar drawer; closes the memory drawer first (shared left-edge anchor). */
  toggleSidebar(): void {
    this.sidebarOpenSignal.update((open) => {
      const next = !open;
      if (next) this.memoryOpenSignal.set(false);
      return next;
    });
  }

  /** Flips the memory panel drawer; closes the conversations drawer first (shared left-edge anchor). */
  toggleMemory(): void {
    this.memoryOpenSignal.update((open) => {
      const next = !open;
      if (next) this.sidebarOpenSignal.set(false);
      return next;
    });
  }

  /** Flips the command palette modal between open and closed. ⌘K binds here. */
  togglePalette(): void {
    this.paletteOpenSignal.update((open) => !open);
  }

  /** Flips the project switcher dropdown between open and closed. */
  toggleProjectSwitcher(): void {
    this.projectSwitcherOpenSignal.update((open) => !open);
  }

  /** Forces the conversations sidebar drawer closed. */
  closeSidebar(): void {
    this.sidebarOpenSignal.set(false);
  }

  /** Forces the memory panel drawer closed. */
  closeMemory(): void {
    this.memoryOpenSignal.set(false);
  }

  /** Forces the command palette modal closed (⎋ binds here for any open overlay). */
  closePalette(): void {
    this.paletteOpenSignal.set(false);
  }

  /** Forces the project switcher dropdown closed. */
  closeProjectSwitcher(): void {
    this.projectSwitcherOpenSignal.set(false);
  }

  /** Bumps {@link restartRequested}, asking the chat view to restart its current conversation. */
  requestRestart(): void {
    this.restartRequestedSignal.update((n) => n + 1);
  }
}
