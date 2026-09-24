import { Injectable, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import {
  CLAUDE_SESSION_INFO_EVENT,
  type ClaudeContextUsage,
  type ClaudePlanUsage,
  type ClaudeSessionInfo,
  type ClaudeSessionInfoEvent,
  type ClaudeSessionInfoState,
} from '../models/claude-control';

const UNAVAILABLE: ClaudeSessionInfoState = { state: 'unavailable' };

/**
 * Transport to the live chat session's Claude Code control channel: session info pushed at
 * spawn, plan and context usage on demand. Every failure degrades to "no data".
 */
@Injectable({ providedIn: 'root' })
export class ClaudeControlService {
  private readonly tauri = inject(TauriService);
  private readonly log = inject(LoggerService);
  private readonly states = signal<ReadonlyMap<string, ClaudeSessionInfoState>>(new Map());

  /** Subscribes to the backend's session-info event. */
  constructor() {
    void this.listen();
  }

  private async listen(): Promise<void> {
    try {
      await this.tauri.listen<ClaudeSessionInfoEvent>(CLAUDE_SESSION_INFO_EVENT, (event) => {
        this.apply(event.payload.project, event.payload.status);
      });
    } catch {}
  }

  private apply(project: string, status: ClaudeSessionInfoState): void {
    const next = new Map(this.states());
    next.set(project, status);
    this.states.set(next);
  }

  /**
   * Session-info state of a project (signal read); `unavailable` until the backend reports one.
   * @param project - Project the chat session belongs to.
   */
  sessionInfoState(project: string): ClaudeSessionInfoState {
    return this.states().get(project) ?? UNAVAILABLE;
  }

  /**
   * Parsed `initialize` result of a project's session (signal read), or `null` when not ready.
   * @param project - Project the chat session belongs to.
   */
  sessionInfo(project: string): ClaudeSessionInfo | null {
    const status = this.sessionInfoState(project);
    return status.state === 'ready' ? status.info : null;
  }

  /**
   * Pulls the current session-info state, for a consumer created after the event fired.
   * @param project - Project the chat session belongs to.
   */
  async refreshSessionInfo(project: string): Promise<void> {
    try {
      const status = await this.tauri.invoke<ClaudeSessionInfoState>('get_chat_session_info', {
        project,
      });
      this.apply(project, status);
    } catch (e: unknown) {
      this.log.debug(`get_chat_session_info failed: ${describe(e)}`);
    }
  }

  /**
   * Plan usage windows behind Claude Code's `/usage`; `null` on any failure.
   * @param project - Project the chat session belongs to.
   */
  async planUsage(project: string): Promise<ClaudePlanUsage | null> {
    try {
      return await this.tauri.invoke<ClaudePlanUsage>('get_plan_usage', { project });
    } catch (e: unknown) {
      this.log.debug(`get_plan_usage failed: ${describe(e)}`);
      return null;
    }
  }

  /**
   * Context usage behind Claude Code's `/context`; `null` on any failure.
   * @param project - Project the chat session belongs to.
   */
  async contextUsage(project: string): Promise<ClaudeContextUsage | null> {
    try {
      return await this.tauri.invoke<ClaudeContextUsage>('get_context_usage', { project });
    } catch (e: unknown) {
      this.log.debug(`get_context_usage failed: ${describe(e)}`);
      return null;
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
