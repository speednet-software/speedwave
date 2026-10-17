import { Directive, HostListener, input, output, signal } from '@angular/core';

/** Files and directory names one drop or paste carries. */
export interface DroppedItems {
  files: File[];
  folders: string[];
}

/** Drop-target. `dragDepth` counter fixes the child-boundary flicker. */
@Directive({
  selector: '[appFileDrop]',
  exportAs: 'appFileDrop',
})
export class FileDropDirective {
  readonly disabled = input<boolean>(false);
  /** Everything one drop carried; directories by name, since the composer cannot attach them. */
  readonly dropped = output<DroppedItems>();
  readonly isDragging = signal<boolean>(false);

  private dragDepth = 0;

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
   * Emits `dropped` once with the drop's files and directory names.
   * @param event - Native drop event.
   */
  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    if (this.disabled()) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.isDragging.set(false);
    const items = partitionItems(event.dataTransfer?.items);
    if (items.files.length > 0 || items.folders.length > 0) {
      this.dropped.emit(items);
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

/**
 * Splits the items of a drop or a paste into files and directory names.
 * @param items - `DataTransfer.items` of the event; absent when it carries none.
 */
export function partitionItems(items: DataTransferItemList | undefined): DroppedItems {
  const files: File[] = [];
  const folders: string[] = [];
  if (!items) return { files, folders };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    const file = item.getAsFile();
    if (entry?.isDirectory) {
      folders.push(entry.name || file?.name || 'folder');
    } else if (file) {
      files.push(file);
    }
  }
  return { files, folders };
}
