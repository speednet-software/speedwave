import { Injectable, signal, type Signal } from '@angular/core';

/**
 * SSOT for transient UI state shared across shell/chat views.
 *
 * Holds view-state signals that span components (conversations sidebar, memory
 * panel). Per terminal-minimal implementation prompt (Signals architecture):
 * view toggles live in a dedicated UI-state service with `providedIn: 'root'`.
 *
 * Consumers:
 * - `ShellComponent` binds the ⌘B / Ctrl+B keyboard shortcut to `toggleSidebar()`.
 * - `ChatComponent` renders `<app-memory-panel>` and `<app-conversations-sidebar>`
 *   driven by `memoryOpen()` / `sidebarOpen()`.
 */
@Injectable({ providedIn: 'root' })
export class UiStateService {
  private readonly sidebarOpenSignal = signal<boolean>(false);
  private readonly memoryOpenSignal = signal<boolean>(false);
  private readonly paletteOpenSignal = signal<boolean>(false);
  private readonly projectSwitcherOpenSignal = signal<boolean>(false);

  /** Read-only signal reflecting the conversations sidebar drawer's open state. */
  readonly sidebarOpen: Signal<boolean> = this.sidebarOpenSignal.asReadonly();

  /** Read-only signal reflecting the memory panel drawer's open state. */
  readonly memoryOpen: Signal<boolean> = this.memoryOpenSignal.asReadonly();

  /** Read-only signal reflecting the command palette modal's open state (⌘K). */
  readonly paletteOpen: Signal<boolean> = this.paletteOpenSignal.asReadonly();

  /** Read-only signal reflecting the project switcher dropdown's open state. */
  readonly projectSwitcherOpen: Signal<boolean> = this.projectSwitcherOpenSignal.asReadonly();

  /**
   * Flips the conversations sidebar drawer between open and closed.
   * Closes the memory drawer first — both share the left-edge anchor and
   * cannot be open simultaneously without overlapping.
   */
  toggleSidebar(): void {
    this.sidebarOpenSignal.update((open) => {
      const next = !open;
      if (next) this.memoryOpenSignal.set(false);
      return next;
    });
  }

  /**
   * Flips the memory panel drawer between open and closed.
   * Closes the conversations drawer first — both share the left-edge anchor.
   */
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
}
