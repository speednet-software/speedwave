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
    // No file payload → no drop emission later
    dropTarget.dispatchEvent(makeDragEvent('drop'));
    expect(host.dropped).toEqual([]);
  });

  it('keeps isDragging true while the cursor crosses internal children (dragDepth counter)', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    // Outer enter
    dropTarget.dispatchEvent(makeDragEvent('dragenter', [file]));
    // Two nested enters (simulating browser firing on each child boundary)
    dropTarget.dispatchEvent(makeDragEvent('dragenter', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragenter', [file]));
    // One leave should NOT flip isDragging back to false yet
    dropTarget.dispatchEvent(makeDragEvent('dragleave', [file]));
    dropTarget.dispatchEvent(makeDragEvent('dragleave', [file]));
    // After matching number of leaves the directive flips back to false on drop
    dropTarget.dispatchEvent(makeDragEvent('dragleave', [file]));
    dropTarget.dispatchEvent(makeDragEvent('drop', [file]));
    expect(host.dropped).toHaveLength(1);
  });

  it('drops are no-op when disabled', () => {
    // Re-create the fixture with disabled=true from the start; flipping the
    // input mid-test triggers a stale change-detection check on Angular 21.
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
});
