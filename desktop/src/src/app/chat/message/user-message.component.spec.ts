import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UserMessageComponent } from './user-message.component';

describe('UserMessageComponent', () => {
  let fixture: ComponentFixture<UserMessageComponent>;
  let component: UserMessageComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UserMessageComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(UserMessageComponent);
    component = fixture.componentInstance;
  });

  // ── Happy path — text rendering ─────────────────────────────────────

  it('renders plain text content', () => {
    component.blocks = [{ type: 'text', content: 'Hello from the user' }];
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    expect(body.textContent).toContain('Hello from the user');
  });

  it('renders multiple text blocks in order', () => {
    component.blocks = [
      { type: 'text', content: 'First line' },
      { type: 'text', content: 'Second line' },
    ];
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
    component.blocks = [
      { type: 'text', content: 'visible' },
      { type: 'thinking', content: 'should be hidden', collapsed: true },
    ];
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    expect(body.textContent).toContain('visible');
    expect(body.textContent).not.toContain('should be hidden');
  });

  // ── Edited badge ────────────────────────────────────────────────────

  it('shows the edited badge when editedAt is set', () => {
    component.blocks = [{ type: 'text', content: 'hi' }];
    component.editedAt = 1_700_000_000_000;
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector(
      '[data-testid="user-message-edited"]'
    ) as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('edited');
  });

  it('hides the edited badge when editedAt is undefined', () => {
    component.blocks = [{ type: 'text', content: 'hi' }];
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('[data-testid="user-message-edited"]');
    expect(badge).toBeNull();
  });

  // ── Timestamp formatting ─────────────────────────────────────────────

  it('renders the formatted timestamp when non-zero', () => {
    const date = new Date(2026, 3, 25, 14, 5, 0, 0);
    component.blocks = [{ type: 'text', content: 'hi' }];
    component.timestamp = date.getTime();
    fixture.detectChanges();

    const timeEl = fixture.nativeElement.querySelector(
      '[data-testid="user-message-time"]'
    ) as HTMLElement | null;
    expect(timeEl).not.toBeNull();
    expect(timeEl?.textContent?.trim()).toBe('14:05');
  });

  it('omits the time segment when timestamp is 0 (sentinel for unknown)', () => {
    component.blocks = [{ type: 'text', content: 'hi' }];
    component.timestamp = 0;
    fixture.detectChanges();

    const timeEl = fixture.nativeElement.querySelector('[data-testid="user-message-time"]');
    expect(timeEl).toBeNull();
  });

  // ── Edge case — empty blocks ─────────────────────────────────────────

  it('renders with an empty body when no blocks are provided', () => {
    component.blocks = [];
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector(
      '[data-testid="user-message-body"]'
    ) as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.textContent?.trim()).toBe('');
  });
});
