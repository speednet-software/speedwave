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
    // `messages` is required; seed with empty so `setInput` can mutate later.
    fixture.componentRef.setInput('messages', []);
  });

  /**
   * Replays `ngOnChanges` after a manual property set — mirrors what Angular
   * does when a template binding changes. Signal `input()` does NOT trigger
   * lifecycle `ngOnChanges`, so tests must invoke it explicitly.
   */
  function fakeOnChanges(): void {
    component.ngOnChanges();
  }

  // ── Happy path — per-message rendering ────────────────────────────────

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

  // ── Streaming: last entry has streaming=true ──────────────────────────

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

    // When the last block is a text block, the per-block streaming caret renders
    // (data-testid="streaming-caret") and the message-level cursor is suppressed
    // by lastBlockIsText.
    const caret = fixture.nativeElement.querySelector('[data-testid="streaming-caret"]');
    expect(caret).not.toBeNull();
  });

  it('renders the awaiting caret while streaming has started but no block has arrived', () => {
    fixture.componentRef.setInput('messages', []);
    fixture.componentRef.setInput('currentBlocks', []);
    fixture.componentRef.setInput('isStreaming', true);
    fakeOnChanges();
    fixture.detectChanges();

    // The full streaming bubble is suppressed (no blocks yet)…
    expect(
      fixture.nativeElement.querySelector('[data-testid="chat-message-list-streaming"]')
    ).toBeNull();
    // …but a standalone blinking caret tells the user the assistant started.
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
    // And no awaiting caret either when the turn isn't running.
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

  // ── ARIA — log role + polite live region ──────────────────────────────

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

  // ── Auto-scroll logic ────────────────────────────────────────────────

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
    container.scrollTop = 600; // at bottom
    container.dispatchEvent(new Event('scroll'));

    fixture.componentRef.setInput('messages', [
      ...messages,
      { role: 'assistant', blocks: [{ type: 'text', content: 'second' }], timestamp: 2 },
    ]);
    fakeOnChanges();
    // Grow content height before Angular runs ngAfterViewChecked.
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1400 });
    fixture.detectChanges();

    expect(container.scrollTop).toBe(1400);
  });

  it('re-arms auto-scroll on a new message even after the user scrolled up', () => {
    // Product decision: a new turn (length grew) snaps the view back to the
    // bottom unconditionally. Streaming deltas that arrive on the *same*
    // turn still respect a manual scroll-up, but the next user-visible
    // message wins so the freshly-arrived content is always in sight.
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
    container.scrollTop = 100; // user scrolled up
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

  // ── isPrecedingUserEdited helper ─────────────────────────────────────

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

  // ── Forwarding the questionAnswered event ────────────────────────────

  it('re-emits questionAnswered from child chat-message', () => {
    fixture.componentRef.setInput('messages', [
      { role: 'assistant', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
    ]);
    fakeOnChanges();
    fixture.detectChanges();

    let captured: { toolId: string; values: string[] } | null = null;
    component.questionAnswered.subscribe((e) => (captured = e));

    const childDbg: DebugElement = fixture.debugElement.query(
      (de: DebugElement) => de.componentInstance instanceof ChatMessageComponent
    );
    expect(childDbg).not.toBeNull();
    (childDbg.componentInstance as ChatMessageComponent).questionAnswered.emit({
      toolId: 't1',
      values: ['a'],
    });

    expect(captured).toEqual({ toolId: 't1', values: ['a'] });
  });
});
