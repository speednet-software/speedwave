import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FileDropDirective } from './file-drop.directive';

@Component({
  selector: 'app-file-drop-host-test',
  imports: [FileDropDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div appFileDrop #drop="appFileDrop" [disabled]="disabled" (filesDropped)="onFiles($event)">
      <span class="child">child</span>
      <span class="child2">child2</span>
    </div>
  `,
})
class HostComponent {
  disabled = false;
  dropped: File[] = [];
  onFiles(files: File[]): void {
    this.dropped = files;
  }
}

function makeDragEvent(type: string, files: File[] = []): DragEvent {
  const dataTransfer = {
    types: files.length > 0 ? ['Files'] : [],
    files,
    dropEffect: 'none',
  };
  const ev = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, configurable: true });
  return ev;
}

describe('FileDropDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let dropTarget: HTMLElement;

  beforeEach(() => {
    fixture = TestBed.configureTestingModule({
      imports: [HostComponent],
    }).createComponent(HostComponent);
    fixture.detectChanges();
    host = fixture.componentInstance;
    dropTarget = fixture.nativeElement.querySelector('[appFileDrop]') as HTMLElement;
  });

  it('emits filesDropped with dropped File objects', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    dropTarget.dispatchEvent(makeDragEvent('drop', [file]));
    expect(host.dropped).toHaveLength(1);
    expect(host.dropped[0].name).toBe('a.png');
  });

  it('ignores drag events that do not carry Files', () => {
    dropTarget.dispatchEvent(makeDragEvent('dragenter'));
    dropTarget.dispatchEvent(makeDragEvent('dragenter'));
    dropTarget.dispatchEvent(makeDragEvent('drop'));
    expect(host.dropped).toEqual([]);
  });

  it('keeps isDragging true while the cursor crosses internal children (dragDepth counter)', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    dropTarget.dispatchEvent(makeDragEvent('dragenter', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragenter', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragenter', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragleave', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragleave', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragleave', [file]));
    dropTarget.dispatchEvent(makeDragEvent('drop', [file]));
    expect(host.dropped).toHaveLength(1);
  });

  it('drops are no-op when disabled', () => {
    const disabledFixture = TestBed.createComponent(HostComponent);
    disabledFixture.componentInstance.disabled = true;
    disabledFixture.detectChanges();
    const target = disabledFixture.nativeElement.querySelector('[appFileDrop]') as HTMLElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    target.dispatchEvent(makeDragEvent('drop', [file]));
    expect(disabledFixture.componentInstance.dropped).toEqual([]);
  });

  it('drop with multiple files emits all of them in order', () => {
    const files = [
      new File(['1'], 'one.png', { type: 'image/png' }),
      new File(['2'], 'two.jpg', { type: 'image/jpeg' }),
      new File(['3'], 'three.gif', { type: 'image/gif' }),
    ];
    dropTarget.dispatchEvent(makeDragEvent('drop', files));
    expect(host.dropped.map((f) => f.name)).toEqual(['one.png', 'two.jpg', 'three.gif']);
  });

  describe('drops carrying DataTransfer items', () => {
    interface ItemSpec {
      file: File;
      kind?: string;
      directory?: boolean;
      withoutEntryApi?: boolean;
    }

    function makeItemsDropEvent(specs: ItemSpec[]): DragEvent {
      const items = specs.map(({ file, kind, directory, withoutEntryApi }) => ({
        kind: kind ?? 'file',
        type: file.type,
        getAsFile: () => file,
        ...(withoutEntryApi
          ? {}
          : {
              webkitGetAsEntry: () => ({
                isDirectory: directory === true,
                isFile: directory !== true,
                name: file.name,
              }),
            }),
      }));
      const dataTransfer = {
        types: ['Files'],
        files: specs.map((s) => s.file),
        items,
        dropEffect: 'none',
      };
      const ev = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, configurable: true });
      return ev;
    }

    it('routes directories to foldersDropped and files to filesDropped', () => {
      const folders: string[][] = [];
      fixture.debugElement
        .query((de) => de.name === 'div')
        .injector.get(FileDropDirective)
        .foldersDropped.subscribe((names) => folders.push(names));
      const file = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
      const folder = new File([], 'docs', { type: '' });

      dropTarget.dispatchEvent(makeItemsDropEvent([{ file }, { file: folder, directory: true }]));

      expect(host.dropped.map((f) => f.name)).toEqual(['notes.pdf']);
      expect(folders).toEqual([['docs']]);
    });

    it('emits nothing on filesDropped when only directories were dropped', () => {
      const folder = new File([], 'docs', { type: '' });

      dropTarget.dispatchEvent(makeItemsDropEvent([{ file: folder, directory: true }]));

      expect(host.dropped).toEqual([]);
    });

    it('treats an item without the entry API as a file', () => {
      const file = new File(['x'], 'legacy.bin', { type: '' });

      dropTarget.dispatchEvent(makeItemsDropEvent([{ file, withoutEntryApi: true }]));

      expect(host.dropped.map((f) => f.name)).toEqual(['legacy.bin']);
    });

    it('skips items that are not files', () => {
      const file = new File(['x'], 'kept.txt', { type: 'text/plain' });
      const text = new File(['y'], 'ignored.txt', { type: 'text/plain' });

      dropTarget.dispatchEvent(makeItemsDropEvent([{ file: text, kind: 'string' }, { file }]));

      expect(host.dropped.map((f) => f.name)).toEqual(['kept.txt']);
    });
  });
});
