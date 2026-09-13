import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';

/**
 * Capitalizes the first letter only (`'xhigh'` -> `'Xhigh'`, `'max'` -> `'Max'`).
 * @param level - Raw lower-case level string.
 */
export function capitalizeLevel(level: string): string {
  return level.length === 0 ? level : level[0].toUpperCase() + level.slice(1);
}

/**
 * Discrete effort slider over the caller's stops (the active model's `effort_levels`, low
 * to max); a stop click, drag release, or Enter emits `levelSelected` once. Caller persists.
 */
@Component({
  selector: 'app-effort-slider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="w-56 px-3 py-2.5">
      <div data-testid="effort-popover-header" class="mono mb-3 text-[11px] text-[var(--ink)]">
        Effort {{ headerLevel() }}
      </div>
      <div #track class="relative flex h-4 items-center">
        <div class="pointer-events-none absolute inset-x-1 h-px bg-[var(--line)]"></div>
        @for (level of stops(); track level; let i = $index) {
          <button
            type="button"
            [attr.data-testid]="'effort-stop-' + level"
            [attr.aria-label]="level"
            class="absolute h-2 w-2 -translate-x-1/2 rounded-full"
            [class]="i <= displayedIndex() ? 'bg-[var(--teal)]' : 'bg-[var(--line-strong)]'"
            [style.left.%]="stopPercent(i)"
            (click)="applyIndex(i)"
          ></button>
        }
        <div
          data-testid="effort-slider"
          role="slider"
          tabindex="0"
          class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--teal)] bg-[var(--bg-1)]"
          [class.opacity-40]="!pinned()"
          [style.left.%]="stopPercent(displayedIndex())"
          [attr.aria-valuemin]="0"
          [attr.aria-valuemax]="stops().length - 1"
          [attr.aria-valuenow]="displayedIndex()"
          [attr.aria-valuetext]="capitalizedDisplayedLevel()"
          (keydown)="onKeydown($event)"
          (pointerdown)="onHandlePointerDown($event)"
          (pointermove)="onHandlePointerMove($event, track)"
          (pointerup)="onHandlePointerUp($event)"
        ></div>
      </div>
      <div class="mono mt-2 flex justify-between text-[10px] text-[var(--ink-mute)]">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
    </div>
  `,
})
export class EffortSliderComponent {
  /** Stops offered, `low`→`max` order, already restricted to the active model. */
  readonly stops = input.required<string[]>();
  /** Level the handle sits on: the pin (clamped to a supported stop) or, unpinned, the catalog default. */
  readonly activeLevel = input.required<string>();
  /** False when there is no pin: the header reads "Default" and the handle is dimmed. */
  readonly pinned = input(false);
  /** Fired once per commit: a stop click, a drag release, or Enter after an arrow move. */
  readonly levelSelected = output<string>();

  /** Tentative index during an in-progress arrow-key move or drag, before it commits. */
  private readonly pending = signal<number | null>(null);
  private dragging = false;

  /** Resets any tentative move when the slider's inputs change out from under it. */
  constructor() {
    // An external change (resync, popover reopened on another model) discards a
    // tentative arrow move that belonged to the previous state.
    effect(() => {
      this.stops();
      this.activeLevel();
      this.pending.set(null);
    });
  }

  private readonly committedIndex = computed(() => {
    const i = this.stops().indexOf(this.activeLevel());
    return i === -1 ? 0 : i;
  });

  protected readonly displayedIndex = computed(() => this.pending() ?? this.committedIndex());

  protected readonly headerLevel = computed(() =>
    this.pinned() ? this.capitalizedDisplayedLevel() : 'Default'
  );

  protected readonly capitalizedDisplayedLevel = computed(() => {
    const level = this.stops()[this.displayedIndex()];
    return capitalizeLevel(level ?? this.activeLevel());
  });

  /**
   * Handle/stop horizontal position as a percentage of the track width.
   * @param index - Stop index into `stops()`.
   */
  protected stopPercent(index: number): number {
    const last = this.stops().length - 1;
    return last <= 0 ? 0 : (index / last) * 100;
  }

  /**
   * Commits `stops()[index]` immediately and clears any tentative position.
   * @param index - Stop index into `stops()` to commit.
   */
  protected applyIndex(index: number): void {
    const level = this.stops()[index];
    if (!level) return;
    this.pending.set(null);
    this.levelSelected.emit(level);
  }

  /**
   * Arrows move the tentative stop by one; Enter commits it.
   * @param event - Native keydown event on the slider handle.
   */
  protected onKeydown(event: KeyboardEvent): void {
    const max = this.stops().length - 1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.pending.set(Math.min(max, this.displayedIndex() + 1));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.pending.set(Math.max(0, this.displayedIndex() - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.applyIndex(this.displayedIndex());
    }
  }

  /**
   * Captures the pointer on the handle so drag moves outside it still track.
   * @param event - Native pointerdown event on the handle.
   */
  protected onHandlePointerDown(event: PointerEvent): void {
    event.preventDefault();
    this.dragging = true;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  /**
   * Updates the tentative stop from the pointer's ratio across the track; does not commit.
   * @param event - Native pointermove event (pointer-captured, so it fires even off-handle).
   * @param track - The track element, via the `#track` template reference.
   */
  protected onHandlePointerMove(event: PointerEvent, track: HTMLElement): void {
    if (!this.dragging) return;
    const rect = track.getBoundingClientRect();
    const ratio = rect.width <= 0 ? 0 : (event.clientX - rect.left) / rect.width;
    const max = this.stops().length - 1;
    const idx = Math.round(Math.min(1, Math.max(0, ratio)) * max);
    this.pending.set(idx);
  }

  /**
   * Release commits the tentative stop reached by the drag.
   * @param event - Native pointerup event on the handle.
   */
  protected onHandlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.applyIndex(this.displayedIndex());
  }
}
