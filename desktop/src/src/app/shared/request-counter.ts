import { effect, untracked, type Signal } from '@angular/core';

/**
 * Runs `handler` every time a request counter changes after its first observed value, so a component
 * (re)mount never replays a request bumped before it existed. Call in an injection context.
 * @param counter - A counter signal such as `UiStateService.restartRequested`.
 * @param handler - What to do on each new request.
 */
export function onRequestCounter(counter: Signal<number>, handler: () => void): void {
  let previous: number | null = null;
  effect(() => {
    const requested = counter();
    untracked(() => {
      const seen = previous;
      previous = requested;
      if (seen === null || seen === requested) return;
      handler();
    });
  });
}
