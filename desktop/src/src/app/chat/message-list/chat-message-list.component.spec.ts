import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DebugElement } from '@angular/core';
import { ChatMessageListComponent } from './chat-message-list.component';
import { ChatMessageComponent } from '../message/chat-message.component';
import { ToolNormalizerService } from '../../services/tool-normalizer.service';
import type { ChatMessage, MessageBlock } from '../../models/chat';

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

  it('pins scroll to bottom on new messages when user is at the bottom', () => {
    const messages: ChatMessage[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'first' }], timestamp: 1 },
    ];
    fixture.componentRef.setInput('messages', messages);
    fakeOnChanges();
    fixture.detectChanges();

    const container = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list"]'
    ) as HTMLDivElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    container.scrollTop = 600;
    container.dispatchEvent(new Event('scroll'));

    fixture.componentRef.setInput('messages', [
      ...messages,
      { role: 'assistant', blocks: [{ type: 'text', content: 'second' }], timestamp: 2 },
    ]);
    fakeOnChanges();
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1400 });
    fixture.detectChanges();

    expect(container.scrollTop).toBe(1400);
  });

  it('re-arms auto-scroll on a new message even after the user scrolled up', () => {
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'first' }], timestamp: 1 },
    ]);
    fakeOnChanges();
    fixture.detectChanges();

    const container = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list"]'
    ) as HTMLDivElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    container.scrollTop = 100;
    container.dispatchEvent(new Event('scroll'));

    fixture.componentRef.setInput('messages', [
      ...component.messages(),
      { role: 'assistant', blocks: [{ type: 'text', content: 'second' }], timestamp: 2 },
    ]);
    fakeOnChanges();
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1400 });
    fixture.detectChanges();

    expect(container.scrollTop).toBe(1400);
  });

  it('suppresses the pin on a conversation key change and re-derives from a mid-scroll restored viewport', () => {
    fixture.componentRef.setInput('conversationKey', 't1');
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'first' }], timestamp: 1 },
    ]);
    fakeOnChanges();
    fixture.detectChanges();

    const container = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list"]'
    ) as HTMLDivElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    container.scrollTop = 600;
    container.dispatchEvent(new Event('scroll'));

    fixture.componentRef.setInput('conversationKey', 't2');
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'a' }], timestamp: 1 },
      { role: 'assistant', blocks: [{ type: 'text', content: 'b' }], timestamp: 2 },
      { role: 'user', blocks: [{ type: 'text', content: 'c' }], timestamp: 3 },
    ]);
    fakeOnChanges();
    container.scrollTop = 100;
    fixture.detectChanges();

    expect(container.scrollTop).toBe(100);

    fixture.componentRef.setInput('currentBlocks', [{ type: 'text', content: 'delta' }]);
    fixture.componentRef.setInput('isStreaming', true);
    fakeOnChanges();
    fixture.detectChanges();

    expect(container.scrollTop).toBe(100);
  });

  it('re-derives to pinned when the restored viewport is at the bottom', () => {
    fixture.componentRef.setInput('conversationKey', 't1');
    fixture.componentRef.setInput('messages', [
      { role: 'user', blocks: [{ type: 'text', content: 'first' }], timestamp: 1 },
    ]);
    fakeOnChanges();
    fixture.detectChanges();

    const container = fixture.nativeElement.querySelector(
      '[data-testid="chat-message-list"]'
    ) as HTMLDivElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    container.scrollTop = 100;
    container.dispatchEvent(new Event('scroll'));

    fixture.componentRef.setInput('conversationKey', 't2');
    fixture.componentRef.setInput('messages', []);
    fakeOnChanges();
    container.scrollTop = 590;
    fixture.detectChanges();

    fixture.componentRef.setInput('currentBlocks', [{ type: 'text', content: 'delta' }]);
    fixture.componentRef.setInput('isStreaming', true);
    fakeOnChanges();
    fixture.detectChanges();

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
});
