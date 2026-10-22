import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DebugElement } from '@angular/core';
import { ChatMessageListComponent } from './chat-message-list.component';
import { ChatMessageComponent } from '../message/chat-message.component';
import { ToolNormalizerService } from '../../services/tool-normalizer.service';
import type { ChatMessage, MessageBlock } from '../../models/chat';
import { DEFAULT_FIND_STATE, type ChatFindState } from '../find/chat-find';

describe('ChatMessageListComponent', () => {
  let fixture: ComponentFixture<ChatMessageListComponent>;
  let component: ChatMessageListComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatMessageListComponent],
      providers: [ToolNormalizerService],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatMessageListComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('messages', []);
  });

  /** Replays `ngOnChanges` after a manual property set. */
  function fakeOnChanges(): void {
    component.ngOnChanges();
  }

  it('renders one chat-message per entry in messages', () => {
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
      { role: 'assistant', blocks: [{ type: 'text', content: 'hello' }], timestamp: 2 },
    ]);
    fakeOnChanges();
    fixture.detectChanges();

    const rendered = fixture.nativeElement.querySelectorAll('app-chat-message');
    expect(rendered.length).toBe(2);
  });

  it('renders nothing extra when messages is empty and not streaming', () => {
    fixture.componentRef.setInput('messages', []);
    fakeOnChanges();
    fixture.detectChanges();

    const rendered = fixture.nativeElement.querySelectorAll('app-chat-message');
    expect(rendered.length).toBe(0);
  });

  it('shows the transcript spinner when loadingTranscript is true and messages are empty', () => {
    fixture.componentRef.setInput('messages', []);
    fixture.componentRef.setInput('loadingTranscript', true);
    fakeOnChanges();
    fixture.detectChanges();

    const spinner = fixture.nativeElement.querySelector('[data-testid="chat-transcript-loading"]');
    expect(spinner).toBeTruthy();
  });

  it('hides the transcript spinner once messages have loaded', () => {
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
    ]);
    fixture.componentRef.setInput('loadingTranscript', true);
    fakeOnChanges();
    fixture.detectChanges();

    const spinner = fixture.nativeElement.querySelector('[data-testid="chat-transcript-loading"]');
    expect(spinner).toBeFalsy();
  });

  it('does not show the transcript spinner when loadingTranscript is false', () => {
    fixture.componentRef.setInput('messages', []);
    fixture.componentRef.setInput('loadingTranscript', false);
    fakeOnChanges();
    fixture.detectChanges();

    const spinner = fixture.nativeElement.querySelector('[data-testid="chat-transcript-loading"]');
    expect(spinner).toBeFalsy();
  });

  it('appends a streaming placeholder when isStreaming is true and currentBlocks has content', () => {
    const messages: ChatMessage[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
    ];
    const currentBlocks: MessageBlock[] = [{ type: 'text', content: 'partial...' }];
    fixture.componentRef.setInput('messages', messages);
    fixture.componentRef.setInput('currentBlocks', currentBlocks);
    fixture.componentRef.setInput('isStreaming', true);
    fakeOnChanges();
    fixture.detectChanges();

    const streamingEl = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list-streaming"]'
    );
    expect(streamingEl).not.toBeNull();

    const caret = fixture.nativeElement.querySelector('[data-testid="streaming-caret"]');
    expect(caret).not.toBeNull();
  });

  it('renders the awaiting caret while streaming has started but no block has arrived', () => {
    fixture.componentRef.setInput('messages', []);
    fixture.componentRef.setInput('currentBlocks', []);
    fixture.componentRef.setInput('isStreaming', true);
    fakeOnChanges();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="chat-message-list-streaming"]')
    ).toBeNull();
    const caret = fixture.nativeElement.querySelector('[data-testid="chat-message-list-awaiting"]');
    expect(caret).not.toBeNull();
    expect(caret!.querySelector('.caret')).not.toBeNull();
  });

  it('does not append a streaming placeholder when isStreaming is false', () => {
    fixture.componentRef.setInput('messages', []);
    fixture.componentRef.setInput('currentBlocks', [{ type: 'text', content: 'orphan' }]);
    fixture.componentRef.setInput('isStreaming', false);
    fakeOnChanges();
    fixture.detectChanges();

    const streamingEl = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list-streaming"]'
    );
    expect(streamingEl).toBeNull();
    const awaiting = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list-awaiting"]'
    );
    expect(awaiting).toBeNull();
  });

  it('hides the awaiting caret as soon as the first block arrives', () => {
    fixture.componentRef.setInput('messages', []);
    fixture.componentRef.setInput('currentBlocks', [{ type: 'text', content: 'hi' }]);
    fixture.componentRef.setInput('isStreaming', true);
    fakeOnChanges();
    fixture.detectChanges();

    const awaiting = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list-awaiting"]'
    );
    expect(awaiting).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="chat-message-list-streaming"]')
    ).not.toBeNull();
  });

  it('exposes a polite log live region for screen readers', () => {
    fixture.componentRef.setInput('messages', []);
    fakeOnChanges();
    fixture.detectChanges();

    const container = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list"]'
    ) as HTMLElement;
    expect(container.getAttribute('role')).toBe('log');
    expect(container.getAttribute('aria-live')).toBe('polite');
  });

  const first: ChatMessage = {
    role: 'user',
    blocks: [{ type: 'text', content: 'first' }],
    timestamp: 1,
  };

  function scrollListTo(scrollTop: number): HTMLDivElement {
    const container = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list"]'
    ) as HTMLDivElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    container.scrollTop = scrollTop;
    container.dispatchEvent(new Event('scroll'));
    return container;
  }

  function renderStreamingTurn(): void {
    fixture.componentRef.setInput('messages', [first]);
    fixture.componentRef.setInput('currentBlocks', [{ type: 'text', content: 'partial' }]);
    fixture.componentRef.setInput('isStreaming', true);
    fakeOnChanges();
    fixture.detectChanges();
  }

  function landBelow(container: HTMLDivElement, landed: ChatMessage): void {
    fixture.componentRef.setInput('messages', [first, landed]);
    fixture.componentRef.setInput('currentBlocks', []);
    fixture.componentRef.setInput('isStreaming', false);
    fakeOnChanges();
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1400 });
    fixture.detectChanges();
  }

  function switchTabsMidScroll(fromRequest: number, toRequest: number): HTMLDivElement {
    fixture.componentRef.setInput('conversationKey', 't1');
    fixture.componentRef.setInput('autoScrollRequest', fromRequest);
    fixture.componentRef.setInput('messages', [first]);
    fakeOnChanges();
    fixture.detectChanges();
    const container = scrollListTo(600);

    fixture.componentRef.setInput('conversationKey', 't2');
    fixture.componentRef.setInput('autoScrollRequest', toRequest);
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'a' }], timestamp: 1 },
      { role: 'assistant', blocks: [{ type: 'text', content: 'b' }], timestamp: 2 },
      { role: 'user', blocks: [{ type: 'text', content: 'c' }], timestamp: 3 },
    ]);
    fakeOnChanges();
    container.scrollTop = 100;
    fixture.detectChanges();
    return container;
  }

  function streamDelta(): void {
    fixture.componentRef.setInput('currentBlocks', [{ type: 'text', content: 'delta' }]);
    fixture.componentRef.setInput('isStreaming', true);
    fakeOnChanges();
    fixture.detectChanges();
  }

  const reply: ChatMessage = {
    role: 'assistant',
    blocks: [{ type: 'text', content: 'partial, finished' }],
    timestamp: 2,
  };

  it('pins scroll to bottom on new messages when user is at the bottom', () => {
    fixture.componentRef.setInput('messages', [first]);
    fakeOnChanges();
    fixture.detectChanges();
    const container = scrollListTo(600);

    landBelow(container, reply);

    expect(container.scrollTop).toBe(1400);
  });

  it.each<[string, ChatMessage]>([
    ['the streamed reply', reply],
    [
      'an error entry',
      {
        role: 'assistant',
        blocks: [{ type: 'error', content: 'Error: rate limit' }],
        timestamp: 2,
      },
    ],
    [
      'a drained queued message',
      { role: 'user', blocks: [{ type: 'text', content: 'queued earlier' }], timestamp: 2 },
    ],
  ])('keeps the reader in place when %s lands after they scrolled up', (_label, landed) => {
    renderStreamingTurn();
    const container = scrollListTo(100);

    landBelow(container, landed);

    expect(container.scrollTop).toBe(100);
  });

  it('re-arms auto-scroll when the reader scrolls back to the bottom', () => {
    renderStreamingTurn();
    expect(component.followsNewOutput()).toBe(true);
    const container = scrollListTo(100);
    expect(component.followsNewOutput()).toBe(false);
    scrollListTo(590);
    expect(component.followsNewOutput()).toBe(true);

    landBelow(container, reply);

    expect(container.scrollTop).toBe(1400);
  });

  it('re-arms auto-scroll on an auto-scroll request even after the user scrolled up', () => {
    fixture.componentRef.setInput('messages', [first]);
    fakeOnChanges();
    fixture.detectChanges();
    const container = scrollListTo(100);

    fixture.componentRef.setInput('autoScrollRequest', 1);
    landBelow(container, {
      role: 'user',
      blocks: [{ type: 'text', content: 'second' }],
      timestamp: 2,
    });

    expect(container.scrollTop).toBe(1400);
  });

  it('suppresses the pin on a conversation key change and re-derives from a mid-scroll restored viewport', () => {
    const container = switchTabsMidScroll(0, 0);
    expect(container.scrollTop).toBe(100);

    streamDelta();

    expect(container.scrollTop).toBe(100);
  });

  it('does not take the request counter a tab switch brings along as a new request', () => {
    const container = switchTabsMidScroll(3, 7);
    streamDelta();
    expect(container.scrollTop).toBe(100);

    fixture.componentRef.setInput('autoScrollRequest', 8);
    fakeOnChanges();
    fixture.detectChanges();

    expect(container.scrollTop).toBe(1000);
  });

  it('re-derives to pinned when the restored viewport is at the bottom', () => {
    fixture.componentRef.setInput('conversationKey', 't1');
    fixture.componentRef.setInput('messages', [first]);
    fakeOnChanges();
    fixture.detectChanges();
    const container = scrollListTo(100);

    fixture.componentRef.setInput('conversationKey', 't2');
    fixture.componentRef.setInput('messages', []);
    fakeOnChanges();
    container.scrollTop = 590;
    fixture.detectChanges();

    streamDelta();

    expect(container.scrollTop).toBe(1000);
  });

  it('isPrecedingUserEdited returns false for index 0', () => {
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
    ]);
    expect(component.isPrecedingUserEdited(0)).toBe(false);
  });

  it('isPrecedingUserEdited returns false for user entries', () => {
    fixture.componentRef.setInput('messages', [
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'hi' }],
        timestamp: 1,
        edited_at: 100,
      },
      { role: 'user', blocks: [{ type: 'text', content: 'hey' }], timestamp: 2 },
    ]);
    expect(component.isPrecedingUserEdited(1)).toBe(false);
  });

  it('isPrecedingUserEdited returns true when assistant follows an edited user entry', () => {
    fixture.componentRef.setInput('messages', [
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'hi' }],
        timestamp: 1,
        edited_at: 100,
      },
      { role: 'assistant', blocks: [{ type: 'text', content: 'hello' }], timestamp: 2 },
    ]);
    expect(component.isPrecedingUserEdited(1)).toBe(true);
  });

  it('isPrecedingUserEdited returns false when preceding user has no edited_at', () => {
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
      { role: 'assistant', blocks: [{ type: 'text', content: 'hello' }], timestamp: 2 },
    ]);
    expect(component.isPrecedingUserEdited(1)).toBe(false);
  });

  it('isPrecedingUserEdited returns false for out-of-bounds index', () => {
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
    ]);
    expect(component.isPrecedingUserEdited(5)).toBe(false);
  });

  it('re-emits questionAnswered from child chat-message', () => {
    fixture.componentRef.setInput('messages', [
      { role: 'assistant', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
    ]);
    fakeOnChanges();
    fixture.detectChanges();

    let captured: { toolId: string; questionIdx: number; value: string } | null = null;
    component.questionAnswered.subscribe((e) => (captured = e));

    const childDbg: DebugElement = fixture.debugElement.query(
      (de: DebugElement) => de.componentInstance instanceof ChatMessageComponent
    );
    expect(childDbg).not.toBeNull();
    (childDbg.componentInstance as ChatMessageComponent).questionAnswered.emit({
      toolId: 't1',
      questionIdx: 0,
      value: 'a',
    });

    expect(captured).toEqual({ toolId: 't1', questionIdx: 0, value: 'a' });
  });

  describe('jump-to-bottom button', () => {
    function jumpButton(): HTMLButtonElement | null {
      return fixture.nativeElement.querySelector('[data-testid="chat-jump-to-bottom"]');
    }

    it('is hidden while the viewport shows the end of the list', () => {
      fixture.componentRef.setInput('messages', [first]);
      fakeOnChanges();
      fixture.detectChanges();
      scrollListTo(600);
      fixture.detectChanges();
      expect(jumpButton()).toBeNull();
    });

    it('appears once the reader scrolls up, whether or not a find bar is open', () => {
      fixture.componentRef.setInput('messages', [first]);
      fakeOnChanges();
      fixture.detectChanges();
      scrollListTo(100);
      fixture.detectChanges();
      expect(jumpButton()).not.toBeNull();
      expect(jumpButton()!.getAttribute('aria-label')).toBe('Scroll to bottom');
    });

    it('scrolls to the end, pins new output there again and hides itself when clicked', () => {
      renderStreamingTurn();
      const container = scrollListTo(100);
      fixture.detectChanges();
      expect(component.followsNewOutput()).toBe(false);

      jumpButton()!.click();
      fixture.detectChanges();

      expect(container.scrollTop).toBe(1000);
      expect(component.followsNewOutput()).toBe(true);
      expect(jumpButton()).toBeNull();

      container.scrollTop = 600;
      landBelow(container, reply);
      expect(container.scrollTop).toBe(1400);
    });
  });

  describe('find in chat', () => {
    const FIND_DEBOUNCE_MS = 150;
    const registry = new Map<string, { range: Range }>();
    let emitted: ChatFindState[];

    beforeEach(() => {
      vi.useFakeTimers();
      registry.clear();
      class FakeHighlight {
        constructor(readonly range: Range) {}
        clear(): void {}
      }
      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { highlights: registry },
      });
      Object.defineProperty(globalThis, 'Highlight', { configurable: true, value: FakeHighlight });
      emitted = [];
      component.findChanged.subscribe((s) => emitted.push(s));
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (globalThis as { CSS?: unknown }).CSS;
      delete (globalThis as { Highlight?: unknown }).Highlight;
    });

    const conversation: ChatMessage[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'find the needle' }], timestamp: 1 },
      {
        role: 'assistant',
        blocks: [{ type: 'text', content: 'A **needle** in a haystack, and another needle.' }],
        timestamp: 2,
      },
    ];

    function setFind(patch: Partial<ChatFindState>): void {
      fixture.componentRef.setInput('find', { ...DEFAULT_FIND_STATE, open: true, ...patch });
      fakeOnChanges();
      fixture.detectChanges();
    }

    function settle(): void {
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS);
      fixture.detectChanges();
    }

    /** Lets the MutationObserver deliver (a microtask) before the debounce runs. */
    async function settleAfterDom(): Promise<void> {
      await Promise.resolve();
      settle();
    }

    function bar(): HTMLElement | null {
      return fixture.nativeElement.querySelector('[data-testid="chat-find-bar"]');
    }

    function countText(): string {
      return (
        fixture.nativeElement
          .querySelector('[data-testid="chat-find-count"]')
          ?.textContent?.trim() ?? ''
      );
    }

    function currentHighlight(): string {
      return registry.get('chat-find')?.range.toString() ?? '';
    }

    function container(): HTMLDivElement {
      return fixture.nativeElement.querySelector(
        '[data-testid="chat-message-list"]'
      ) as HTMLDivElement;
    }

    it('renders no bar while the state is closed', () => {
      fixture.componentRef.setInput('messages', conversation);
      fakeOnChanges();
      fixture.detectChanges();
      expect(bar()).toBeNull();
    });

    it('counts every occurrence across messages and formatting after the debounce, and highlights the current one', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'needle' });
      expect(countText()).toBe('0/0');

      settle();

      expect(component.findTotal()).toBe(3);
      expect(countText()).toBe('1/3');
      expect(currentHighlight()).toBe('needle');
      expect(
        registry.get('chat-find')!.range.startContainer.parentElement?.closest('[data-role="user"]')
      ).not.toBeNull();
    });

    it('matches across bold formatting in the rendered text, not the Markdown source', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'A needle in' });
      settle();
      expect(component.findTotal()).toBe(1);
      expect(currentHighlight()).toBe('A needle in');
    });

    it('honours match case and regex, and flags a regex that does not compile', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'Needle', matchCase: true });
      settle();
      expect(component.findTotal()).toBe(0);
      expect(countText()).toBe('0/0');
      expect(registry.has('chat-find')).toBe(false);

      setFind({ query: 'need\\w+', regex: true });
      settle();
      expect(component.findTotal()).toBe(3);
      expect(component.findInvalid()).toBe(false);

      setFind({ query: 'need(', regex: true });
      settle();
      expect(component.findTotal()).toBe(0);
      expect(component.findInvalid()).toBe(true);
      expect(countText()).toBe('0/0');
    });

    it('steps forward and backward with wrap-around and reports the moved index', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'needle' });
      settle();

      component.findNext();
      expect(emitted.at(-1)?.current).toBe(1);
      setFind({ query: 'needle', current: 1 });
      component.findNext();
      expect(emitted.at(-1)?.current).toBe(2);
      setFind({ query: 'needle', current: 2 });
      component.findNext();
      expect(emitted.at(-1)?.current).toBe(0);
      setFind({ query: 'needle', current: 0 });
      component.findPrevious();
      expect(emitted.at(-1)?.current).toBe(2);
      expect(currentHighlight()).toBe('needle');
    });

    it('is inert without matches', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'zzz' });
      settle();
      const before = emitted.length;
      component.findNext();
      component.findPrevious();
      expect(emitted.length).toBe(before);
    });

    it('keeps the current match and recounts when streamed content lands', async () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'needle', current: 2 });
      settle();
      expect(component.findTotal()).toBe(3);
      const before = emitted.length;

      fixture.componentRef.setInput('currentBlocks', [{ type: 'text', content: 'needle needle' }]);
      fixture.componentRef.setInput('isStreaming', true);
      fakeOnChanges();
      fixture.detectChanges();
      expect(component.findTotal()).toBe(3);
      await settleAfterDom();

      expect(component.findTotal()).toBe(5);
      expect(emitted.slice(before)).toEqual([]);
      expect(currentHighlight()).toBe('needle');
    });

    it('clamps the current match when content shrinks below it', async () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'needle', current: 2 });
      settle();

      fixture.componentRef.setInput('messages', [conversation[0]]);
      fakeOnChanges();
      fixture.detectChanges();
      await settleAfterDom();

      expect(component.findTotal()).toBe(1);
      expect(emitted.at(-1)?.current).toBe(0);
    });

    it('recounts when a thinking block is expanded or collapsed', async () => {
      fixture.componentRef.setInput('messages', [
        {
          role: 'assistant',
          blocks: [
            { type: 'thinking', content: 'the needle is here', collapsed: true },
            { type: 'text', content: 'needle' },
          ],
          timestamp: 1,
        },
      ]);
      setFind({ query: 'needle' });
      settle();
      expect(component.findTotal()).toBe(1);

      const details = container().querySelector('details') as HTMLDetailsElement;
      details.open = true;
      await settleAfterDom();
      expect(component.findTotal()).toBe(2);

      details.open = false;
      await settleAfterDom();
      expect(component.findTotal()).toBe(1);
    });

    it('searches an expanded tool result and not a collapsed one', async () => {
      fixture.componentRef.setInput('messages', [
        {
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              tool: {
                id: 't1',
                tool_name: 'Read',
                input_json: '{"file_path":"/src/needle.rs"}',
                status: 'done',
                result: 'needle needle',
                result_is_error: false,
              },
            },
          ],
          timestamp: 1,
        },
      ]);
      setFind({ query: 'needle' });
      settle();
      expect(component.findTotal()).toBe(0);

      (container().querySelector('[aria-expanded="false"]') as HTMLElement).click();
      fixture.detectChanges();
      await settleAfterDom();
      expect(component.findTotal()).toBe(2);
    });

    it('forwards the bar: typing, the toggles and close', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: '' });
      let closed = 0;
      component.findClosed.subscribe(() => (closed += 1));
      const input = fixture.nativeElement.querySelector(
        '[data-testid="chat-find-input"]'
      ) as HTMLInputElement;
      input.value = 'nee';
      input.dispatchEvent(new Event('input'));
      expect(emitted.at(-1)).toMatchObject({ query: 'nee' });

      (
        fixture.nativeElement.querySelector('[data-testid="chat-find-regex"]') as HTMLElement
      ).click();
      expect(emitted.at(-1)?.regex).toBe(true);
      (
        fixture.nativeElement.querySelector('[data-testid="chat-find-case"]') as HTMLElement
      ).click();
      expect(emitted.at(-1)?.matchCase).toBe(true);

      (
        fixture.nativeElement.querySelector('[data-testid="chat-find-close"]') as HTMLElement
      ).click();
      expect(closed).toBe(1);
    });

    it('clears the highlight and the count when the bar closes', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'needle' });
      settle();
      expect(registry.has('chat-find')).toBe(true);

      setFind({ open: false, query: 'needle' });

      expect(bar()).toBeNull();
      expect(registry.has('chat-find')).toBe(false);
      expect(component.findTotal()).toBe(0);
    });

    it('restores the stored current match on reopen without moving the view', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'needle', current: 2 });
      settle();
      setFind({ open: false, query: 'needle', current: 2 });
      const list = container();
      list.getBoundingClientRect = () => new DOMRect(0, 100, 600, 400);
      list.scrollTop = 333;

      setFind({ query: 'needle', current: 2 });
      settle();

      expect(component.findTotal()).toBe(3);
      expect(countText()).toBe('3/3');
      expect(emitted).toEqual([]);
      expect(list.scrollTop).toBe(333);
      expect(
        registry
          .get('chat-find')!
          .range.startContainer.parentElement?.closest('[data-role="assistant"]')
      ).not.toBeNull();
    });

    it('keeps the incoming tab stored match and viewport on a tab switch, even with another query', () => {
      fixture.componentRef.setInput('conversationKey', 't1');
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'haystack' });
      settle();
      expect(component.findTotal()).toBe(1);

      fixture.componentRef.setInput('conversationKey', 't2');
      const list = container();
      list.scrollTop = 222;
      setFind({ query: 'needle', current: 1 });
      settle();

      expect(component.findTotal()).toBe(3);
      expect(countText()).toBe('2/3');
      expect(emitted).toEqual([]);
      expect(list.scrollTop).toBe(222);
    });

    it('picks the first match at or below the viewport when the query changes, and scrolls it into view', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: '' });
      settle();
      const list = container();
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      list.getBoundingClientRect = () => new DOMRect(0, 100, 600, 400);
      const articles = Array.from(
        fixture.nativeElement.querySelectorAll('[data-testid="chat-message"]')
      ) as HTMLElement[];
      const userScope = articles[0].querySelector('[data-find-scope]') as HTMLElement;
      userScope.getBoundingClientRect = () => new DOMRect(0, 20, 600, 20);
      for (const el of Array.from(articles[1].querySelectorAll('*')) as HTMLElement[]) {
        el.getBoundingClientRect = () => new DOMRect(0, 700, 600, 20);
      }

      setFind({ query: 'needle' });
      settle();

      expect(emitted.at(-1)?.current).toBe(1);
      expect(list.scrollTop).toBe(700 - 100 - (400 - 20) / 2);
    });

    it('focuses the bar on a focus request', async () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'needle' });
      fixture.componentRef.setInput('findFocusRequest', 1);
      fixture.detectChanges();
      await fixture.whenStable();
      const input = fixture.nativeElement.querySelector('[data-testid="chat-find-input"]');
      expect(document.activeElement).toBe(input);
    });

    it('reports the single-line selection inside the list and nothing else', () => {
      fixture.componentRef.setInput('messages', conversation);
      fakeOnChanges();
      fixture.detectChanges();
      const inside = container().querySelector('[data-find-scope]')!.firstChild;
      const stub = (text: string, anchor: Node | null, collapsed = false): void => {
        vi.spyOn(document, 'getSelection').mockReturnValue({
          anchorNode: anchor,
          isCollapsed: collapsed,
          toString: () => text,
        } as unknown as Selection);
      };

      stub('needle', inside);
      expect(component.selectedText()).toBe('needle');
      stub('two\nlines', inside);
      expect(component.selectedText()).toBe('');
      stub('needle', inside, true);
      expect(component.selectedText()).toBe('');
      stub('needle', document.body);
      expect(component.selectedText()).toBe('');
    });

    it('drops a pending recompute and the highlight on destroy', () => {
      fixture.componentRef.setInput('messages', conversation);
      setFind({ query: 'needle' });
      settle();
      setFind({ query: 'needles' });
      fixture.destroy();
      vi.advanceTimersByTime(FIND_DEBOUNCE_MS);
      expect(registry.has('chat-find')).toBe(false);
      expect(emitted.at(-1)?.query).toBeUndefined();
    });
  });
});
