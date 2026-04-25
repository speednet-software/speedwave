import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AskUserBlockComponent } from './ask-user-block.component';
import type { AskUserQuestionBlock } from '../../models/chat';

describe('AskUserBlockComponent', () => {
  let component: AskUserBlockComponent;
  let fixture: ComponentFixture<AskUserBlockComponent>;

  function makeQuestion(overrides: Partial<AskUserQuestionBlock> = {}): AskUserQuestionBlock {
    return {
      tool_id: 'toolu_ask1',
      question: 'Pick a fruit',
      options: [
        { label: 'Apple', value: 'apple' },
        { label: 'Banana', value: 'banana' },
      ],
      header: 'Fruits',
      multi_select: false,
      answered: false,
      selected_values: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AskUserBlockComponent],
    });
    fixture = TestBed.createComponent(AskUserBlockComponent);
    component = fixture.componentInstance;
  });

  function setQuestion(q: AskUserQuestionBlock): void {
    component.question = q;
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the question and options (happy)', () => {
    setQuestion(makeQuestion());
    expect(el().querySelector('[data-testid="ask-legend"]')?.textContent).toContain('Fruits');
    expect(el().querySelector('[data-testid="ask-question"]')?.textContent).toContain(
      'Pick a fruit'
    );

    const buttons = el().querySelectorAll('[data-testid="ask-option-btn"]');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain('Apple');
    expect(buttons[1].textContent).toContain('Banana');
  });

  it('multi-select: toggles options and renders aria-pressed', () => {
    setQuestion(makeQuestion({ multi_select: true }));
    component.toggleOption('apple');
    component.toggleOption('banana');
    expect([...component.selected()]).toEqual(['apple', 'banana']);
    component.toggleOption('apple');
    expect([...component.selected()]).toEqual(['banana']);
    fixture.detectChanges();

    const buttons = el().querySelectorAll('[data-testid="ask-option-btn"]');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('single-select: choosing a second option replaces the first', () => {
    setQuestion(makeQuestion({ multi_select: false }));
    component.toggleOption('apple');
    component.toggleOption('banana');
    expect([...component.selected()]).toEqual(['banana']);
  });

  it('Send emits values with toolId (happy)', () => {
    setQuestion(makeQuestion());
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.toggleOption('apple');
    component.submit();
    expect(spy).toHaveBeenCalledWith({ toolId: 'toolu_ask1', values: ['apple'] });
  });

  it('Send does not emit when nothing selected and freeform is empty', () => {
    setQuestion(makeQuestion());
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.submit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Send button is disabled when canSend is false', () => {
    setQuestion(makeQuestion());
    const sendBtn = el().querySelector('[data-testid="ask-send-btn"]') as HTMLButtonElement | null;
    expect(sendBtn?.disabled).toBe(true);
    component.toggleOption('apple');
    fixture.detectChanges();
    expect(sendBtn?.disabled).toBe(false);
  });

  it('multi-select Send shows a count in its label when items selected', () => {
    setQuestion(makeQuestion({ multi_select: true }));
    component.toggleOption('apple');
    component.toggleOption('banana');
    fixture.detectChanges();
    const sendBtn = el().querySelector('[data-testid="ask-send-btn"]') as HTMLButtonElement | null;
    expect(sendBtn?.textContent).toContain('Send (2)');
  });

  it('answered: renders locked badges and hides controls', () => {
    setQuestion(makeQuestion({ answered: true, selected_values: ['apple'] }));
    expect(el().querySelector('[data-testid="ask-answered"]')).toBeTruthy();
    expect(el().querySelector('[data-testid="selected-option"]')?.textContent).toContain('apple');
    expect(el().querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(0);
    expect(el().querySelector('[data-testid="ask-send-btn"]')).toBeNull();
  });

  it('answered: toggleOption is a no-op', () => {
    setQuestion(makeQuestion({ answered: true, selected_values: ['apple'] }));
    component.toggleOption('banana');
    expect(component.selected().size).toBe(0);
  });

  it('answered: submit is a no-op', () => {
    setQuestion(makeQuestion({ answered: true, selected_values: ['apple'] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.submit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('freeform-only variant: shows textarea and no option buttons', () => {
    setQuestion(makeQuestion({ options: [] }));
    expect(el().querySelector('[data-testid="ask-input"]')).toBeTruthy();
    expect(el().querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(0);
  });

  it('single + freeform variant: shows options AND textarea', () => {
    setQuestion(makeQuestion({ multi_select: false }));
    expect(el().querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(2);
    expect(el().querySelector('[data-testid="ask-input"]')).toBeTruthy();
  });

  it('multi-select variant: hides freeform textarea', () => {
    setQuestion(makeQuestion({ multi_select: true }));
    expect(el().querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(2);
    expect(el().querySelector('[data-testid="ask-input"]')).toBeNull();
  });

  it('freeform text submit emits trimmed value', () => {
    setQuestion(makeQuestion({ options: [] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.freeformText.set('  hello world  ');
    component.submit();
    expect(spy).toHaveBeenCalledWith({ toolId: 'toolu_ask1', values: ['hello world'] });
  });

  it('freeform whitespace-only submit does not emit', () => {
    setQuestion(makeQuestion({ options: [] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.freeformText.set('   ');
    component.submit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('selected options win over freeform text when both are present', () => {
    setQuestion(makeQuestion({ multi_select: false }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.toggleOption('apple');
    component.freeformText.set('should be ignored');
    component.submit();
    expect(spy).toHaveBeenCalledWith({ toolId: 'toolu_ask1', values: ['apple'] });
  });

  it('shows visual hint and mutes textarea when option is selected and freeform is non-empty', () => {
    setQuestion(makeQuestion({ multi_select: false }));
    component.toggleOption('apple');
    component.freeformText.set('typed text');
    fixture.detectChanges();

    expect(component.freeformSilenced()).toBe(true);
    expect(el().querySelector('[data-testid="ask-freeform-hint"]')).toBeTruthy();
    const textarea = el().querySelector('[data-testid="ask-input"]') as HTMLTextAreaElement | null;
    expect(textarea?.classList.contains('freeform-muted')).toBe(true);
  });

  it('hides freeform hint when only the option is selected (no freeform text)', () => {
    setQuestion(makeQuestion({ multi_select: false }));
    component.toggleOption('apple');
    fixture.detectChanges();

    expect(component.freeformSilenced()).toBe(false);
    expect(el().querySelector('[data-testid="ask-freeform-hint"]')).toBeNull();
  });

  it('hides freeform hint when only freeform is filled (no option selected)', () => {
    setQuestion(makeQuestion({ multi_select: false }));
    component.freeformText.set('typed');
    fixture.detectChanges();

    expect(component.freeformSilenced()).toBe(false);
    expect(el().querySelector('[data-testid="ask-freeform-hint"]')).toBeNull();
  });

  it('onFreeformEnter submits on plain Enter', () => {
    setQuestion(makeQuestion({ options: [] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.freeformText.set('typed');
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
    component.onFreeformEnter(event);
    expect(spy).toHaveBeenCalledWith({ toolId: 'toolu_ask1', values: ['typed'] });
  });

  it('onFreeformEnter does not submit with Shift+Enter', () => {
    setQuestion(makeQuestion({ options: [] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.freeformText.set('typed');
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
    component.onFreeformEnter(event);
    expect(spy).not.toHaveBeenCalled();
  });

  it('onFreeformInput updates the signal', () => {
    setQuestion(makeQuestion({ options: [] }));
    const input = document.createElement('textarea');
    input.value = 'draft text';
    component.onFreeformInput({ target: input } as unknown as Event);
    expect(component.freeformText()).toBe('draft text');
  });

  it('edge: zero options + no header renders only a fallback legend', () => {
    setQuestion(makeQuestion({ options: [], header: '', multi_select: false }));
    expect(el().querySelector('[data-testid="ask-legend"]')?.textContent).toContain('?');
    expect(el().querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(0);
    expect(el().querySelector('[data-testid="ask-input"]')).toBeTruthy();
  });

  it('edge: very long question text still renders without crash', () => {
    const longQ = 'a'.repeat(5000);
    setQuestion(makeQuestion({ question: longQ }));
    expect(el().querySelector('[data-testid="ask-question"]')?.textContent).toContain(longQ);
  });

  it('edge: empty options array does not crash', () => {
    setQuestion(makeQuestion({ options: [] }));
    expect(() => component.submit()).not.toThrow();
    expect(() => component.toggleOption('anything')).not.toThrow();
  });

  it('ARIA: fieldset + legend present', () => {
    setQuestion(makeQuestion());
    const fs = el().querySelector('fieldset[data-testid="ask-user-block"]');
    expect(fs).toBeTruthy();
    const legend = fs?.querySelector('legend');
    expect(legend).toBeTruthy();
  });

  it('ARIA: answered state disables the fieldset', () => {
    setQuestion(makeQuestion({ answered: true, selected_values: ['apple'] }));
    const fs = el().querySelector(
      'fieldset[data-testid="ask-user-block"]'
    ) as HTMLFieldSetElement | null;
    expect(fs?.disabled).toBe(true);
  });

  it('ARIA: option group has an aria-label', () => {
    setQuestion(makeQuestion({ multi_select: true }));
    const group = el().querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Select any options');
  });

  it('state: submitted multi-select emits all selected values', () => {
    setQuestion(makeQuestion({ multi_select: true }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.toggleOption('apple');
    component.toggleOption('banana');
    component.submit();
    expect(spy).toHaveBeenCalledWith({
      toolId: 'toolu_ask1',
      values: ['apple', 'banana'],
    });
  });

  it('data-variant attribute reflects the current variant', () => {
    setQuestion(makeQuestion({ multi_select: true }));
    expect(el().querySelector('[data-testid="ask-user-block"]')?.getAttribute('data-variant')).toBe(
      'multi'
    );

    setQuestion(makeQuestion({ multi_select: false, options: [] }));
    expect(el().querySelector('[data-testid="ask-user-block"]')?.getAttribute('data-variant')).toBe(
      'freeform'
    );

    setQuestion(makeQuestion({ multi_select: false, options: [{ label: 'x', value: 'x' }] }));
    expect(el().querySelector('[data-testid="ask-user-block"]')?.getAttribute('data-variant')).toBe(
      'single-freeform'
    );

    setQuestion(makeQuestion({ answered: true, selected_values: ['apple'] }));
    expect(el().querySelector('[data-testid="ask-user-block"]')?.getAttribute('data-variant')).toBe(
      'answered'
    );
  });
});
