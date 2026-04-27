import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatEmptyComponent } from './chat-empty.component';

describe('ChatEmptyComponent', () => {
  let fixture: ComponentFixture<ChatEmptyComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatEmptyComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatEmptyComponent);
  });

  it('renders the default hint when no input is provided', () => {
    fixture.detectChanges();

    const hint = fixture.nativeElement.querySelector('[data-testid="chat-empty-hint"]');
    expect(hint?.textContent?.trim()).toBe('No messages yet — ask speedwave anything.');
  });

  it('renders the custom hint when supplied', () => {
    fixture.componentRef.setInput('hint', 'No messages yet — ask speedwave anything.');
    fixture.detectChanges();

    const hint = fixture.nativeElement.querySelector('[data-testid="chat-empty-hint"]');
    expect(hint?.textContent?.trim()).toBe('No messages yet — ask speedwave anything.');
  });

  it('applies the dashed-border card layout from the design system', () => {
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="chat-empty"]') as HTMLElement;
    expect(card.className).toContain('border-dashed');
    expect(card.className).toContain('border-[var(--line)]');
    expect(card.className).toContain('text-center');
  });

  it('renders the `empty` header in mono / uppercase / muted ink', () => {
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="chat-empty"]') as HTMLElement;
    const header = card.querySelector('div');
    expect(header?.textContent?.trim()).toBe('empty');
    expect(header?.className).toContain('mono');
    expect(header?.className).toContain('uppercase');
    expect(header?.className).toContain('text-[var(--ink-mute)]');
  });

  it('applies role="region" + aria-label on the host (static placeholder, not a live region)', () => {
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('region');
    expect(host.getAttribute('aria-label')).toBe('Empty conversation');
  });

  it('renders an empty-string hint without throwing', () => {
    fixture.componentRef.setInput('hint', '');
    fixture.detectChanges();

    const hint = fixture.nativeElement.querySelector('[data-testid="chat-empty-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent?.trim()).toBe('');
  });
});
