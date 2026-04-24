import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComposerComponent } from './composer.component';

describe('ComposerComponent', () => {
  let fixture: ComponentFixture<ComposerComponent>;
  let component: ComposerComponent;
  let rootEl: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComposerComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ComposerComponent);
    component = fixture.componentInstance;
    rootEl = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  function textarea(): HTMLTextAreaElement {
    const el = rootEl.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
    if (!el) throw new Error('textarea not rendered');
    return el;
  }

  function sendButton(): HTMLButtonElement {
    const el = rootEl.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
    if (!el) throw new Error('send button not rendered');
    return el;
  }

  function slashButton(): HTMLButtonElement {
    const el = rootEl.querySelector<HTMLButtonElement>('[data-testid="composer-slash"]');
    if (!el) throw new Error('slash button not rendered');
    return el;
  }

  // ── happy path ──────────────────────────────────────────────────────────
  describe('happy path — submit', () => {
    it('emits submitted(value) and resets form when Enter is pressed without Shift', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v));
      component.text.setValue('hello claude');
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      textarea().dispatchEvent(event);

      expect(preventSpy).toHaveBeenCalled();
      expect(emitted).toEqual(['hello claude']);
      expect(component.text.value).toBe('');
    });

    it('emits submitted(value) when send button is clicked', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v));
      component.text.setValue('ping');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual(['ping']);
    });

    it('trims whitespace before emitting', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v));
      component.text.setValue('  hello  ');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual(['hello']);
    });
  });

  // ── Shift+Enter inserts newline ─────────────────────────────────────────
  describe('Shift+Enter', () => {
    it('does NOT submit when Shift+Enter is pressed', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v));
      component.text.setValue('line one');
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      textarea().dispatchEvent(event);

      expect(preventSpy).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
      expect(component.text.value).toBe('line one');
    });
  });

  // ── edge cases ──────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('does not emit when submitting empty text', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v));
      component.text.setValue('');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual([]);
    });

    it('does not emit when submitting whitespace-only text', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v));
      component.text.setValue('   \n  ');
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual([]);
    });

    it('handles very long text', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v));
      const longText = 'x'.repeat(10_000);
      component.text.setValue(longText);
      fixture.detectChanges();

      sendButton().click();

      expect(emitted).toEqual([longText]);
    });
  });

  // ── disabled state ──────────────────────────────────────────────────────
  describe('disabled state', () => {
    it('prevents submission via Enter when disabled', () => {
      const emitted: string[] = [];
      component.submitted.subscribe((v) => emitted.push(v));
      fixture.componentRef.setInput('disabled', true);
      component.text.setValue('blocked');
      fixture.detectChanges();

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
      textarea().dispatchEvent(event);

      expect(emitted).toEqual([]);
      expect(component.text.value).toBe('blocked');
    });

    it('send button is disabled when text is empty', () => {
      component.text.setValue('');
      fixture.detectChanges();
      expect(sendButton().hasAttribute('disabled')).toBe(true);
    });

    it('send button is disabled when disabled input is true', () => {
      fixture.componentRef.setInput('disabled', true);
      component.text.setValue('ready');
      fixture.detectChanges();
      expect(sendButton().hasAttribute('disabled')).toBe(true);
    });

    it('send button is enabled when text is present and not disabled', () => {
      component.text.setValue('ready');
      fixture.detectChanges();
      expect(sendButton().hasAttribute('disabled')).toBe(false);
    });

    it('textarea disabled attribute reflects disabled input', () => {
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      expect(textarea().hasAttribute('disabled')).toBe(true);

      fixture.componentRef.setInput('disabled', false);
      fixture.detectChanges();
      expect(textarea().hasAttribute('disabled')).toBe(false);
    });
  });

  // ── queued message badge ────────────────────────────────────────────────
  describe('queued message', () => {
    it('renders queued badge with preview text when queuedMessage is non-empty', () => {
      fixture.componentRef.setInput('queuedMessage', 'pending text');
      fixture.detectChanges();

      const badge = rootEl.querySelector('[data-testid="composer-queued"]');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('pending text');
    });

    it('hides queued badge when queuedMessage is empty', () => {
      fixture.componentRef.setInput('queuedMessage', '');
      fixture.detectChanges();

      expect(rootEl.querySelector('[data-testid="composer-queued"]')).toBeNull();
    });

    it('emits cancelQueued when cancel button is clicked', () => {
      let cancelled = false;
      component.cancelQueued.subscribe(() => {
        cancelled = true;
      });
      fixture.componentRef.setInput('queuedMessage', 'pending');
      fixture.detectChanges();

      const cancelBtn = rootEl.querySelector<HTMLButtonElement>(
        '[data-testid="composer-queued-cancel"]'
      );
      cancelBtn?.click();

      expect(cancelled).toBe(true);
    });
  });

  // ── slash menu trigger ──────────────────────────────────────────────────
  describe('slash menu trigger', () => {
    it('emits slashOpened when typing `/` at position 0', () => {
      const events: { caretPos: number }[] = [];
      component.slashOpened.subscribe((e) => events.push(e));
      const ta = textarea();
      ta.value = '/';
      ta.setSelectionRange(1, 1);
      ta.dispatchEvent(new Event('input'));

      expect(events.length).toBe(1);
      expect(events[0].caretPos).toBe(1);
    });

    it('emits slashOpened when typing `/` after leading whitespace', () => {
      const events: { caretPos: number }[] = [];
      component.slashOpened.subscribe((e) => events.push(e));
      const ta = textarea();
      ta.value = '  /';
      ta.setSelectionRange(3, 3);
      ta.dispatchEvent(new Event('input'));

      expect(events.length).toBe(1);
    });

    it('does NOT emit slashOpened when `/` appears mid-sentence', () => {
      const events: { caretPos: number }[] = [];
      component.slashOpened.subscribe((e) => events.push(e));
      const ta = textarea();
      ta.value = 'hello /';
      ta.setSelectionRange(7, 7);
      ta.dispatchEvent(new Event('input'));

      expect(events.length).toBe(0);
    });

    it('emits slashOpened when user types partial command at start', () => {
      const events: { caretPos: number }[] = [];
      component.slashOpened.subscribe((e) => events.push(e));
      const ta = textarea();
      ta.value = '/rev';
      ta.setSelectionRange(4, 4);
      ta.dispatchEvent(new Event('input'));

      expect(events.length).toBe(1);
    });

    it('emits slashOpened when slash toolbar button is clicked and inserts `/`', () => {
      const events: { caretPos: number }[] = [];
      component.slashOpened.subscribe((e) => events.push(e));

      slashButton().click();

      expect(events.length).toBe(1);
      expect(component.text.value).toBe('/');
    });

    it('slash button click does nothing when disabled', () => {
      const events: { caretPos: number }[] = [];
      component.slashOpened.subscribe((e) => events.push(e));
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();

      slashButton().click();

      expect(events.length).toBe(0);
    });
  });

  // ── ARIA ────────────────────────────────────────────────────────────────
  describe('ARIA', () => {
    it('textarea has aria-label "Compose message"', () => {
      expect(textarea().getAttribute('aria-label')).toBe('Compose message');
    });

    it('send button has aria-label "Send"', () => {
      expect(sendButton().getAttribute('aria-label')).toBe('Send');
    });

    it('queued cancel button has aria-label', () => {
      fixture.componentRef.setInput('queuedMessage', 'pending');
      fixture.detectChanges();

      const cancelBtn = rootEl.querySelector<HTMLButtonElement>(
        '[data-testid="composer-queued-cancel"]'
      );
      expect(cancelBtn?.getAttribute('aria-label')).toBe('Cancel queued message');
    });
  });

  // ── placeholder input ───────────────────────────────────────────────────
  describe('placeholder', () => {
    it('uses default placeholder when none provided', () => {
      expect(textarea().getAttribute('placeholder')).toBe('Message Claude...');
    });

    it('honors custom placeholder input', () => {
      fixture.componentRef.setInput('placeholder', 'say something');
      fixture.detectChanges();
      expect(textarea().getAttribute('placeholder')).toBe('say something');
    });
  });
});
