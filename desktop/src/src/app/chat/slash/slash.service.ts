import { Injectable, computed, inject, signal } from '@angular/core';
import { TauriService } from '../../services/tauri.service';

/** Classification of a slash-menu entry, used by the UI to render the badge. */
export type SlashKind = 'Builtin' | 'Skill' | 'Command' | 'Plugin' | 'Agent';

/** Indicates whether the discovery came from Claude Code or the fallback. */
export type DiscoverySource = 'Init' | 'Fallback';

/** One entry in the slash popover, mirrored from Rust `SlashCommand`. */
export interface SlashCommand {
  readonly name: string;
  readonly description: string | null;
  readonly argument_hint: string | null;
  readonly kind: SlashKind;
  readonly plugin: string | null;
}

/** Full discovery result, mirrored from Rust `SlashDiscovery`. */
export interface SlashDiscovery {
  readonly commands: readonly SlashCommand[];
  readonly source: DiscoverySource;
}

/**
 * Bridges the slash-menu UI with the Tauri backend.
 *
 * Keeps the discovery result in signals so the menu component can re-render
 * automatically. Never throws — failures degrade to an empty list with
 * `source = null` so the UI can show a subtle error state without losing
 * any already-loaded commands.
 */
@Injectable({ providedIn: 'root' })
export class SlashService {
  private readonly tauri = inject(TauriService);

  /** Last discovered list of commands (empty until refresh resolves). */
  readonly commands = signal<readonly SlashCommand[]>([]);
  /** True while a discovery call is in-flight. */
  readonly discovering = signal<boolean>(false);
  /** Source of the last successful discovery; `null` on error. */
  readonly source = signal<DiscoverySource | null>(null);
  /** Error message from the last failed discovery, if any. */
  readonly error = signal<string | null>(null);

  /** Convenience computed: is the popover "empty and loading"? */
  readonly isLoadingEmpty = computed(() => this.discovering() && this.commands().length === 0);

  /**
   * Fetches the slash-command list for the given project and updates the
   * signals. Resolves on both success and failure; errors are surfaced
   * via `this.error` / `this.source` without throwing.
   * @param projectId - Project name used by Tauri to find the container.
   */
  async refresh(projectId: string): Promise<void> {
    if (!projectId) {
      this.commands.set([]);
      this.source.set(null);
      this.error.set(null);
      return;
    }
    this.discovering.set(true);
    this.error.set(null);
    try {
      const result = await this.tauri.invoke<SlashDiscovery>('list_slash_commands', {
        projectId,
      });
      this.commands.set(result.commands);
      this.source.set(result.source);
    } catch (err) {
      this.source.set(null);
      this.error.set(String(err));
    } finally {
      this.discovering.set(false);
    }
  }

  /**
   * Invalidates the backend cache for a project. Call after installing or
   * removing a plugin so the next `refresh` returns the new list.
   * @param projectId - Project name whose cache to invalidate.
   */
  async invalidate(projectId: string): Promise<void> {
    if (!projectId) return;
    try {
      await this.tauri.invoke('invalidate_slash_cache', { projectId });
    } catch (err) {
      // Invalidation errors are not user-actionable; log via the logging
      // facade for diagnostics.
      console.warn('[SlashService] invalidate_slash_cache failed:', err);
    }
  }
}
