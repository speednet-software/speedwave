/** Shared mock for TauriService used across Angular test files. */
export class MockTauriService {
  /** Configurable handler for invoke calls — override in beforeEach per test suite. */
  invokeHandler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> = async () =>
    undefined;

  /** Registered event listener callbacks keyed by event name. */
  listenHandlers: Record<string, (event: unknown) => void> = {};

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
    this.listenHandlers[event] = handler as (event: unknown) => void;
    return () => {
      delete this.listenHandlers[event];
    };
  }

  /**
   * Dispatches a mock event to a registered listener.
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

  /** Mock isRunningInTauri — defaults to false for tests. */
  isRunningInTauri(): boolean {
    return false;
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
