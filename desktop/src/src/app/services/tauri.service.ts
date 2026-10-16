import { Injectable } from '@angular/core';
import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { listen, type UnlistenFn, type Event } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';

/** Thin wrapper around Tauri APIs for Angular dependency injection and testability. */
@Injectable({ providedIn: 'root' })
export class TauriService {
  /**
   * Invokes a Tauri command on the Rust backend.
   * @param cmd - The command name registered in the Tauri backend.
   * @param args - Optional arguments passed to the command; a `Uint8Array` goes as a raw body.
   * @param options - Optional request headers, read by commands that take `tauri::ipc::Request`.
   */
  invoke<T = unknown>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
    return invoke<T>(cmd, args, options);
  }

  /**
   * Subscribes to a Tauri event and returns an unlisten function.
   * @param event - The event name to listen for.
   * @param handler - Callback invoked when the event fires.
   */
  listen<T = unknown>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
    return listen<T>(event, handler);
  }

  /** Returns the application version from the Tauri runtime. */
  getVersion(): Promise<string> {
    return getVersion();
  }

  /** Detects whether the app is running inside a Tauri 2 webview. */
  isRunningInTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }
}
