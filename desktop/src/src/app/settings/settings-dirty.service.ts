import { Injectable, Signal, computed, signal } from '@angular/core';

/** The user's pick in the unsaved-changes modal. */
export type UnsavedChangesChoice = 'save' | 'discard' | 'stay';

/** What a Save-gated Settings section exposes so the leave guard can see and save its edits. */
export interface DirtySectionHandle {
  readonly name: string;
  readonly isDirty: Signal<boolean>;
  save(): Promise<void>;
}

/** Registry of dirty Settings sections + broker for the leave-confirmation prompt (SPEED-637). */
@Injectable({ providedIn: 'root' })
export class SettingsDirtyService {
  private readonly handles = signal<readonly DirtySectionHandle[]>([]);
  private readonly pendingResolve = signal<((choice: UnsavedChangesChoice) => void) | null>(null);
  private suppressOnce = false;

  /** Registered sections whose isDirty currently reports true. */
  readonly dirtySections = computed(() => this.handles().filter((h) => h.isDirty()));
  /** True while at least one registered section is dirty. */
  readonly hasDirty = computed(() => this.dirtySections().length > 0);
  /** Display names of the dirty sections, for the modal body. */
  readonly dirtySectionNames = computed(() => this.dirtySections().map((h) => h.name));
  /** True while a leave prompt is awaiting the user's choice. */
  readonly promptOpen = computed(() => this.pendingResolve() !== null);

  /**
   * Adds a section to the registry.
   * @param handle - the section's dirty state and save entry point.
   * @returns an unregister function for the section's destroy hook.
   */
  register(handle: DirtySectionHandle): () => void {
    this.handles.set([...this.handles(), handle]);
    return () => this.handles.set(this.handles().filter((h) => h !== handle));
  }

  /** Opens the leave prompt; a newer navigation's call supersedes the previous one, which resolves 'stay'. */
  confirmLeave(): Promise<UnsavedChangesChoice> {
    this.pendingResolve()?.('stay');
    return new Promise((resolve) => this.pendingResolve.set(resolve));
  }

  /**
   * Closes the prompt with the user's choice; a no-op when no prompt is open.
   * @param choice - the button the user picked.
   */
  resolvePrompt(choice: UnsavedChangesChoice): void {
    const resolve = this.pendingResolve();
    if (resolve === null) return;
    this.pendingResolve.set(null);
    resolve(choice);
  }

  /**
   * Saves every dirty section sequentially.
   * @returns true when nothing is dirty afterwards (every save succeeded).
   */
  async saveDirtySections(): Promise<boolean> {
    for (const handle of this.dirtySections()) {
      try {
        await handle.save();
      } catch {
        return false;
      }
    }
    return !this.hasDirty();
  }

  /** Arms a one-shot bypass of the leave prompt (used by factory reset). */
  suppressNextPrompt(): void {
    this.suppressOnce = true;
  }

  /** Consumes the one-shot bypass flag. */
  consumeSuppression(): boolean {
    const suppressed = this.suppressOnce;
    this.suppressOnce = false;
    return suppressed;
  }
}
