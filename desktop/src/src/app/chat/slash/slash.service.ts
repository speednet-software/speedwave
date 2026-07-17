import { Injectable, computed, inject, signal } from '@angular/core';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';

/**
 * True when `text` trimmed is `/` (slash-menu trigger). Mirrors Rust SSOT `speedwave_runtime::slash::is_bare_slash`.
 * @param text - Raw composer text to test.
 */
export function isBareSlash(text: string): boolean {
  return text.trim() === '/';
}

/**
 * True when `text` is blank or is the bare slash-menu trigger. Mirrors Rust SSOT
 * `chat.rs::is_blank_or_slash_only` (Rust side operates on wire blocks, not raw text).
 * @param text - Raw composer text to test.
 */
export function isBlankOrSlashOnly(text: string): boolean {
  return text.trim().length === 0 || isBareSlash(text);
}

const CONTROL_COMMAND_RE = /^\/(model|effort)\s+(\S+)$/;

/**
 * True when `text` is a `/model <id>` or `/effort <level>` control command.
 * Mirrors Rust SSOT `speedwave_runtime::slash::parse_control_command`.
 * @param text - Raw composer text to test.
 */
export function isControlShaped(text: string): boolean {
  return CONTROL_COMMAND_RE.test(text.trim());
}

/** Classification of a slash-menu entry, used by the UI to render the badge. */
export type SlashKind = 'Builtin' | 'Skill' | 'Command' | 'Plugin' | 'Agent';

/** Indicates whether the discovery came from Claude Code or could not run. */
export type DiscoverySource = 'Init' | 'Unavailable';

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
 * Bridges the slash-menu UI with the Tauri backend, holding discovery in signals.
 * Never throws — failures degrade to an empty list with `source = null`.
 */
@Injectable({ providedIn: 'root' })
export class SlashService {
  private readonly tauri = inject(TauriService);
  private readonly log = inject(LoggerService);

  /** Last discovered list of commands (empty until refresh resolves). */
  readonly commands = signal<readonly SlashCommand[]>([]);
  /** True while a discovery call is in-flight. */
  readonly discovering = signal<boolean>(false);
  /** Source of the last successful discovery; `null` on error. */
  readonly source = signal<DiscoverySource | null>(null);
  /** Error message from the last failed discovery, if any. */
  readonly error = signal<string | null>(null);
  /** True when the last discovery reported `source: 'Unavailable'`. */
  readonly unavailable = signal<boolean>(false);

  /** Convenience computed: is the popover "empty and loading"? */
  readonly isLoadingEmpty = computed(() => this.discovering() && this.commands().length === 0);

  /** Promise of the in-flight `refresh()` call, if any (TS-side single-flight guard). */
  private inFlight: Promise<void> | null = null;

  /**
   * Fetches the slash-command list and updates the signals; never throws.
   * A concurrent call while one is already in flight is a no-op that awaits the same result.
   * @param projectId - Project name used by Tauri to find the container.
   */
  async refresh(projectId: string): Promise<void> {
    if (!projectId) {
      this.commands.set([]);
      this.source.set(null);
      this.error.set(null);
      this.unavailable.set(false);
      return;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.doRefresh(projectId).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(projectId: string): Promise<void> {
    this.discovering.set(true);
    this.error.set(null);
    try {
      const result = await this.tauri.invoke<SlashDiscovery>('list_slash_commands', {
        projectId,
      });
      this.commands.set(result.commands);
      this.source.set(result.source);
      this.unavailable.set(result.source === 'Unavailable');
    } catch (err) {
      this.source.set(null);
      this.error.set(String(err));
      this.unavailable.set(false);
    } finally {
      this.discovering.set(false);
    }
  }

  /**
   * Invalidates the backend slash-command cache for a project.
   * @param projectId - Project name whose cache to invalidate.
   */
  async invalidate(projectId: string): Promise<void> {
    if (!projectId) return;
    try {
      await this.tauri.invoke('invalidate_slash_cache', { projectId });
    } catch (err) {
      this.log.warn(`[SlashService] invalidate_slash_cache failed: ${String(err)}`);
    }
  }
}
