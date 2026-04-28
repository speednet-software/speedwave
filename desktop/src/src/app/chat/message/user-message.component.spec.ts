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

  // ── Happy path — text rendering ─────────────────────────────────────

  it('renders plain text content', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'Hello from the user' }]);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    expect(body.textContent).toContain('Hello from the user');
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

  // ── Edge case — non-text blocks are filtered out ────────────────────

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

  // ── Edited badge ────────────────────────────────────────────────────

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

  // ── Timestamp formatting ─────────────────────────────────────────────
  // The "user · HH:MM" header was removed from the bubble — identity comes
  // from right-alignment + bubble background, and the timestamp would have
  // duplicated info already present in the assistant's metadata row. So
  // there is no `user-message-time` element to assert against any more.

  // ── Edge case — empty blocks ─────────────────────────────────────────

  it('renders with an empty body when no blocks are provided', () => {
    fixture.componentRef.setInput('blocks', []);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.textContent?.trim()).toBe('');
  });
});
