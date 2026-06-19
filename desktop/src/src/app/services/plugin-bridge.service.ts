import { Injectable, OnDestroy, WritableSignal, inject, signal, type Signal } from '@angular/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
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

/** Tracks host-bridge plugin status via snapshot plus live `plugin_bridge_event` updates. */
@Injectable({ providedIn: 'root' })
export class PluginBridgeService implements OnDestroy {
  private readonly tauri = inject(TauriService);
  private readonly log = inject(LoggerService);
  private readonly statuses = new Map<string, WritableSignal<PluginBridgeStatus | null>>();
  private unlisten: UnlistenFn | null = null;
  private listening = false;
  private pendingListen: Promise<void> | null = null;

  /**
   * Reactive status for a given plugin slug. `null` until first refresh.
   * @param slug - Plugin slug to track.
   */
  status(slug: string): Signal<PluginBridgeStatus | null> {
    return this.getOrCreateSig(slug).asReadonly();
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
    this.getOrCreateSig(slug).set(snapshot);
  }

  /**
   * Fetches the plugin's bridge URL and auth token from the backend.
   * @param slug - Plugin slug to query.
   */
  async credentials(slug: string): Promise<PluginBridgeCredentials> {
    await this.ensureListening();
    return this.tauri.invoke<PluginBridgeCredentials>('plugin_bridge_get_credentials', { slug });
  }

  /** Releases the Tauri event subscription when the service is torn down. */
  ngOnDestroy(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.listening = false;
    this.pendingListen = null;
  }

  private getOrCreateSig(slug: string): WritableSignal<PluginBridgeStatus | null> {
    let sig = this.statuses.get(slug);
    if (!sig) {
      sig = signal<PluginBridgeStatus | null>(null);
      this.statuses.set(slug, sig);
    }
    return sig;
  }

  private ensureListening(): Promise<void> {
    if (this.listening) return Promise.resolve();
    if (this.pendingListen) return this.pendingListen;
    this.pendingListen = this.tauri
      .listen<BridgeEventPayload>('plugin_bridge_event', ({ payload }) => this.applyEvent(payload))
      .then((fn) => {
        this.unlisten = fn;
        this.listening = true;
      })
      .catch((err) => {
        this.log.error(
          `PluginBridgeService: failed to subscribe to plugin_bridge_event: ${String(err)}`
        );
        this.pendingListen = null;
      });
    return this.pendingListen;
  }

  private applyEvent(payload: BridgeEventPayload): void {
    const sig = this.statuses.get(payload.slug);
    if (!sig) {
      this.log.warn(
        `PluginBridgeService: dropped ${payload.kind} for unknown slug ${payload.slug}`
      );
      return;
    }
    const current = sig();
    if (!current || !current.running) return;
    switch (payload.kind) {
      case 'paired':
        sig.set({ ...current, paired: true, partner_connected: true });
        return;
      case 'slot_occupied':
        sig.set({ ...current, partner_connected: true });
        return;
      case 'disconnected':
        sig.set({ ...current, paired: false, partner_connected: false });
        return;
      default:
        this.log.warn(`PluginBridgeService: bridge ${payload.slug} ${payload.kind}`);
        return;
    }
  }
}
