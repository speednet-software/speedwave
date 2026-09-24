import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ChatHeaderComponent } from './chat-header.component';
import { BetaService } from '../../services/beta.service';

describe('ChatHeaderComponent', () => {
  let fixture: ComponentFixture<ChatHeaderComponent>;
  let betaEnabled: ReturnType<typeof signal<boolean>>;

  beforeEach(async () => {
    betaEnabled = signal(false);
    await TestBed.configureTestingModule({
      imports: [ChatHeaderComponent],
      providers: [{ provide: BetaService, useValue: { enabled: betaEnabled.asReadonly() } }],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatHeaderComponent);
  });

  it('renders the title', () => {
    fixture.componentRef.setInput('viewTitle', 'Refactoring container runtime');
    fixture.detectChanges();

    const titleEl = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-title"]'
    ) as HTMLElement;
    expect(titleEl).not.toBeNull();
    expect(titleEl.textContent?.trim()).toBe('Refactoring container runtime');
  });

  it('uses default title when none provided', () => {
    fixture.detectChanges();
    const titleEl = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-title"]'
    ) as HTMLElement;
    expect(titleEl.textContent?.trim()).toBe('Chat');
  });

  it('renders the shared project pill component', () => {
    fixture.detectChanges();
    const pill = fixture.nativeElement.querySelector('app-project-pill');
    expect(pill).not.toBeNull();
  });

  it('shows conversation controls in full (default) mode', () => {
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="chat-header-history"]')
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="chat-header-memory"]')
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="chat-header-new"]')).not.toBeNull();
  });

  it('hides conversation controls in compact mode but keeps title + pill', () => {
    fixture.componentRef.setInput('compact', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="chat-header-history"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="chat-header-memory"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="chat-header-new"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="chat-header-title"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-project-pill')).not.toBeNull();
  });

  it('emits toggleMemory when memory button is clicked', () => {
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.toggleMemory.subscribe(() => emitted++);

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-memory"]'
    ) as HTMLButtonElement;
    btn.click();

    expect(emitted).toBe(1);
  });

  it('emits toggleHistory when hamburger button is clicked', () => {
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.toggleHistory.subscribe(() => emitted++);

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-history"]'
    ) as HTMLButtonElement;
    btn.click();

    expect(emitted).toBe(1);
  });

  it('emits newConversation when plus button is clicked', () => {
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.newConversation.subscribe(() => emitted++);

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-new"]'
    ) as HTMLButtonElement;
    btn.click();
    expect(emitted).toBe(1);
  });

  it('sets aria-pressed=true on memory button when memoryOpen is true', () => {
    fixture.componentRef.setInput('memoryOpen', true);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-memory"]'
    ) as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('sets aria-pressed=false on memory button when memoryOpen is false (default)', () => {
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-memory"]'
    ) as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('sets aria-pressed=true on history button when historyOpen is true', () => {
    fixture.componentRef.setInput('historyOpen', true);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-history"]'
    ) as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('sets aria-pressed=false on history button when historyOpen is false (default)', () => {
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-history"]'
    ) as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders Unicode characters in title verbatim', () => {
    fixture.componentRef.setInput('viewTitle', 'Σφαῖρα — тест 漢字');
    fixture.detectChanges();
    const titleEl = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-title"]'
    ) as HTMLElement;
    expect(titleEl.textContent?.trim()).toBe('Σφαῖρα — тест 漢字');
  });

  describe('inline tab strip', () => {
    it('is hidden when beta is disabled, even in full mode', () => {
      betaEnabled.set(false);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-chat-tabs')).toBeNull();
    });

    it('is shown inline between the title and the project pill when beta is enabled', () => {
      betaEnabled.set(true);
      fixture.detectChanges();

      const tabs = fixture.nativeElement.querySelector('app-chat-tabs');
      expect(tabs).not.toBeNull();
      const titleEl = fixture.nativeElement.querySelector(
        '[data-testid="chat-header-title"]'
      ) as HTMLElement;
      expect(titleEl.nextElementSibling).toBe(tabs);
      const pillContainer = fixture.nativeElement.querySelector('app-project-pill')
        ?.parentElement as HTMLElement;
      expect(tabs.nextElementSibling).toBe(pillContainer);
    });

    it('stays hidden in compact mode even when beta is enabled (no live chat to show tabs for)', () => {
      betaEnabled.set(true);
      fixture.componentRef.setInput('compact', true);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('app-chat-tabs')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-project-pill')).not.toBeNull();
    });
  });
});
