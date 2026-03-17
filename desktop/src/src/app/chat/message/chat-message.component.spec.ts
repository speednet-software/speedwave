import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatMessageComponent } from './chat-message.component';
import type { MessageBlock } from '../../models/chat';
import { ToolNormalizerService } from '../../services/tool-normalizer.service';

describe('ChatMessageComponent', () => {
  let component: ChatMessageComponent;
  let fixture: ComponentFixture<ChatMessageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatMessageComponent],
      providers: [ToolNormalizerService],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatMessageComponent);
    component = fixture.componentInstance;
  });

  it('renders text block', () => {
    const blocks: MessageBlock[] = [{ type: 'text', content: 'Hello world' }];
    component.blocks = blocks;
    component.role = 'assistant';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Hello world');
  });

  it('renders error block', () => {
    const blocks: MessageBlock[] = [{ type: 'error', content: 'Something failed' }];
    component.blocks = blocks;
    component.role = 'assistant';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Something failed');
    expect(el.querySelector('[data-testid="error-block"]')).not.toBeNull();
  });

  it('renders thinking block collapsed', () => {
    const blocks: MessageBlock[] = [{ type: 'thinking', content: 'hmm', collapsed: true }];
    component.blocks = blocks;
    component.role = 'assistant';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="thinking-content"]')).toBeNull();
    expect(el.textContent).toContain('Thinking...');
  });

  it('renders tool_use block', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_use',
        tool: {
          tool_id: 't1',
          tool_name: 'Read',
          input_json: '{"file_path":"/a.ts"}',
          status: 'done',
          collapsed: false,
        },
      },
    ];
    component.blocks = blocks;
    component.role = 'assistant';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="tool-name"]')?.textContent).toBe('Read');
  });

  it('renders multiple blocks in order', () => {
    const blocks: MessageBlock[] = [
      { type: 'text', content: 'First' },
      { type: 'thinking', content: 'thinking...', collapsed: true },
      { type: 'text', content: 'Second' },
    ];
    component.blocks = blocks;
    component.role = 'assistant';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('First');
    expect(el.textContent).toContain('Second');
    expect(el.textContent).toContain('Thinking...');
  });

  it('applies user styling for user role', () => {
    component.blocks = [{ type: 'text', content: 'hi' }];
    component.role = 'user';
    fixture.detectChanges();

    const msg = fixture.nativeElement.querySelector('[data-testid="chat-message"]');
    expect(msg?.classList.contains('self-end')).toBe(true);
  });

  it('shows streaming cursor when streaming', () => {
    component.blocks = [{ type: 'text', content: 'partial...' }];
    component.role = 'assistant';
    component.streaming = true;
    fixture.detectChanges();

    const cursor = fixture.nativeElement.querySelector('[data-testid="cursor"]');
    expect(cursor).not.toBeNull();
  });

  it('does not show cursor when not streaming', () => {
    component.blocks = [{ type: 'text', content: 'done' }];
    component.role = 'assistant';
    component.streaming = false;
    fixture.detectChanges();

    const cursor = fixture.nativeElement.querySelector('[data-testid="cursor"]');
    expect(cursor).toBeNull();
  });

  it('renders ask_user block with question', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'ask_user',
        question: {
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
        },
      },
    ];
    component.blocks = blocks;
    component.role = 'assistant';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="ask-user-block"]')).not.toBeNull();
    expect(el.textContent).toContain('Pick a fruit');
  });

  it('emits questionAnswered when ask_user block is answered', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'ask_user',
        question: {
          tool_id: 'toolu_ask1',
          question: 'Pick one',
          options: [{ label: 'A', value: 'a' }],
          header: '',
          multi_select: false,
          answered: false,
          selected_values: [],
        },
      },
    ];
    component.blocks = blocks;
    component.role = 'assistant';
    fixture.detectChanges();

    let emitted: { toolId: string; values: string[] } | null = null;
    component.questionAnswered.subscribe((e) => (emitted = e));

    // Simulate the ask-user-block emitting answered
    const askUserBlock = fixture.nativeElement.querySelector('app-ask-user-block');
    expect(askUserBlock).not.toBeNull();

    // Trigger via component method
    component.onAnswered('toolu_ask1', ['a']);
    expect(emitted).toEqual({ toolId: 'toolu_ask1', values: ['a'] });
  });
});
