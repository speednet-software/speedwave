import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UserMessageComponent } from './user-message.component';

describe('UserMessageComponent', () => {
  let fixture: ComponentFixture<UserMessageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UserMessageComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(UserMessageComponent);
  });

  it('renders plain text content', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'Hello from the user' }]);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    expect(body.textContent).toContain('Hello from the user');
  });

  it('keeps the newlines of a multi-line text block', () => {
    fixture.componentRef.setInput('blocks', [
      { type: 'text', content: 'pierwsza linia\ndruga linia' },
    ]);
    fixture.detectChanges();

    const text = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"] [data-find-scope]'
    ) as HTMLElement;
    expect(text.textContent).toBe('pierwsza linia\ndruga linia');
    expect(text.classList).toContain('whitespace-pre-wrap');
  });

  it('renders multiple text blocks in order', () => {
    fixture.componentRef.setInput('blocks', [
      { type: 'text', content: 'First line' },
      { type: 'text', content: 'Second line' },
    ]);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    const firstIdx = body.textContent?.indexOf('First line') ?? -1;
    const secondIdx = body.textContent?.indexOf('Second line') ?? -1;
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('ignores non-text blocks (user messages only carry text)', () => {
    fixture.componentRef.setInput('blocks', [
      { type: 'text', content: 'visible' },
      { type: 'thinking', content: 'should be hidden', collapsed: true },
    ]);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    expect(body.textContent).toContain('visible');
    expect(body.textContent).not.toContain('should be hidden');
  });

  it('shows the edited badge when editedAt is set', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'hi' }]);
    fixture.componentRef.setInput('editedAt', 1_700_000_000_000);
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector(
      '[data-testid="user-message-edited"]'
    ) as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('edited');
  });

  it('hides the edited badge when editedAt is undefined', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'hi' }]);
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('[data-testid="user-message-edited"]');
    expect(badge).toBeNull();
  });

  it('renders with an empty body when no blocks are provided', () => {
    fixture.componentRef.setInput('blocks', []);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.textContent?.trim()).toBe('');
  });

  it('renders an image placeholder pill with the filename label when alt is set', () => {
    fixture.componentRef.setInput('blocks', [
      { type: 'text', content: 'See screenshot:' },
      { type: 'image', media_type: 'image/png', alt: 'screenshot.png' },
    ]);
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector(
      '[data-testid="user-message-image"]'
    ) as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain('screenshot.png');
    expect(pill.getAttribute('aria-label')).toBe('Image attachment');
  });

  it('falls back to a humanised MIME label when alt is missing (clipboard paste case)', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'image', media_type: 'image/png' }]);
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector(
      '[data-testid="user-message-image"]'
    ) as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain('PNG');
  });

  it('renders text and image blocks in the order they appear in the array', () => {
    fixture.componentRef.setInput('blocks', [
      { type: 'image', media_type: 'image/jpeg', alt: 'one.jpg' },
      { type: 'text', content: 'after image' },
    ]);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    const imgIdx = body.textContent?.indexOf('one.jpg') ?? -1;
    const textIdx = body.textContent?.indexOf('after image') ?? -1;
    expect(imgIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(imgIdx);
  });

  it('renders a file pill with the filename and its size', () => {
    fixture.componentRef.setInput('blocks', [
      { type: 'text', content: 'Summarize:' },
      { type: 'file', filename: 'raport końcowy.xlsx', size_bytes: 3_145_728 },
    ]);
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector(
      '[data-testid="user-message-file"]'
    ) as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain('raport końcowy.xlsx');
    expect(pill.textContent).toContain('3.0 MB');
    expect(pill.getAttribute('aria-label')).toBe('File attachment');
    expect(pill.getAttribute('title')).toBe('raport końcowy.xlsx (3.0 MB)');
  });

  it('renders a chip block with the control-chip testid', () => {
    fixture.componentRef.setInput('blocks', [
      { type: 'chip', command: 'model', argument: 'claude-sonnet-5' },
    ]);
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('[data-testid="control-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent?.trim()).toBe('model -> sonnet-5');
  });

  it('renders a turn_origin block as the source of a turn Claude Code started', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'turn_origin', origin: 'task_notification' }]);
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-testid="turn-origin"]') as HTMLElement;
    expect(row.textContent?.trim()).toBe('background task finished');
    expect(row.getAttribute('data-origin')).toBe('task_notification');

    fixture.componentRef.setInput('blocks', [{ type: 'turn_origin', origin: 'scheduled' }]);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="turn-origin"]')?.textContent?.trim()
    ).toBe('scheduled task');
  });
});
