import { Directive, ElementRef, HostListener, inject, input, output, signal } from '@angular/core';

/** Drop-target. `dragDepth` counter fixes the child-boundary flicker. */
@Directive({
  selector: '[appFileDrop]',
  exportAs: 'appFileDrop',
})
export class FileDropDirective {
  readonly disabled = input<boolean>(false);
  readonly filesDropped = output<File[]>();
  readonly isDragging = signal<boolean>(false);

  private dragDepth = 0;
  private readonly host = inject(ElementRef<HTMLElement>);

  /**
   * Starts a drag session; increments `dragDepth` so child boundaries don't flicker.
   * @param event - Native dragenter event.
   */
  @HostListener('dragenter', ['$event'])
  onDragEnter(event: DragEvent): void {
    if (this.disabled()) return;
    if (!hasFiles(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.isDragging.set(true);
  }

  /**
   * Keeps the drop target alive; preventDefault is mandatory for `drop` to fire.
   * @param event - Native dragover event.
   */
  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    if (this.disabled()) return;
    if (!hasFiles(event)) return;
    // Mandatory for `drop` to fire.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  /**
   * Decrements `dragDepth`; flips `isDragging` off only at depth 0.
   * @param event - Native dragleave event.
   */
  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    if (this.disabled()) return;
    if (!hasFiles(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.isDragging.set(false);
    }
  }

  /**
   * Emits `filesDropped` with the dropped File list.
   * @param event - Native drop event.
   */
  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    if (this.disabled()) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.isDragging.set(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) {
      this.filesDropped.emit(files);
    }
  }
}

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}
