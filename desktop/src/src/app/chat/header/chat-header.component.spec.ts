import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatHeaderComponent } from './chat-header.component';

describe('ChatHeaderComponent', () => {
  let fixture: ComponentFixture<ChatHeaderComponent>;
  let component: ChatHeaderComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatHeaderComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatHeaderComponent);
    component = fixture.componentInstance;
  });

  // ── Happy path — title rendering ──────────────────────────────────────

  it('renders the title', () => {
    component.title = 'Refactoring container runtime';
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
    component.projectName = 'speedwave';
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-project"]'
    ) as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.textContent?.trim()).toBe('speedwave');
  });

  it('hides project pill when projectName is empty', () => {
    component.projectName = '';
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector('[data-testid="chat-header-project"]');
    expect(pill).toBeNull();
  });

  // ── Toggle buttons — emission ────────────────────────────────────────

  it('emits toggleMemory when memory button is clicked', () => {
    fixture.detectChanges();
    let emitted = 0;
    component.toggleMemory.subscribe(() => emitted++);

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-memory"]'
    ) as HTMLButtonElement;
    btn.click();

    expect(emitted).toBe(1);
  });

  it('emits toggleHistory when history button is clicked', () => {
    fixture.detectChanges();
    let emitted = 0;
    component.toggleHistory.subscribe(() => emitted++);

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-history"]'
    ) as HTMLButtonElement;
    btn.click();

    expect(emitted).toBe(1);
  });

  // ── ARIA aria-pressed reflects toggle state ──────────────────────────

  it('sets aria-pressed=true on memory button when memoryOpen is true', () => {
    component.memoryOpen = true;
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
    component.historyOpen = true;
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
    component.title = 'Σφαῖρα — тест 漢字';
    fixture.detectChanges();
    const titleEl = fixture.nativeElement.querySelector(
      '[data-testid="chat-header-title"]'
    ) as HTMLElement;
    expect(titleEl.textContent?.trim()).toBe('Σφαῖρα — тест 漢字');
  });
});
