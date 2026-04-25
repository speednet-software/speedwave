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
    expect(el.textContent).toContain('Thinking');
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
    expect(el.textContent).toContain('Thinking');
  });

  it('applies user styling for user role', () => {
    component.blocks = [{ type: 'text', content: 'hi' }];
    component.role = 'user';
    fixture.detectChanges();

    const msg = fixture.nativeElement.querySelector('[data-testid="chat-message"]');
    expect(msg?.getAttribute('data-role')).toBe('user');
  });

  it('host right-aligns user messages via justify-end', () => {
    component.blocks = [{ type: 'text', content: 'ok' }];
    component.role = 'user';
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList.contains('justify-end')).toBe(true);
    expect(host.classList.contains('justify-start')).toBe(false);
  });

  it('host left-aligns assistant messages via justify-start', () => {
    component.blocks = [{ type: 'text', content: 'hello' }];
    component.role = 'assistant';
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList.contains('justify-start')).toBe(true);
    expect(host.classList.contains('justify-end')).toBe(false);
  });

  it('bubble shrinks to content width (w-fit) with 85% cap', () => {
    component.blocks = [{ type: 'text', content: 'ok' }];
    component.role = 'user';
    fixture.detectChanges();

    const bubble = fixture.nativeElement.querySelector(
      '[data-testid="chat-message"]'
    ) as HTMLElement;
    expect(bubble.classList.contains('w-fit')).toBe(true);
    expect(bubble.classList.contains('max-w-[85%]')).toBe(true);
  });

  it('shows the block-level cursor when streaming and last block is NOT text', () => {
    // The per-text-block streaming caret renders inside <app-text-block>;
    // the parent block-level cursor is suppressed when the last block is a
    // text block to avoid a double-cursor visual bug.
    component.blocks = [
      {
        type: 'tool_use',
        tool: {
          type: 'tool_use',
          tool_id: 't1',
          tool_name: 'Read',
          input_json: '{}',
          status: 'running',
          collapsed: true,
        },
      },
    ];
    component.role = 'assistant';
    component.streaming = true;
    fixture.detectChanges();

    const cursor = fixture.nativeElement.querySelector('[data-testid="cursor"]');
    expect(cursor).not.toBeNull();
  });

  it('hides the block-level cursor when streaming and last block IS text (per-block caret takes over)', () => {
    component.blocks = [{ type: 'text', content: 'partial...' }];
    component.role = 'assistant';
    component.streaming = true;
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="cursor"]')).toBeNull();
    // The per-text-block caret is the one visible during text streaming.
    expect(fixture.nativeElement.querySelector('[data-testid="streaming-caret"]')).not.toBeNull();
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

  it('renders permission_prompt block', () => {
    component.blocks = [{ type: 'permission_prompt', command: 'rm -rf /tmp' }];
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="permission-prompt"]')).not.toBeNull();
  });

  it('emits permissionDecided when child emits decided', () => {
    let emitted:
      | { blockIndex: number; decision: 'allow_once' | 'allow_always' | 'deny' }
      | undefined;
    component.permissionDecided.subscribe(
      (evt: { blockIndex: number; decision: 'allow_once' | 'allow_always' | 'deny' }) => {
        emitted = evt;
      }
    );
    component.blocks = [{ type: 'permission_prompt', command: 'rm -rf /tmp' }];
    fixture.detectChanges();
    const allowOnce = fixture.nativeElement.querySelector(
      '[data-testid="permission-allow-once"]'
    ) as HTMLButtonElement;
    allowOnce.click();
    expect(emitted).toEqual({ blockIndex: 0, decision: 'allow_once' });
  });

  it('emits questionAnswered when ask_user child emits answered', () => {
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

    // Drive the child ask-user-block via its real option + send buttons —
    // exercises the `(answered)` binding path.
    const el = fixture.nativeElement as HTMLElement;
    const optionBtn = el.querySelector(
      '[data-testid="ask-option-btn"]'
    ) as HTMLButtonElement | null;
    const sendBtn = el.querySelector('[data-testid="ask-send-btn"]') as HTMLButtonElement | null;
    expect(optionBtn).not.toBeNull();
    expect(sendBtn).not.toBeNull();
    optionBtn?.click();
    fixture.detectChanges();
    sendBtn?.click();

    expect(emitted).toEqual({ toolId: 'toolu_ask1', values: ['a'] });
  });
});
