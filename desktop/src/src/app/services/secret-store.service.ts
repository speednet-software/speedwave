import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import {
  groupByProject,
  isSecretStoreStatus,
  type SecretStoreProjectGroup,
  type SecretStoreState,
  type SecretStoreStatus,
} from '../models/secret-store';
import { errorText } from '../shared/error-text';
import { LoggerService } from './logger.service';
import { TauriService } from './tauri.service';

/**
 * State of the encrypted secret store: blocks the UI while the key is missing or the store is
 * damaged, and carries the non-blocking notices about unreadable integration credentials and
 * failed migrations.
 */
@Injectable({ providedIn: 'root' })
export class SecretStoreService {
  private readonly tauri = inject(TauriService);
  private readonly log = inject(LoggerService);
  private readonly statusState = signal<SecretStoreStatus | null>(null);
  private readonly dismissedState = signal<readonly string[]>([]);
  private readonly resettingState = signal(false);
  private readonly resetErrorState = signal<string | null>(null);

  readonly status: Signal<SecretStoreStatus | null> = this.statusState.asReadonly();
  readonly state: Signal<SecretStoreState> = computed(() => this.statusState()?.state ?? 'ready');
  readonly blocking: Signal<boolean> = computed(() => this.state() !== 'ready');
  readonly affectedProjects: Signal<SecretStoreProjectGroup[]> = computed(() =>
    groupByProject(this.statusState()?.integrations ?? [])
  );
  readonly plaintextCount: Signal<number> = computed(() => this.statusState()?.plaintextCount ?? 0);
  readonly notices: Signal<string[]> = computed(() => {
    const status = this.statusState();
    return [...(status?.unreadable ?? []), ...(status?.migrationNotices ?? [])].filter(
      (message) => !this.dismissedState().includes(message)
    );
  });
  readonly resetting: Signal<boolean> = this.resettingState.asReadonly();
  readonly resetError: Signal<string | null> = this.resetErrorState.asReadonly();

  /** Loads the status once at startup. */
  constructor() {
    void this.refresh();
  }

  /** Reads the current status from the backend; a failed or malformed answer keeps the last one. */
  async refresh(): Promise<void> {
    try {
      const status = await this.tauri.invoke<unknown>('get_secret_store_status');
      if (isSecretStoreStatus(status)) this.statusState.set(status);
    } catch (e) {
      this.log.warn(`[SecretStore] get_secret_store_status failed: ${errorText(e)}`);
    }
  }

  /** Discards the unreadable credentials so a new key can be created; irreversible. */
  async createNewKey(): Promise<void> {
    if (this.resettingState()) return;
    this.resettingState.set(true);
    this.resetErrorState.set(null);
    try {
      const status = await this.tauri.invoke<unknown>('reset_secret_store', { confirmed: true });
      if (isSecretStoreStatus(status)) {
        this.statusState.set(status);
      } else {
        this.resetErrorState.set('The secret store returned an unexpected answer.');
      }
    } catch (e) {
      this.resetErrorState.set(errorText(e));
    } finally {
      this.resettingState.set(false);
    }
  }

  /** Hides the notices that are shown now; a different message appears again. */
  dismissNotices(): void {
    this.dismissedState.update((dismissed) => [...dismissed, ...this.notices()]);
  }
}
