import { Directive, HostListener, input, output, signal } from '@angular/core';

/** Drop-target. `dragDepth` counter fixes the child-boundary flicker. */
@Directive({
  selector: '[appFileDrop]',
  exportAs: 'appFileDrop',
})
export class FileDropDirective {
  readonly disabled = input<boolean>(false);
  readonly filesDropped = output<File[]>();
  /** Names of dropped directories, which the composer cannot attach. */
  readonly foldersDropped = output<string[]>();
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
   * Emits `filesDropped` with the dropped files and `foldersDropped` with the dropped directories.
   * @param event - Native drop event.
   */
  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    if (this.disabled()) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.isDragging.set(false);
    const { files, folders } = partitionDrop(event.dataTransfer);
    if (files.length > 0) {
      this.filesDropped.emit(files);
    }
    if (folders.length > 0) {
      this.foldersDropped.emit(folders);
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

function partitionDrop(dataTransfer: DataTransfer | null): { files: File[]; folders: string[] } {
  const files: File[] = [];
  const folders: string[] = [];
  const items = dataTransfer?.items;
  if (!items) {
    return { files: Array.from(dataTransfer?.files ?? []), folders };
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    const file = item.getAsFile();
    if (entry?.isDirectory) {
      folders.push(entry.name || file?.name || 'folder');
      continue;
    }
    if (file) files.push(file);
  }
  return { files, folders };
}
