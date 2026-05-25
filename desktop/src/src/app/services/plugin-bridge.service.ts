import { Injectable, inject, signal, type Signal } from '@angular/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from './tauri.service';
import type { PluginBridgeCredentials, PluginBridgeStatus } from '../models/plugin';

interface BridgeEventPayload {
  slug: string;
  kind:
    | 'slot_occupied'
    | 'paired'
    | 'disconnected'
    | 'pair_busy'
    | 'evicted_older'
    | 'pending_timeout';
}

/**
 * Tracks one plugin's host-bridge status. Combines a `plugin_bridge_get_status`
 * snapshot with live updates from the `plugin_bridge_event` Tauri event so
 * the UI sees `paired` flip without polling.
 */
@Injectable({ providedIn: 'root' })
export class PluginBridgeService {
  private readonly tauri = inject(TauriService);
  private readonly statuses = new Map<
    string,
    ReturnType<typeof signal<PluginBridgeStatus | null>>
  >();
  private unlisten: UnlistenFn | null = null;
  private listening = false;

  /**
   * Reactive status for a given plugin slug. `null` until first refresh.
   * @param slug - Plugin slug to track.
   */
  status(slug: string): Signal<PluginBridgeStatus | null> {
    let sig = this.statuses.get(slug);
    if (!sig) {
      sig = signal<PluginBridgeStatus | null>(null);
      this.statuses.set(slug, sig);
    }
    return sig.asReadonly();
  }

  /**
   * Fetches a fresh snapshot and subscribes to live events on first call.
   * @param slug - Plugin slug to refresh.
   */
  async refresh(slug: string): Promise<void> {
    await this.ensureListening();
    const snapshot = await this.tauri.invoke<PluginBridgeStatus>('plugin_bridge_get_status', {
      slug,
    });
    this.writeStatus(slug, snapshot);
  }

  /**
   * Fetches the plugin's bridge URL and auth token from the backend.
   * @param slug - Plugin slug to query.
   */
  async credentials(slug: string): Promise<PluginBridgeCredentials> {
    return this.tauri.invoke<PluginBridgeCredentials>('plugin_bridge_get_credentials', { slug });
  }

  private writeStatus(slug: string, snapshot: PluginBridgeStatus): void {
    let sig = this.statuses.get(slug);
    if (!sig) {
      sig = signal<PluginBridgeStatus | null>(null);
      this.statuses.set(slug, sig);
    }
    sig.set(snapshot);
  }

  private async ensureListening(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.unlisten = await this.tauri.listen<BridgeEventPayload>(
      'plugin_bridge_event',
      ({ payload }) => {
        const sig = this.statuses.get(payload.slug);
        if (!sig) return;
        const current = sig();
        if (!current) return;
        const paired =
          payload.kind === 'paired'
            ? true
            : payload.kind === 'disconnected'
              ? false
              : current.paired;
        sig.set({ ...current, paired });
      }
    );
  }
}
