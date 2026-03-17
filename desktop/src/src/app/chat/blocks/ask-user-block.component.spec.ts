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

  it('renders the question and options', () => {
    component.question = makeQuestion();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="ask-header"]')?.textContent).toContain('Fruits');
    expect(el.querySelector('[data-testid="ask-question"]')?.textContent).toContain('Pick a fruit');

    const buttons = el.querySelectorAll('[data-testid="ask-option-btn"]');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain('Apple');
    expect(buttons[1].textContent).toContain('Banana');
  });

  it('selects an option on click (single select)', () => {
    component.question = makeQuestion();
    fixture.detectChanges();

    component.toggleOption('apple');
    expect(component.pendingSelection).toEqual(['apple']);

    component.toggleOption('banana');
    expect(component.pendingSelection).toEqual(['banana']);
  });

  it('toggles options in multi-select mode', () => {
    component.question = makeQuestion({ multi_select: true });
    fixture.detectChanges();

    component.toggleOption('apple');
    component.toggleOption('banana');
    expect(component.pendingSelection).toEqual(['apple', 'banana']);

    component.toggleOption('apple');
    expect(component.pendingSelection).toEqual(['banana']);
  });

  it('emits answered event on submit', () => {
    component.question = makeQuestion();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    component.toggleOption('apple');
    component.submit();

    expect(spy).toHaveBeenCalledWith(['apple']);
  });

  it('does not emit when no selection', () => {
    component.question = makeQuestion();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    component.submit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows selected values when answered', () => {
    component.question = makeQuestion({ answered: true, selected_values: ['apple'] });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="ask-answered"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="selected-option"]')?.textContent).toContain('apple');
    expect(el.querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(0);
  });

  it('does not allow toggling when already answered', () => {
    component.question = makeQuestion({ answered: true, selected_values: ['apple'] });
    fixture.detectChanges();

    component.toggleOption('banana');
    expect(component.pendingSelection).toEqual([]);
  });

  it('shows freeform input when no options', () => {
    component.question = makeQuestion({ options: [] });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="ask-input"]')).toBeTruthy();
    expect(el.querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(0);
  });

  it('shows both options and freeform input when options present', () => {
    component.question = makeQuestion();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(2);
    expect(el.querySelector('[data-testid="ask-input"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="ask-or"]')).toBeTruthy();
  });

  it('emits freeform answer via Send button click (submitFreeformFromInput)', () => {
    component.question = makeQuestion({ options: [] });
    fixture.detectChanges();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('[data-testid="ask-input"]') as HTMLInputElement;
    input.value = 'My freeform answer';

    const sendBtn = el.querySelector('[data-testid="ask-submit-btn"]') as HTMLButtonElement;
    expect(sendBtn).not.toBeNull();
    sendBtn.click();
    fixture.detectChanges();

    expect(spy).toHaveBeenCalledWith(['My freeform answer']);
  });

  it('Send button does not emit when freeform input is empty', () => {
    component.question = makeQuestion({ options: [] });
    fixture.detectChanges();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('[data-testid="ask-input"]') as HTMLInputElement;
    input.value = '   ';

    const sendBtn = el.querySelector('[data-testid="ask-submit-btn"]') as HTMLButtonElement;
    sendBtn.click();
    fixture.detectChanges();

    expect(spy).not.toHaveBeenCalled();
  });

  it('emits freeform answer via enter key when options present', () => {
    component.question = makeQuestion();
    fixture.detectChanges();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('[data-testid="ask-input"]') as HTMLInputElement;
    input.value = 'Custom answer';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    component.submitFreeform({ target: input } as unknown as Event);

    expect(spy).toHaveBeenCalledWith(['Custom answer']);
  });

  it('submitFreeform trims whitespace from input value', () => {
    component.question = makeQuestion({ options: [] });
    fixture.detectChanges();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    const input = document.createElement('input');
    input.value = '  trimmed value  ';
    component.submitFreeform({ target: input } as unknown as Event);

    expect(spy).toHaveBeenCalledWith(['trimmed value']);
  });

  it('submitFreeformFromInput trims whitespace from input value', () => {
    component.question = makeQuestion({ options: [] });
    fixture.detectChanges();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    const input = document.createElement('input');
    input.value = '  trimmed value  ';
    component.submitFreeformFromInput(input);

    expect(spy).toHaveBeenCalledWith(['trimmed value']);
  });

  it('submitFreeform does not emit when question is already answered', () => {
    component.question = makeQuestion({ answered: true, selected_values: ['apple'] });
    fixture.detectChanges();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    const input = document.createElement('input');
    input.value = 'some answer';
    component.submitFreeform({ target: input } as unknown as Event);

    expect(spy).not.toHaveBeenCalled();
  });

  it('submitFreeformFromInput does not emit when question is already answered', () => {
    component.question = makeQuestion({ answered: true, selected_values: ['apple'] });
    fixture.detectChanges();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    const input = document.createElement('input');
    input.value = 'some answer';
    component.submitFreeformFromInput(input);

    expect(spy).not.toHaveBeenCalled();
  });

  it('submitFreeform does not emit for whitespace-only input', () => {
    component.question = makeQuestion({ options: [] });
    fixture.detectChanges();
    const spy = vi.fn();
    component.answered.subscribe(spy);

    const input = document.createElement('input');
    input.value = '   ';
    component.submitFreeform({ target: input } as unknown as Event);

    expect(spy).not.toHaveBeenCalled();
  });
});
