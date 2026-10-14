import { Injectable, inject, signal, type WritableSignal } from '@angular/core';
import { ClaudeControlService } from './claude-control.service';
import type { ClaudePlanUsage } from '../models/claude-control';
import type { RateLimitInfo } from '../models/chat';
import { planLimitsFrom, type PlanLimits } from '../models/plan-limits';

/**
 * Plan usage limits per project, read from Claude Code's `get_usage` on demand (never on a
 * timer) and kept across conversations; `rate_limit_event` is only a warning signal.
 */
@Injectable({ providedIn: 'root' })
export class PlanUsageService {
  private readonly control = inject(ClaudeControlService);
  private readonly usage = signal<ReadonlyMap<string, ClaudePlanUsage>>(new Map());
  private readonly signals = signal<ReadonlyMap<string, RateLimitInfo>>(new Map());
  private readonly inflight = new Map<string, Promise<void>>();

  /**
   * Limits worth showing at `nowMs` (signal read); `null` when Claude Code reports none.
   * @param project - Project the Anthropic sign-in belongs to.
   * @param nowMs - Current time; windows that have reset since the last read are dropped.
   */
  limits(project: string | null, nowMs: number): PlanLimits | null {
    if (!project) return null;
    return planLimitsFrom(this.usage().get(project) ?? null, nowMs);
  }

  /**
   * Latest `rate_limit_event` of the project (signal read): a warning or rejected status signal.
   * @param project - Project the Anthropic sign-in belongs to.
   */
  lastSignal(project: string | null): RateLimitInfo | null {
    return project ? (this.signals().get(project) ?? null) : null;
  }

  /**
   * Re-reads `get_usage`; concurrent calls share one request, and a failed read clears the limits.
   * @param project - Project whose live chat session answers the request.
   */
  refresh(project: string): Promise<void> {
    const pending = this.inflight.get(project);
    if (pending) return pending;
    const request = this.control
      .planUsage(project)
      .then((usage) => this.store(this.usage, project, usage))
      .finally(() => this.inflight.delete(project));
    this.inflight.set(project, request);
    return request;
  }

  /**
   * Keeps a `rate_limit_event` as the project's status signal and re-reads the limits.
   * @param project - Project whose session emitted the event.
   * @param info - Parsed event; its utilization may be absent.
   */
  recordSignal(project: string, info: RateLimitInfo): void {
    this.store(this.signals, project, info);
    void this.refresh(project);
  }

  /**
   * Forgets everything known about a project's limits (logout, provider switch).
   * @param project - Project to forget.
   */
  drop(project: string): void {
    this.store(this.usage, project, null);
    this.store(this.signals, project, null);
  }

  private store<T>(
    target: WritableSignal<ReadonlyMap<string, T>>,
    project: string,
    value: T | null
  ): void {
    if (value === null && !target().has(project)) return;
    const next = new Map(target());
    if (value === null) next.delete(project);
    else next.set(project, value);
    target.set(next);
  }
}
