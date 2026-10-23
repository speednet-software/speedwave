import { Injectable, inject, signal, type Signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { UPDATE_DOWNLOAD_PROGRESS_EVENT, UpdateDownloadProgressEvent } from '../models/update';

/**
 * Latest `update_download_progress` event. Non-null while an update is downloading or
 * installing, whichever surface (Settings, the banner, the tray) started it; the backend
 * sends null when the install fails, and a successful one restarts the app.
 */
@Injectable({ providedIn: 'root' })
export class UpdateProgressService {
  private readonly tauri = inject(TauriService);
  private readonly state = signal<UpdateDownloadProgressEvent>(null);

  readonly progress: Signal<UpdateDownloadProgressEvent> = this.state.asReadonly();

  /** Subscribes to the backend's progress events. */
  constructor() {
    void this.listen();
  }

  private async listen(): Promise<void> {
    try {
      await this.tauri.listen<UpdateDownloadProgressEvent>(
        UPDATE_DOWNLOAD_PROGRESS_EVENT,
        (event) => {
          this.state.set(event.payload);
        }
      );
    } catch {}
  }
}
