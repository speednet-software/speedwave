import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AskUserBlockComponent } from './ask-user-block.component';
import type { AskUserQuestionBlock, AskUserQuestionItem } from '../../models/chat';

describe('AskUserBlockComponent', () => {
  let component: AskUserBlockComponent;
  let fixture: ComponentFixture<AskUserBlockComponent>;

  function makeQuestion(overrides: Partial<AskUserQuestionItem> = {}): AskUserQuestionItem {
    return {
      question: 'Pick a fruit',
      header: 'Fruits',
      options: [
        { label: 'Apple', value: 'apple' },
        { label: 'Banana', value: 'banana' },
      ],
      multi_select: false,
      ...overrides,
    };
  }

  function makeBlock(overrides: Partial<AskUserQuestionBlock> = {}): AskUserQuestionBlock {
    return {
      tool_id: 'toolu_ask1',
      questions: [makeQuestion()],
      current_index: 0,
      answers: [null],
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

  function setBlock(b: AskUserQuestionBlock): void {
    fixture.componentRef.setInput('question', b);
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the active question and options (1-question happy path)', () => {
    setBlock(makeBlock());
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
    setBlock(makeBlock({ questions: [makeQuestion({ multi_select: true })] }));
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
    setBlock(makeBlock());
    component.toggleOption('apple');
    component.toggleOption('banana');
    expect([...component.selected()]).toEqual(['banana']);
  });

  it('Send emits single-select label with toolId, questionIdx, value', () => {
    setBlock(makeBlock());
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.toggleOption('apple');
    component.submit();
    expect(spy).toHaveBeenCalledWith({
      toolId: 'toolu_ask1',
      questionIdx: 0,
      value: 'Apple',
    });
  });

  it('multi-select Send emits "label1, label2" per the SDK contract', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ multi_select: true })] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.toggleOption('apple');
    component.toggleOption('banana');
    component.submit();
    expect(spy).toHaveBeenCalledWith({
      toolId: 'toolu_ask1',
      questionIdx: 0,
      value: 'Apple, Banana',
    });
  });

  it('Send does not emit when nothing selected and freeform is empty', () => {
    setBlock(makeBlock());
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.submit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Send button disabled when canSend is false; enabled after toggle', () => {
    setBlock(makeBlock());
    const sendBtn = el().querySelector('[data-testid="ask-send-btn"]') as HTMLButtonElement | null;
    expect(sendBtn?.disabled).toBe(true);
    component.toggleOption('apple');
    fixture.detectChanges();
    expect(sendBtn?.disabled).toBe(false);
  });

  it('multi-select Send shows a count in its label when items selected', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ multi_select: true })] }));
    component.toggleOption('apple');
    component.toggleOption('banana');
    fixture.detectChanges();
    const sendBtn = el().querySelector('[data-testid="ask-send-btn"]') as HTMLButtonElement | null;
    expect(sendBtn?.textContent).toContain('confirm (2)');
  });

  it('renders 2 questions sequentially: first locked with badge after answering', () => {
    setBlock(
      makeBlock({
        questions: [makeQuestion({ question: 'Q0' }), makeQuestion({ question: 'Q1' })],
        current_index: 1,
        answers: ['Apple', null],
      })
    );
    const lockedBlocks = el().querySelectorAll('[data-testid="ask-user-block-locked"]');
    expect(lockedBlocks.length).toBe(1);
    expect(lockedBlocks[0].querySelector('[data-testid="selected-option"]')?.textContent).toContain(
      'Apple'
    );
    const active = el().querySelector('[data-testid="ask-user-block"]');
    expect(active?.getAttribute('data-slot-index')).toBe('1');
  });

  it('renders 3 questions: indexes < current_index are locked, > current_index are hidden', () => {
    setBlock(
      makeBlock({
        questions: [
          makeQuestion({ question: 'Q0' }),
          makeQuestion({ question: 'Q1' }),
          makeQuestion({ question: 'Q2' }),
        ],
        current_index: 1,
        answers: ['Apple', null, null],
      })
    );
    expect(el().querySelectorAll('[data-testid="ask-user-block-locked"]').length).toBe(1);
    expect(el().querySelectorAll('[data-testid="ask-user-block"]').length).toBe(1);
    // Q2 must not be rendered yet.
    const allTexts = Array.from(el().querySelectorAll('[data-testid="ask-question"]')).map(
      (e) => e.textContent
    );
    expect(allTexts.some((t) => t?.includes('Q2'))).toBe(false);
  });

  it('renders 4 questions through the full flow — all locked when current_index === questions.length', () => {
    setBlock(
      makeBlock({
        questions: [
          makeQuestion({ question: 'A' }),
          makeQuestion({ question: 'B' }),
          makeQuestion({ question: 'C' }),
          makeQuestion({ question: 'D' }),
        ],
        current_index: 4,
        answers: ['a', 'b', 'c', 'd'],
      })
    );
    expect(el().querySelectorAll('[data-testid="ask-user-block-locked"]').length).toBe(4);
    expect(el().querySelector('[data-testid="ask-user-block"]')).toBeNull();
  });

  it('progress legend shows "n of N" for multi-question blocks', () => {
    setBlock(
      makeBlock({
        questions: [makeQuestion({ question: 'Q0' }), makeQuestion({ question: 'Q1' })],
        current_index: 0,
        answers: [null, null],
      })
    );
    expect(el().querySelector('[data-testid="ask-legend"]')?.textContent).toContain(
      'question 1 of 2'
    );
  });

  it('progress legend omits "n of N" for single-question blocks', () => {
    setBlock(makeBlock());
    expect(el().querySelector('[data-testid="ask-legend"]')?.textContent).not.toContain('of');
  });

  it('duplicate question text is disambiguated by index — distinct slots', () => {
    setBlock(
      makeBlock({
        questions: [makeQuestion({ question: 'Same?' }), makeQuestion({ question: 'Same?' })],
        current_index: 1,
        answers: ['first answer', null],
      })
    );
    // Locked slot 0 shows its own answer badge.
    expect(
      el().querySelector('[data-testid="ask-user-block-locked"] [data-testid="selected-option"]')
        ?.textContent
    ).toContain('first answer');
    // Active slot is index 1.
    expect(
      el().querySelector('[data-testid="ask-user-block"]')?.getAttribute('data-slot-index')
    ).toBe('1');
  });

  it('clicking on a locked slot button does nothing — fieldset is disabled', () => {
    setBlock(
      makeBlock({
        questions: [makeQuestion({ question: 'Q0' }), makeQuestion({ question: 'Q1' })],
        current_index: 1,
        answers: ['A', null],
      })
    );
    const lockedFieldset = el().querySelector(
      '[data-testid="ask-user-block-locked"]'
    ) as HTMLFieldSetElement | null;
    expect(lockedFieldset?.disabled).toBe(true);
  });

  it('freeform-only variant: shows input and no option buttons', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ options: [] })] }));
    expect(el().querySelector('[data-testid="ask-input"]')).toBeTruthy();
    expect(el().querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(0);
  });

  it('single + freeform variant: shows options AND input', () => {
    setBlock(makeBlock());
    expect(el().querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(2);
    expect(el().querySelector('[data-testid="ask-input"]')).toBeTruthy();
  });

  it('multi-select variant: hides freeform input', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ multi_select: true })] }));
    expect(el().querySelectorAll('[data-testid="ask-option-btn"]').length).toBe(2);
    expect(el().querySelector('[data-testid="ask-input"]')).toBeNull();
  });

  it('freeform text submit emits trimmed value', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ options: [] })] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.freeformText.set('  hello world  ');
    component.submit();
    expect(spy).toHaveBeenCalledWith({
      toolId: 'toolu_ask1',
      questionIdx: 0,
      value: 'hello world',
    });
  });

  it('freeform whitespace-only submit does not emit', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ options: [] })] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.freeformText.set('   ');
    component.submit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('selected option wins over freeform text when both are present', () => {
    setBlock(makeBlock());
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.toggleOption('apple');
    component.freeformText.set('should be ignored');
    component.submit();
    expect(spy).toHaveBeenCalledWith({
      toolId: 'toolu_ask1',
      questionIdx: 0,
      value: 'Apple',
    });
  });

  it('shows freeform-silenced hint when option is selected and freeform is non-empty', () => {
    setBlock(makeBlock());
    component.toggleOption('apple');
    component.freeformText.set('typed text');
    fixture.detectChanges();
    expect(component.freeformSilenced()).toBe(true);
    expect(el().querySelector('[data-testid="ask-freeform-hint"]')).toBeTruthy();
  });

  it('onFreeformEnter submits on plain Enter', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ options: [] })] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.freeformText.set('typed');
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
    component.onFreeformEnter(event);
    expect(spy).toHaveBeenCalledWith({
      toolId: 'toolu_ask1',
      questionIdx: 0,
      value: 'typed',
    });
  });

  it('onFreeformEnter does not submit with Shift+Enter', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ options: [] })] }));
    const spy = vi.fn();
    component.answered.subscribe(spy);
    component.freeformText.set('typed');
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
    component.onFreeformEnter(event);
    expect(spy).not.toHaveBeenCalled();
  });

  it('edge: very long question text still renders without crash', () => {
    const longQ = 'a'.repeat(5000);
    setBlock(makeBlock({ questions: [makeQuestion({ question: longQ })] }));
    expect(el().querySelector('[data-testid="ask-question"]')?.textContent).toContain(longQ);
  });

  it('edge: empty options array does not crash', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ options: [] })] }));
    expect(() => component.submit()).not.toThrow();
    expect(() => component.toggleOption('anything')).not.toThrow();
  });

  it('ARIA: fieldset + legend present on the active slot', () => {
    setBlock(makeBlock());
    const fs = el().querySelector('fieldset[data-testid="ask-user-block"]');
    expect(fs).toBeTruthy();
    const legend = fs?.querySelector('legend');
    expect(legend).toBeTruthy();
  });

  it('ARIA: option group has an aria-label for multi-select', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ multi_select: true })] }));
    const group = el().querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Select any options');
  });

  it('data-variant attribute reflects the variant for the active slot', () => {
    setBlock(makeBlock({ questions: [makeQuestion({ multi_select: true })] }));
    expect(el().querySelector('[data-testid="ask-user-block"]')?.getAttribute('data-variant')).toBe(
      'multi'
    );

    setBlock(makeBlock({ questions: [makeQuestion({ options: [], multi_select: false })] }));
    expect(el().querySelector('[data-testid="ask-user-block"]')?.getAttribute('data-variant')).toBe(
      'freeform'
    );

    setBlock(
      makeBlock({
        questions: [makeQuestion({ options: [{ label: 'x', value: 'x' }], multi_select: false })],
      })
    );
    expect(el().querySelector('[data-testid="ask-user-block"]')?.getAttribute('data-variant')).toBe(
      'single-freeform'
    );
  });
});
