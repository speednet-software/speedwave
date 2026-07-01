import { Injectable, OnDestroy, inject } from '@angular/core';
import { TauriService } from '../../services/tauri.service';
import type { AuthStatusResponse } from '../../services/project-state.service';

/** Host callbacks for the watcher — read live on every tick/probe. */
export interface OauthWatchContext {
  /** Current active project; re-read after the probe to drop stale results. */
  activeProject(): string | null;
  /** True once OAuth credentials are present — stops the poll, gates the edge. */
  isAuthenticated(): boolean;
  /** False makes a poll tick skip its IPC probe (e.g. non-Anthropic card active). */
  shouldProbe(): boolean;
  /** Fired exactly once per detected external login (false→true edge). */
  onLoginDetected(): Promise<void>;
}

/**
 * Detects an external-terminal OAuth login (no frontend callback): a bounded
 * poll plus a window-focus probe fire `onLoginDetected` on the false→true edge.
 */
@Injectable()
export class OauthCompletionWatcher implements OnDestroy {
  /** Poll cadence; get_auth_status also nudges container readiness, so not too tight. */
  static readonly POLL_MS = 1500;
  /** Cap the poll lifetime (~5 min): a login not done by then needs a re-open. */
  static readonly MAX_TICKS = 200;

  private tauri = inject(TauriService);
  private context: OauthWatchContext | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** Remaining ticks before the poll self-expires (bounds the IPC/log churn). */
  private ticksLeft = 0;
  /** True while a probe is in flight; blocks overlapping ticks (single edge fire). */
  private checkInFlight = false;
  private unlistenFocus: (() => void) | null = null;
  private focusWatchRequested = false;
  private destroyed = false;

  /**
   * Binds the host context. Call before `startPoll`/`watchWindowFocus`.
   * @param context - Live host callbacks (project, auth state, login handler).
   */
  attach(context: OauthWatchContext): void {
    this.context = context;
  }

  /** (Re)starts the completion poll; self-expires after `MAX_TICKS`. */
  startPoll(): void {
    this.stopPoll();
    this.ticksLeft = OauthCompletionWatcher.MAX_TICKS;
    this.poll = setInterval(() => {
      const ctx = this.context;
      if (!ctx || ctx.isAuthenticated() || this.ticksLeft-- <= 0) {
        this.stopPoll();
        return;
      }
      if (!ctx.shouldProbe()) return;
      void this.checkNow();
    }, OauthCompletionWatcher.POLL_MS);
  }

  /** Stops the completion poll (idempotent). */
  stopPoll(): void {
    if (this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  /** True while the completion poll is running. */
  isPolling(): boolean {
    return this.poll !== null;
  }

  /** Registers the window-focus probe — forces a check past interval throttling. */
  watchWindowFocus(): void {
    if (this.focusWatchRequested) return;
    this.focusWatchRequested = true;
    this.tauri
      .listen('window_focused', () => void this.checkNow())
      .then((unlisten) => {
        // Registration can settle after teardown — release it immediately then.
        if (this.destroyed) {
          unlisten();
          return;
        }
        this.unlistenFocus = unlisten;
      })
      .catch(() => {
        // Tauri event listener not available outside desktop context.
      });
  }

  /**
   * One probe: on the credentials false→true edge, stop the poll and fire
   * `onLoginDetected` once (in-flight + stale-project guarded).
   */
  async checkNow(): Promise<void> {
    const ctx = this.context;
    const project = ctx?.activeProject();
    // In-flight guard: a slow get_auth_status would otherwise let the next tick
    // pass the same false→true edge and fire a second login callback.
    if (!ctx || !project || this.checkInFlight) return;
    this.checkInFlight = true;
    try {
      const status = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', { project });
      // Drop a stale probe: the active project changed while we were awaiting,
      // so this result belongs to a project the user already left.
      if (ctx.activeProject() !== project) return;
      if (status.oauth_authenticated && !ctx.isAuthenticated()) {
        this.stopPoll();
        await ctx.onLoginDetected();
      }
    } catch {
      // Container not running yet — keep polling.
    } finally {
      this.checkInFlight = false;
    }
  }

  /** Tears down the poll and the focus listener (idempotent). */
  destroy(): void {
    this.destroyed = true;
    this.stopPoll();
    if (this.unlistenFocus) {
      this.unlistenFocus();
      this.unlistenFocus = null;
    }
  }

  /** DI-driven teardown (component-scoped provider) — delegates to `destroy`. */
  ngOnDestroy(): void {
    this.destroy();
  }
}
