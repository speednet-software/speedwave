import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatHeaderComponent } from './chat-header.component';

describe('ChatHeaderComponent', () => {
  let fixture: ComponentFixture<ChatHeaderComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatHeaderComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatHeaderComponent);
  });

  // ── Happy path — title rendering ──────────────────────────────────────

  it('renders the title', () => {
    fixture.componentRef.setInput('title', 'Refactoring container runtime');
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

  // ── Project pill ──────────────────────────────────────────────────────

  it('renders project pill when projectName is set', () => {
    fixture.componentRef.setInput('projectName', 'speedwave');
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-project"]'
    ) as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain('speedwave');
  });

  it('renders the violet monogram square with the project initials', () => {
    fixture.componentRef.setInput('projectName', 'speedwave');
    fixture.detectChanges();
    const pill = fixture.nativeElement.querySelector('[data-testid="chat-header-project"]');
    expect(pill.querySelector('span')?.textContent?.trim()).toBe('sp');
  });

  it('hides project pill when projectName is empty', () => {
    fixture.detectChanges();
    const pill = fixture.nativeElement.querySelector('[data-testid="chat-header-project"]');
    expect(pill).toBeNull();
  });

  // ── Toggle buttons — emission ────────────────────────────────────────

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

  it('emits openProjectSwitcher when the project pill is clicked', () => {
    fixture.componentRef.setInput('projectName', 'speedwave');
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.openProjectSwitcher.subscribe(() => emitted++);

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-project"]'
    ) as HTMLButtonElement;
    btn.click();
    expect(emitted).toBe(1);
  });

  // ── ARIA aria-pressed reflects toggle state ──────────────────────────

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

  // ── Edge case — Unicode and long titles render unchanged ────────────

  it('renders Unicode characters in title verbatim', () => {
    fixture.componentRef.setInput('title', 'Σφαῖρα — тест 漢字');
    fixture.detectChanges();
    const titleEl = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-title"]'
    ) as HTMLElement;
    expect(titleEl.textContent?.trim()).toBe('Σφαῖρα — тест 漢字');
  });
});
