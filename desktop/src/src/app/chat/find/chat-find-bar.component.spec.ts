import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatFindBarComponent } from './chat-find-bar.component';

describe('ChatFindBarComponent', () => {
  let fixture: ComponentFixture<ChatFindBarComponent>;
  let component: ChatFindBarComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ChatFindBarComponent] }).compileComponents();
    fixture = TestBed.createComponent(ChatFindBarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  function el<T extends HTMLElement>(testId: string): T {
    return fixture.nativeElement.querySelector(`[data-testid="${testId}"]`) as T;
  }

  function setInputs(inputs: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    fixture.detectChanges();
  }

  describe('counter', () => {
    it('shows nothing for an empty query', () => {
      setInputs({ query: '', total: 0 });
      expect(el('chat-find-count').textContent?.trim()).toBe('');
    });

    it('shows 0/0 for a query without matches', () => {
      setInputs({ query: 'zzz', total: 0 });
      expect(el('chat-find-count').textContent?.trim()).toBe('0/0');
    });

    it('shows 0/0 and marks the field invalid for a regex that does not compile', () => {
      setInputs({ query: '(', regex: true, invalid: true, total: 0 });
      expect(el('chat-find-count').textContent?.trim()).toBe('0/0');
      expect(el('chat-find-input').getAttribute('aria-invalid')).toBe('true');
    });

    it('shows a one-based current over the total', () => {
      setInputs({ query: 'a', current: 0, total: 7 });
      expect(el('chat-find-count').textContent?.trim()).toBe('1/7');
      setInputs({ current: 6 });
      expect(el('chat-find-count').textContent?.trim()).toBe('7/7');
    });

    it('is a polite live region', () => {
      expect(el('chat-find-count').getAttribute('aria-live')).toBe('polite');
    });
  });

  describe('toggles', () => {
    it('reflect their state through aria-pressed and emit on click', () => {
      let regexClicks = 0;
      let caseClicks = 0;
      component.regexToggled.subscribe(() => (regexClicks += 1));
      component.caseToggled.subscribe(() => (caseClicks += 1));
      setInputs({ regex: true, matchCase: false });

      expect(el('chat-find-regex').getAttribute('aria-pressed')).toBe('true');
      expect(el('chat-find-case').getAttribute('aria-pressed')).toBe('false');

      el('chat-find-regex').click();
      el('chat-find-case').click();
      expect(regexClicks).toBe(1);
      expect(caseClicks).toBe(1);
    });
  });

  describe('typing', () => {
    it('emits every change of the field', () => {
      const seen: string[] = [];
      component.queryChange.subscribe((q) => seen.push(q));
      const input = el<HTMLInputElement>('chat-find-input');
      input.value = 'ab';
      input.dispatchEvent(new Event('input'));
      expect(seen).toEqual(['ab']);
    });

    it('renders the query it is given', () => {
      setInputs({ query: 'from store' });
      expect(el<HTMLInputElement>('chat-find-input').value).toBe('from store');
    });
  });

  describe('navigation', () => {
    it('emits next and previous from the arrows, which are disabled without matches', () => {
      let next = 0;
      let prev = 0;
      component.next.subscribe(() => (next += 1));
      component.previous.subscribe(() => (prev += 1));
      setInputs({ query: 'a', total: 0 });
      expect(el<HTMLButtonElement>('chat-find-next').disabled).toBe(true);
      expect(el<HTMLButtonElement>('chat-find-prev').disabled).toBe(true);

      setInputs({ total: 2 });
      el('chat-find-next').click();
      el('chat-find-prev').click();
      expect(next).toBe(1);
      expect(prev).toBe(1);
    });

    it('Enter is next, Shift+Enter is previous, and neither bubbles past the bar', () => {
      let next = 0;
      let prev = 0;
      let reachedDocument = 0;
      component.next.subscribe(() => (next += 1));
      component.previous.subscribe(() => (prev += 1));
      document.addEventListener('keydown', () => (reachedDocument += 1), { once: false });
      const input = el('chat-find-input');

      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(enter);
      const shiftEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(shiftEnter);

      expect(next).toBe(1);
      expect(prev).toBe(1);
      expect(enter.defaultPrevented).toBe(true);
      expect(reachedDocument).toBe(0);
    });

    it('Escape closes and never reaches the document, so it cannot stop a streaming turn', () => {
      let closed = 0;
      let reachedDocument = 0;
      component.closed.subscribe(() => (closed += 1));
      document.addEventListener('keydown', () => (reachedDocument += 1));
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });

      el('chat-find-input').dispatchEvent(escape);

      expect(closed).toBe(1);
      expect(escape.defaultPrevented).toBe(true);
      expect(reachedDocument).toBe(0);
    });

    it('lets other keys bubble', () => {
      let reachedDocument = 0;
      document.addEventListener('keydown', () => (reachedDocument += 1));
      el('chat-find-input').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
      );
      expect(reachedDocument).toBe(1);
    });

    it('the close button emits closed', () => {
      let closed = 0;
      component.closed.subscribe(() => (closed += 1));
      el('chat-find-close').click();
      expect(closed).toBe(1);
    });
  });

  describe('focusInput', () => {
    it('focuses the field and selects its content', () => {
      setInputs({ query: 'select me' });
      component.focusInput();
      const input = el<HTMLInputElement>('chat-find-input');
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe('select me'.length);
    });
  });

  describe('accessibility', () => {
    it('labels every control', () => {
      expect(el('chat-find-bar').getAttribute('role')).toBe('search');
      for (const id of [
        'chat-find-input',
        'chat-find-regex',
        'chat-find-case',
        'chat-find-prev',
        'chat-find-next',
        'chat-find-close',
      ]) {
        expect(el(id).getAttribute('aria-label'), id).toBeTruthy();
      }
    });
  });
});
