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

  /** Read-only signal reflecting the conversations sidebar drawer's open state. */
  readonly sidebarOpen: Signal<boolean> = this.sidebarOpenSignal.asReadonly();

  /** Read-only signal reflecting the memory panel drawer's open state. */
  readonly memoryOpen: Signal<boolean> = this.memoryOpenSignal.asReadonly();

  /** Flips the conversations sidebar drawer between open and closed. */
  toggleSidebar(): void {
    this.sidebarOpenSignal.update((open) => !open);
  }

  /** Flips the memory panel drawer between open and closed. */
  toggleMemory(): void {
    this.memoryOpenSignal.update((open) => !open);
  }

  /** Forces the conversations sidebar drawer closed. */
  closeSidebar(): void {
    this.sidebarOpenSignal.set(false);
  }

  /** Forces the memory panel drawer closed. */
  closeMemory(): void {
    this.memoryOpenSignal.set(false);
  }
}
