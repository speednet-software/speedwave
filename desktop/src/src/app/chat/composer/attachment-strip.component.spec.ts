import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AttachmentStripComponent, type AttachmentViewModel } from './attachment-strip.component';

function vm(overrides: Partial<AttachmentViewModel> = {}): AttachmentViewModel {
  return {
    id: 'att-1',
    filename: 'screenshot.png',
    kind: 'image',
    previewUrl: 'blob:fake',
    encodedSizeBytes: 1024,
    preprocessing: false,
    ...overrides,
  };
}

function fileVm(overrides: Partial<AttachmentViewModel> = {}): AttachmentViewModel {
  return vm({
    id: 'att-2',
    filename: 'notes.pdf',
    kind: 'file',
    previewUrl: '',
    encodedSizeBytes: 2048,
    ...overrides,
  });
}

describe('AttachmentStripComponent', () => {
  it('renders nothing when attachments is empty', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', []);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="composer-attachment-strip"]')
    ).toBeNull();
  });

  it('renders one thumbnail per attachment with the right alt text', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [
      vm({ id: 'a', filename: 'one.png' }),
      vm({ id: 'b', filename: 'two.jpg' }),
    ]);
    fixture.detectChanges();
    const imgs = fixture.nativeElement.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    expect(imgs[0].alt).toBe('one.png');
    expect(imgs[1].alt).toBe('two.jpg');
  });

  it('emits remove(id) when the X button is clicked', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [vm({ id: 'kill-me' })]);
    fixture.detectChanges();

    const seen: string[] = [];
    fixture.componentInstance.remove.subscribe((id) => seen.push(id));
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="composer-attachment-remove"]'
    ) as HTMLButtonElement;
    btn.click();
    expect(seen).toEqual(['kill-me']);
  });

  it('shows spinner overlay for entries that are still preprocessing', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [vm({ preprocessing: true })]);
    fixture.detectChanges();
    const overlay = fixture.nativeElement.querySelector('[role="status"]');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('app-spin-icon')).toBeTruthy();
  });

  it('omits spinner once preprocessing settles', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [vm({ preprocessing: false })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
  });

  it('aria-label on the remove button names the file (for screen readers)', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [vm({ filename: 'diagram.webp' })]);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="composer-attachment-remove"]');
    expect(btn.getAttribute('aria-label')).toBe('Remove image diagram.webp');
  });

  it('formats bytes in the title attribute (B / KB / MB)', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    const cmp = fixture.componentInstance;
    expect(cmp.formatBytes(500)).toBe('500 B');
    expect(cmp.formatBytes(2048)).toBe('2 KB');
    expect(cmp.formatBytes(3_145_728)).toBe('3.0 MB');
  });

  it('renders a file as a name-and-size pill instead of a thumbnail', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [fileVm()]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    const pill = fixture.nativeElement.querySelector(
      '[data-testid="composer-attachment-file"]'
    ) as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain('notes.pdf');
    expect(pill.textContent).toContain('2 KB');
    expect(pill.getAttribute('title')).toBe('notes.pdf (2 KB)');
  });

  it('renders image thumbnails and file pills side by side in input order', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [vm({ id: 'a' }), fileVm({ id: 'b' })]);
    fixture.detectChanges();
    const items = fixture.nativeElement.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('img')).not.toBeNull();
    expect(items[1].querySelector('[data-testid="composer-attachment-file"]')).not.toBeNull();
  });

  it('aria-label on the remove button names a file as a file', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [fileVm()]);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="composer-attachment-remove"]');
    expect(btn.getAttribute('aria-label')).toBe('Remove file notes.pdf');
  });

  it('shows the spinner overlay over a file pill that is still uploading', () => {
    const fixture = TestBed.configureTestingModule({
      imports: [AttachmentStripComponent],
    }).createComponent(AttachmentStripComponent);
    fixture.componentRef.setInput('attachments', [fileVm({ preprocessing: true })]);
    fixture.detectChanges();
    const overlay = fixture.nativeElement.querySelector('[role="status"]');
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute('aria-label')).toBe('Preparing notes.pdf');
  });
});
