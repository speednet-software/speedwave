/** Shared mock for TauriService used across Angular test files. */
export class MockTauriService {
  /** Configurable handler for invoke calls — override in beforeEach per test suite. */
  invokeHandler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> = async () =>
    undefined;

  /**
   * Registered event listeners keyed by event name; each entry delivers to every listener of that
   * event, and disappears with the last one, as Tauri's own listeners do.
   */
  listenHandlers: Record<string, (event: unknown) => void> = {};

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  /**
   * Mock invoke that delegates to invokeHandler.
   * @param cmd - The command name.
   * @param args - Optional command arguments.
   */
  async invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return this.invokeHandler(cmd, args) as Promise<T>;
  }

  /**
   * Mock listen that captures callbacks so tests can dispatch events.
   * @param event - The event name.
   * @param handler - The event handler callback.
   */
  async listen(event: string, handler: unknown): Promise<() => void> {
    const fn = handler as (event: unknown) => void;
    const set = this.listeners.get(event) ?? new Set<(event: unknown) => void>();
    set.add(fn);
    this.listeners.set(event, set);
    this.listenHandlers[event] = (e) => {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(e);
    };
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.listeners.get(event) === set) {
        this.listeners.delete(event);
        delete this.listenHandlers[event];
      }
    };
  }

  /**
   * Dispatches a mock event to every listener registered for it.
   * @param event - The event name.
   * @param payload - The event payload.
   */
  dispatchEvent(event: string, payload: unknown): void {
    this.listenHandlers[event]?.({ payload });
  }

  /** Mock getVersion that returns a fixed version string. */
  async getVersion(): Promise<string> {
    return '1.0.0';
  }

  /** Toggle the value returned by `isRunningInTauri()` per test. Defaults to false. */
  runningInTauri = false;

  /** Mock isRunningInTauri — defaults to false; override via `runningInTauri`. */
  isRunningInTauri(): boolean {
    return this.runningInTauri;
  }
}

/** Shared mock for `get_bundle_reconcile_state` — reuse in spec files instead of duplicating. */
export const MOCK_BUNDLE_RECONCILE_DONE = {
  phase: 'done',
  in_progress: false,
  last_error: null,
  pending_running_projects: [],
  applied_bundle_id: null,
};
