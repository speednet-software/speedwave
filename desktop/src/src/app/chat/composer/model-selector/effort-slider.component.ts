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
 * Discrete effort slider over the caller's stops (low to max); an unknown level hides the handle until
 * keyboard focus. A stop click, drag release, or Enter emits `levelSelected` once. Caller persists.
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
            [attr.aria-label]="'Effort ' + capitalize(level)"
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
          aria-label="Effort"
          class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--teal)] bg-[var(--bg-1)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]"
          [class.opacity-40]="!pinned() && hasPosition()"
          [class.opacity-0]="!hasPosition()"
          [class.pointer-events-none]="!hasPosition()"
          [style.left.%]="stopPercent(handleIndex())"
          [attr.aria-valuemin]="0"
          [attr.aria-valuemax]="stops().length - 1"
          [attr.aria-valuenow]="handleIndex()"
          [attr.aria-valuetext]="hasPosition() ? capitalizedDisplayedLevel() : 'Default'"
          (keydown)="onKeydown($event)"
          (pointerdown)="onHandlePointerDown($event)"
          (pointermove)="onHandlePointerMove($event, track)"
          (pointerup)="onHandlePointerUp($event)"
          (pointercancel)="onHandlePointerCancel()"
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
  readonly stops = input.required<string[]>();
  readonly activeLevel = input.required<string>();
  readonly pinned = input(false);
  readonly levelSelected = output<string>();

  private readonly pending = signal<number | null>(null);
  private dragging = false;

  /** Resets any tentative move when the slider's inputs change out from under it. */
  constructor() {
    effect(() => {
      this.stops();
      this.activeLevel();
      this.dragging = false;
      this.pending.set(null);
    });
  }

  private readonly committedIndex = computed(() => this.stops().indexOf(this.activeLevel()));

  protected readonly displayedIndex = computed(() => this.pending() ?? this.committedIndex());

  protected readonly hasPosition = computed(() => this.displayedIndex() >= 0);

  protected readonly handleIndex = computed(() => Math.max(0, this.displayedIndex()));

  protected readonly capitalize = capitalizeLevel;

  protected readonly headerLevel = computed(() =>
    this.pinned() ? this.capitalizedDisplayedLevel() : 'Default'
  );

  protected readonly capitalizedDisplayedLevel = computed(() => {
    const level = this.stops()[this.displayedIndex()];
    return capitalizeLevel(level ?? this.activeLevel());
  });

  protected stopPercent(index: number): number {
    const last = this.stops().length - 1;
    return last <= 0 ? 0 : (index / last) * 100;
  }

  protected applyIndex(index: number): void {
    const level = this.stops()[index];
    if (!level) return;
    this.pending.set(null);
    this.levelSelected.emit(level);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const max = this.stops().length - 1;
    const current = this.displayedIndex();
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.pending.set(current < 0 ? 0 : Math.min(max, current + 1));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.pending.set(Math.max(0, current - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.pending.set(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.pending.set(max);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.applyIndex(this.displayedIndex());
    }
  }

  protected onHandlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.dragging = true;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  protected onHandlePointerMove(event: PointerEvent, track: HTMLElement): void {
    if (!this.dragging) return;
    const rect = track.getBoundingClientRect();
    const ratio = rect.width <= 0 ? 0 : (event.clientX - rect.left) / rect.width;
    const max = this.stops().length - 1;
    const idx = Math.round(Math.min(1, Math.max(0, ratio)) * max);
    this.pending.set(idx);
  }

  protected onHandlePointerCancel(): void {
    this.dragging = false;
    this.pending.set(null);
  }

  protected onHandlePointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.applyIndex(this.displayedIndex());
  }
}
