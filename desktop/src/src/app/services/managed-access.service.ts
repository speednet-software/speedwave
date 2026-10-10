import { Injectable, computed, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import type { ManagedAccess, ManagedAccessList, ManagedLamp } from '../models/management';

/**
 * What the organisation's policy lets run on this machine (ADR-091), read from the policy itself and
 * again whenever it changes: per project, service (built-in, `os.<key>`, `plugin:<id>`) and agent,
 * allowed or not — the lamp beside each. Nothing is marked on a machine without a policy, nor for a
 * kind the policy says nothing about.
 */
@Injectable({ providedIn: 'root' })
export class ManagedAccessService {
  private readonly tauri = inject(TauriService);
  private readonly log = inject(LoggerService);

  private readonly access = signal<ManagedAccess | null>(null);

  /** The machine is under a managed policy. */
  readonly managed = computed(() => !!this.access()?.managed);
  /** The management provider's name, as the policy gives it. */
  readonly provider = computed(() => this.access()?.provider ?? null);

  /** Reads the policy now and whenever it changes. */
  constructor() {
    void this.load();
    try {
      void this.tauri
        .listen('managed_policy_changed', () => void this.load())
        .catch(() => undefined);
    } catch {
      this.log.warn('Managed access is read once: no policy events here');
    }
  }

  /**
   * Reads the policy again.
   * @returns Resolves once read (or failed).
   */
  async load(): Promise<void> {
    try {
      this.access.set(await this.tauri.invoke<ManagedAccess>('get_managed_access'));
    } catch (e: unknown) {
      this.log.warn(`Managed access not read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The lamp of a project.
   * @param name - The project's name.
   * @returns Allowed or not, or null when not managed.
   */
  project(name: string | null | undefined): ManagedLamp | null {
    return this.lamp(this.access()?.projects, name);
  }

  /**
   * The lamp of a service.
   * @param key - Its policy key: `slack`, `os.mail`, `plugin:<service_id>`.
   * @returns Allowed or not, or null when not managed.
   */
  service(key: string | null | undefined): ManagedLamp | null {
    return this.lamp(this.access()?.services, key);
  }

  /**
   * The lamp of a project's Claude Code agent.
   * @param name - The agent's name.
   * @returns Allowed or not, or null when not managed.
   */
  agent(name: string | null | undefined): ManagedLamp | null {
    return this.lamp(this.access()?.agents, name);
  }

  private lamp(
    list: ManagedAccessList | null | undefined,
    name: string | null | undefined
  ): ManagedLamp | null {
    if (!this.access()?.managed || !list || !name) return null;
    return (list.rules[name] ?? list.default) === 'allow' ? 'allowed' : 'not-allowed';
  }
}
