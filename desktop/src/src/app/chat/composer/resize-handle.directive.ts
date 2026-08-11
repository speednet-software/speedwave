import { Directive, ElementRef, HostListener, inject, input, output } from '@angular/core';

/**
 * Vertical resize handle. Emits px deltas (drag up / ArrowUp = positive); the host owns
 * clamping and applies the size. Keyboard-accessible and pointer-capture based for cross-webview parity.
 */
@Directive({
  selector: '[appResizeHandle]',
  exportAs: 'appResizeHandle',
  host: {
    role: 'separator',
    'aria-orientation': 'horizontal',
    tabindex: '0',
  },
})
export class ResizeHandleDirective {
  /** True to ignore all resize gestures (mirrors the composer disabled state). */
  readonly disabled = input<boolean>(false);

  /** Height change per Arrow key press, in px. */
  readonly keyStep = input<number>(24);

  /** Fires once when a drag or key gesture begins; host snapshots the base height here. */
  readonly resizeStart = output<void>();

  /** Fires with the signed px delta from the gesture start (positive grows the field). */
  readonly resizeBy = output<number>();

  /** Fires once when the gesture ends. */
  readonly resizeEnd = output<void>();

  /** Fires on double-click; host returns to automatic sizing. */
  readonly resizeReset = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private startY: number | null = null;

  /**
   * Begins a drag session and captures the pointer so moves outside the handle still track.
   * @param event - Native pointerdown event.
   */
  @HostListener('pointerdown', ['$event'])
  onPointerDown(event: PointerEvent): void {
    if (this.disabled() || event.button !== 0) return;
    event.preventDefault();
    this.startY = event.clientY;
    this.host.nativeElement.setPointerCapture?.(event.pointerId);
    this.resizeStart.emit();
  }

  /**
   * Emits the cumulative delta from drag start; up (smaller clientY) grows the field.
   * @param event - Native pointermove event.
   */
  @HostListener('pointermove', ['$event'])
  onPointerMove(event: PointerEvent): void {
    if (this.startY === null) return;
    this.resizeBy.emit(this.startY - event.clientY);
  }

  /**
   * Ends the drag session and releases the captured pointer.
   * @param event - Native pointerup/pointercancel event.
   */
  @HostListener('pointerup', ['$event'])
  @HostListener('pointercancel', ['$event'])
  onPointerUp(event: PointerEvent): void {
    if (this.startY === null) return;
    this.startY = null;
    this.host.nativeElement.releasePointerCapture?.(event.pointerId);
    this.resizeEnd.emit();
  }

  /**
   * ArrowUp/ArrowDown resize by a fixed step for keyboard users.
   * @param event - Native keydown event.
   */
  @HostListener('keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (this.disabled()) return;
    const dir = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (dir === 0) return;
    event.preventDefault();
    this.resizeStart.emit();
    this.resizeBy.emit(dir * this.keyStep());
    this.resizeEnd.emit();
  }

  /** Double-click returns the field to automatic sizing. */
  @HostListener('dblclick')
  onDblClick(): void {
    if (this.disabled()) return;
    this.resizeReset.emit();
  }
}
