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
    fixture.componentRef.setInput('blocks', blocks);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Hello world');
  });

  it('renders error block', () => {
    const blocks: MessageBlock[] = [{ type: 'error', content: 'Something failed' }];
    fixture.componentRef.setInput('blocks', blocks);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Something failed');
    expect(el.querySelector('[data-testid="error-block"]')).not.toBeNull();
  });

  it('renders thinking block collapsed', () => {
    const blocks: MessageBlock[] = [{ type: 'thinking', content: 'hmm', collapsed: true }];
    fixture.componentRef.setInput('blocks', blocks);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    // The collapsed thinking block uses native <details> without the `open`
    // attribute — the content stays in the DOM but is visually hidden.
    const details = el.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    // The summary toggle is always rendered with the lowercase "thinking" label.
    expect(el.textContent).toContain('thinking');
  });

  it('renders tool_use block', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_use',
        tool: {
          type: 'tool_use',
          tool_id: 't1',
          tool_name: 'Read',
          input_json: '{"file_path":"/a.ts"}',
          status: 'done',
          result: '',
          result_is_error: false,
        },
      },
    ];
    fixture.componentRef.setInput('blocks', blocks);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="tool-name"]')?.textContent).toBe('Read');
  });

  it('renders multiple blocks in order', () => {
    const blocks: MessageBlock[] = [
      { type: 'text', content: 'First' },
      { type: 'thinking', content: 'reasoning step', collapsed: true },
      { type: 'text', content: 'Second' },
    ];
    fixture.componentRef.setInput('blocks', blocks);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('First');
    expect(el.textContent).toContain('Second');
    // The thinking block contributes its lowercase "thinking" summary label.
    expect(el.textContent).toContain('thinking');
  });

  it('dispatches to app-user-message when role is user', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'hi' }]);
    fixture.componentRef.setInput('role', 'user');
    fixture.detectChanges();

    const msg = fixture.nativeElement.querySelector('[data-testid="chat-message"]');
    expect(msg?.getAttribute('data-role')).toBe('user');
    const userMsg = fixture.nativeElement.querySelector('app-user-message');
    expect(userMsg).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('hi');
    // No assistant-style bubble on user messages — no max-width or border background.
    expect(fixture.nativeElement.querySelector('.bg-sw-bg-dark')).toBeNull();
    expect(fixture.nativeElement.querySelector('.max-w-\\[85\\%\\]')).toBeNull();
  });

  it('forwards editedAt and timestamp to app-user-message', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'hi' }]);
    fixture.componentRef.setInput('role', 'user');
    fixture.componentRef.setInput('editedAt', 1_700_000_000_000);
    const ts = new Date(2026, 3, 25, 9, 30, 0, 0).getTime();
    fixture.componentRef.setInput('timestamp', ts);
    fixture.detectChanges();

    const edited = fixture.nativeElement.querySelector('[data-testid="user-message-edited"]');
    expect(edited).not.toBeNull();
    const time = fixture.nativeElement.querySelector('[data-testid="user-message-time"]');
    expect(time?.textContent?.trim()).toBe('09:30');
  });

  it('host stretches messages full-width (terminal-minimal: no role-based alignment)', () => {
    // The terminal-minimal layout removes role-based horizontal alignment —
    // both user and assistant messages stretch to the column width with the
    // mono meta line as the visual differentiator instead of a bubble.
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'ok' }]);
    fixture.componentRef.setInput('role', 'user');
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList.contains('items-stretch')).toBe(true);
    expect(host.classList.contains('items-end')).toBe(false);
    expect(host.classList.contains('items-start')).toBe(false);
  });

  it('assistant host also stretches messages full-width', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'hello' }]);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList.contains('items-stretch')).toBe(true);
    expect(host.classList.contains('items-end')).toBe(false);
    expect(host.classList.contains('items-start')).toBe(false);
  });

  it('user role dispatches to <app-user-message> (terminal-minimal: no bubble)', () => {
    // After Unit 8 (refactor: extract chat header, list, user-message), user
    // messages render via <app-user-message> in terminal-minimal style — no
    // sized "bubble" with w-fit/max-w-[85%]. This replaces the prior bubble
    // test which assumed both roles shared the same wrapper styling.
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'ok' }]);
    fixture.componentRef.setInput('role', 'user');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-user-message')).not.toBeNull();
  });

  it('assistant role renders without a bubble (terminal-minimal: plain article)', () => {
    // After the terminal-minimal redesign, assistant messages are plain
    // articles — no max-width, no border, no rounded background. The mono
    // `speedwave · model · time` meta line is the only visual delimiter.
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'ok' }]);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.detectChanges();

    const article = fixture.nativeElement.querySelector(
      '[data-testid="chat-message"]'
    ) as HTMLElement;
    expect(article).not.toBeNull();
    expect(article.classList.contains('max-w-[85%]')).toBe(false);
    expect(article.classList.contains('rounded-lg')).toBe(false);
    expect(article.classList.contains('bg-sw-bg-dark')).toBe(false);
  });

  it('shows the block-level cursor when streaming and last block is NOT text', () => {
    // The per-text-block streaming caret renders inside <app-text-block>;
    // the parent block-level cursor is suppressed when the last block is a
    // text block to avoid a double-cursor visual bug.
    fixture.componentRef.setInput('blocks', [
      {
        type: 'tool_use',
        tool: {
          type: 'tool_use',
          tool_id: 't1',
          tool_name: 'Read',
          input_json: '{}',
          status: 'running',
        },
      },
    ]);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();

    const cursor = fixture.nativeElement.querySelector('[data-testid="cursor"]');
    expect(cursor).not.toBeNull();
  });

  it('hides the block-level cursor when streaming and last block IS text (per-block caret takes over)', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'partial...' }]);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="cursor"]')).toBeNull();
    // The per-text-block caret is the one visible during text streaming.
    expect(fixture.nativeElement.querySelector('[data-testid="streaming-caret"]')).not.toBeNull();
  });

  it('does not show cursor when not streaming', () => {
    fixture.componentRef.setInput('blocks', [{ type: 'text', content: 'done' }]);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.componentRef.setInput('streaming', false);
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
    fixture.componentRef.setInput('blocks', blocks);
    fixture.componentRef.setInput('role', 'assistant');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="ask-user-block"]')).not.toBeNull();
    expect(el.textContent).toContain('Pick a fruit');
  });

  it('renders permission_prompt block', () => {
    fixture.componentRef.setInput('blocks', [
      { type: 'permission_prompt', command: 'rm -rf /tmp' },
    ]);
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
    fixture.componentRef.setInput('blocks', [
      { type: 'permission_prompt', command: 'rm -rf /tmp' },
    ]);
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
    fixture.componentRef.setInput('blocks', blocks);
    fixture.componentRef.setInput('role', 'assistant');
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
