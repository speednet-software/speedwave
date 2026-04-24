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

  /** Whether the conversations sidebar drawer is open. */
  readonly sidebarOpen: Signal<boolean> = this.sidebarOpenSignal.asReadonly();

  /** Whether the memory panel drawer is open. */
  readonly memoryOpen: Signal<boolean> = this.memoryOpenSignal.asReadonly();

  /** Toggles the conversations sidebar drawer. */
  toggleSidebar(): void {
    this.sidebarOpenSignal.update((open) => !open);
  }

  /** Toggles the memory panel drawer. */
  toggleMemory(): void {
    this.memoryOpenSignal.update((open) => !open);
  }

  /** Closes the conversations sidebar drawer. */
  closeSidebar(): void {
    this.sidebarOpenSignal.set(false);
  }

  /** Closes the memory panel drawer. */
  closeMemory(): void {
    this.memoryOpenSignal.set(false);
  }
}
