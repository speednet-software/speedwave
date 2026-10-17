import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FileDropDirective, partitionItems, type DroppedItems } from './file-drop.directive';
import { fakeDataTransfer, makeDragEvent } from '../../testing/drag-events';

@Component({
  selector: 'app-file-drop-host-test',
  imports: [FileDropDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div appFileDrop #drop="appFileDrop" [disabled]="disabled" (dropped)="onDropped($event)">
      <span class="child">child</span>
      <span class="child2">child2</span>
    </div>
  `,
})
class HostComponent {
  disabled = false;
  drops: DroppedItems[] = [];
  onDropped(items: DroppedItems): void {
    this.drops.push(items);
  }
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

  it('emits dropped once with the dropped File objects', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    dropTarget.dispatchEvent(makeDragEvent('drop', [file]));
    expect(host.drops).toHaveLength(1);
    expect(host.drops[0].files.map((f) => f.name)).toEqual(['a.png']);
    expect(host.drops[0].folders).toEqual([]);
  });

  it('ignores drag events that do not carry Files', () => {
    dropTarget.dispatchEvent(makeDragEvent('dragenter'));
    dropTarget.dispatchEvent(makeDragEvent('dragenter'));
    dropTarget.dispatchEvent(makeDragEvent('drop'));
    expect(host.drops).toEqual([]);
  });

  it('keeps isDragging true while the cursor crosses internal children (dragDepth counter)', () => {
    const directive = fixture.debugElement
      .query((de) => de.name === 'div')
      .injector.get(FileDropDirective);
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    dropTarget.dispatchEvent(makeDragEvent('dragenter', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragenter', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragleave', [file]));
    expect(directive.isDragging()).toBe(true);
    dropTarget.dispatchEvent(makeDragEvent('dragleave', [file]));
    expect(directive.isDragging()).toBe(false);
    dropTarget.dispatchEvent(makeDragEvent('drop', [file]));
    expect(host.drops).toHaveLength(1);
  });

  it('drops are no-op when disabled', () => {
    const disabledFixture = TestBed.createComponent(HostComponent);
    disabledFixture.componentInstance.disabled = true;
    disabledFixture.detectChanges();
    const target = disabledFixture.nativeElement.querySelector('[appFileDrop]') as HTMLElement;
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    target.dispatchEvent(makeDragEvent('drop', [file]));
    expect(disabledFixture.componentInstance.drops).toEqual([]);
  });

  it('drop with multiple files emits all of them in order', () => {
    const files = [
      new File(['1'], 'one.png', { type: 'image/png' }),
      new File(['2'], 'two.jpg', { type: 'image/jpeg' }),
      new File(['3'], 'three.gif', { type: 'image/gif' }),
    ];
    dropTarget.dispatchEvent(makeDragEvent('drop', files));
    expect(host.drops[0].files.map((f) => f.name)).toEqual(['one.png', 'two.jpg', 'three.gif']);
  });

  it('emits files and directories of one drop together', () => {
    const file = new File(['x'], 'notes.pdf', { type: 'application/pdf' });

    dropTarget.dispatchEvent(makeDragEvent('drop', [file, { directory: 'docs' }]));

    expect(host.drops).toHaveLength(1);
    expect(host.drops[0].files.map((f) => f.name)).toEqual(['notes.pdf']);
    expect(host.drops[0].folders).toEqual(['docs']);
  });

  it('emits a drop that carried only directories, with no files', () => {
    dropTarget.dispatchEvent(makeDragEvent('drop', [{ directory: 'docs' }]));

    expect(host.drops).toEqual([{ files: [], folders: ['docs'] }]);
  });
});

describe('partitionItems', () => {
  it('returns nothing for an event without items', () => {
    expect(partitionItems(undefined)).toEqual({ files: [], folders: [] });
  });

  it('treats a file whose entry the engine cannot resolve as a file', () => {
    const file = new File(['x'], 'image.png', { type: 'image/png' });

    const items = partitionItems(fakeDataTransfer([{ withoutEntry: file }]).items);

    expect(items).toEqual({ files: [file], folders: [] });
  });

  it('skips items that are not files', () => {
    const file = new File(['x'], 'kept.txt', { type: 'text/plain' });

    const items = partitionItems(fakeDataTransfer([{ text: 'ignored' }, file]).items);

    expect(items.files).toEqual([file]);
  });

  it('keeps the order of files and directories', () => {
    const a = new File(['a'], 'a.txt');
    const b = new File(['b'], 'b.txt');

    const items = partitionItems(
      fakeDataTransfer([a, { directory: 'one' }, b, { directory: 'two' }]).items
    );

    expect(items.files).toEqual([a, b]);
    expect(items.folders).toEqual(['one', 'two']);
  });
});
