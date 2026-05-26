import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AttachmentStripComponent, type AttachmentViewModel } from './attachment-strip.component';

function vm(overrides: Partial<AttachmentViewModel> = {}): AttachmentViewModel {
  return {
    id: 'att-1',
    filename: 'screenshot.png',
    previewUrl: 'blob:fake',
    encodedSizeBytes: 1024,
    preprocessing: false,
    ...overrides,
  };
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
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeTruthy();
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
});
