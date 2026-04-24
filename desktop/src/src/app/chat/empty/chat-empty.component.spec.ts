import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatEmptyComponent } from './chat-empty.component';

describe('ChatEmptyComponent', () => {
  let component: ChatEmptyComponent;
  let fixture: ComponentFixture<ChatEmptyComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatEmptyComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatEmptyComponent);
    component = fixture.componentInstance;
  });

  it('renders the default hint when no input is provided', () => {
    fixture.detectChanges();

    const hint = fixture.nativeElement.querySelector('[data-testid="chat-empty-hint"]');
    expect(hint?.textContent?.trim()).toBe('Type a message to start');
  });

  it('renders the custom hint when supplied', () => {
    component.hint = 'No messages yet — ask speedwave anything.';
    fixture.detectChanges();

    const hint = fixture.nativeElement.querySelector('[data-testid="chat-empty-hint"]');
    expect(hint?.textContent?.trim()).toBe('No messages yet — ask speedwave anything.');
  });

  it('applies the dashed-border card layout from the design system', () => {
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="chat-empty"]') as HTMLElement;
    expect(card.className).toContain('border-dashed');
    expect(card.className).toContain('border-line-strong');
    expect(card.className).toContain('text-center');
  });

  it('renders the `// empty` header in mono / uppercase / muted ink', () => {
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="chat-empty"]') as HTMLElement;
    const header = card.querySelector('div');
    expect(header?.textContent?.trim()).toBe('// empty');
    expect(header?.className).toContain('mono');
    expect(header?.className).toContain('uppercase');
    expect(header?.className).toContain('text-ink-mute');
  });

  it('applies role="status" on the host for accessibility', () => {
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('status');
  });

  it('renders an empty-string hint without throwing', () => {
    component.hint = '';
    fixture.detectChanges();

    const hint = fixture.nativeElement.querySelector('[data-testid="chat-empty-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent?.trim()).toBe('');
  });
});
