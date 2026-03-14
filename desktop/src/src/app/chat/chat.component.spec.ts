import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatComponent } from './chat.component';
import { TauriService } from '../services/tauri.service';
import { ChatStateService } from '../services/chat-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('ChatComponent', () => {
  let component: ChatComponent;
  let fixture: ComponentFixture<ChatComponent>;
  let mockTauri: MockTauriService;
  let chatState: ChatStateService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    // Default: list_projects returns an active project, containers running, start_chat succeeds
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'check_containers_running':
          return true;
        case 'start_chat':
          return undefined;
        case 'send_message':
          return undefined;
        default:
          return undefined;
      }
    };

    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    chatState = TestBed.inject(ChatStateService);

    // Reset service state between tests
    chatState.messages = [];
    chatState.currentBlocks = [];
    chatState.isStreaming = false;
    chatState.sessionStats = null;
    chatState.containerStatus = 'checking';
    chatState.containerError = '';
  });

  // ── handleStreamChunk: 'Text' ──────────────────────────────────────────────

  describe('handleStreamChunk Text', () => {
    it('accumulates text in currentBlocks and sets isStreaming to true', () => {
      chatState.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello ' } });

      expect(chatState.currentBlocks).toHaveLength(1);
      expect(chatState.currentBlocks[0]).toEqual({ type: 'text', content: 'Hello ' });
      expect(chatState.isStreaming).toBe(true);

      chatState.handleStreamChunk({ chunk_type: 'Text', data: { content: 'world!' } });

      expect(chatState.currentBlocks).toHaveLength(1);
      expect(chatState.currentBlocks[0]).toEqual({ type: 'text', content: 'Hello world!' });
    });
  });

  // ── handleStreamChunk: 'Result' ────────────────────────────────────────────

  describe('handleStreamChunk Result', () => {
    it('saves accumulated currentBlocks as assistant message and stops streaming', () => {
      chatState.handleStreamChunk({
        chunk_type: 'Text',
        data: { content: 'Accumulated response' },
      });

      expect(chatState.isStreaming).toBe(true);

      chatState.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', cost_usd: 0.01, total_cost: 0.05 },
      });

      expect(chatState.isStreaming).toBe(false);
      expect(chatState.currentBlocks).toHaveLength(0);
      expect(chatState.messages).toHaveLength(1);
      expect(chatState.messages[0].blocks[0]).toEqual({
        type: 'text',
        content: 'Accumulated response',
      });
    });

    it('does not add a message when currentBlocks is empty', () => {
      chatState.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });

      expect(chatState.isStreaming).toBe(false);
      expect(chatState.messages).toHaveLength(0);
    });
  });

  // ── handleStreamChunk: 'Error' ─────────────────────────────────────────────

  describe('handleStreamChunk Error', () => {
    it('adds error block, finalizes message, and stops streaming', () => {
      chatState.isStreaming = true;
      chatState.currentBlocks = [{ type: 'text', content: 'partial data' }];

      chatState.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'Something went wrong' },
      });

      expect(chatState.isStreaming).toBe(false);
      expect(chatState.currentBlocks).toHaveLength(0);
      expect(chatState.messages).toHaveLength(1);
      expect(chatState.messages[0].blocks).toHaveLength(2);
      expect(chatState.messages[0].blocks[1]).toEqual({
        type: 'error',
        content: 'Something went wrong',
      });
    });
  });

  // ── handleStreamChunk: 'ToolStart' ─────────────────────────────────────────

  describe('handleStreamChunk ToolStart', () => {
    it('adds tool_use block to currentBlocks', () => {
      chatState.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });

      expect(chatState.currentBlocks).toHaveLength(1);
      const block = chatState.currentBlocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use') {
        expect(block.tool.tool_name).toBe('Read');
        expect(block.tool.status).toBe('running');
      }
    });
  });

  // ── handleStreamChunk: 'Thinking' ──────────────────────────────────────────

  describe('handleStreamChunk Thinking', () => {
    it('creates thinking block', () => {
      chatState.handleStreamChunk({ chunk_type: 'Thinking', data: { content: 'hmm...' } });

      expect(chatState.currentBlocks).toHaveLength(1);
      expect(chatState.currentBlocks[0]).toEqual({
        type: 'thinking',
        content: 'hmm...',
        collapsed: true,
      });
    });
  });

  // ── sendMessage guards ─────────────────────────────────────────────────────

  describe('sendMessage guards', () => {
    it('does not send when input text is empty', async () => {
      component.inputText = '   ';

      await component.sendMessage();

      expect(chatState.messages).toHaveLength(0);
    });

    it('does not send when isStreaming is true', async () => {
      component.inputText = 'Hello';
      chatState.isStreaming = true;

      await component.sendMessage();

      expect(chatState.messages).toHaveLength(0);
    });
  });

  // ── sendMessage success ────────────────────────────────────────────────────

  describe('sendMessage success', () => {
    it('adds user message, clears input, and sets isStreaming', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockResolvedValue(undefined);

      component.inputText = 'Hello Claude';

      await component.sendMessage();

      expect(chatState.messages).toHaveLength(1);
      expect(chatState.messages[0].role).toBe('user');
      expect(chatState.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hello Claude' });
      expect(component.inputText).toBe('');
      expect(chatState.isStreaming).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith('send_message', { message: 'Hello Claude' });
    });

    it('handles invoke failure by adding error message and stopping streaming', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') {
          throw new Error('Connection refused');
        }
        return undefined;
      };

      component.inputText = 'Hello';
      await component.sendMessage();

      expect(chatState.isStreaming).toBe(false);
      // User message + error message
      expect(chatState.messages).toHaveLength(2);
      const errorBlock = chatState.messages[1].blocks[0];
      expect(errorBlock.type).toBe('error');
    });
  });

  // ── onEnter ────────────────────────────────────────────────────────────────

  describe('onEnter', () => {
    it('calls sendMessage when Enter is pressed without Shift', () => {
      const sendSpy = vi.spyOn(component, 'sendMessage').mockResolvedValue();
      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      component.onEnter(event);

      expect(preventSpy).toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalled();
    });

    it('does NOT call sendMessage when Shift+Enter is pressed', () => {
      const sendSpy = vi.spyOn(component, 'sendMessage').mockResolvedValue();
      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      component.onEnter(event);

      expect(preventSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  // ── loadConversations ───────────────────────────────────────────────────────

  describe('loadConversations', () => {
    it('calls backend with active project and sets conversations', async () => {
      const mockConversations = [
        { session_id: 's1', timestamp: '2026-03-06T10:00:00Z', preview: 'Hello', message_count: 3 },
      ];
      chatState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') return mockConversations;
        return undefined;
      };

      await component.loadConversations();

      expect(component.conversations).toEqual(mockConversations);
      expect(component.historyLoading).toBe(false);
    });

    it('handles missing active project by setting empty conversations', async () => {
      chatState.activeProject = null;

      await component.loadConversations();

      expect(component.conversations).toEqual([]);
    });

    it('sets historyError on backend failure', async () => {
      chatState.activeProject = 'test';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') throw new Error('network error');
        return undefined;
      };

      await component.loadConversations();

      expect(component.historyError).toContain('Failed to load conversations');
      expect(component.conversations).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('loadConversations failed:', expect.any(Error));
      errorSpy.mockRestore();
    });

    it('sets historyLoading while loading', async () => {
      chatState.activeProject = 'test';
      let capturedLoading = false;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') {
          capturedLoading = component.historyLoading;
          return [];
        }
        return undefined;
      };

      await component.loadConversations();

      expect(capturedLoading).toBe(true);
      expect(component.historyLoading).toBe(false);
    });
  });

  // ── viewConversation ────────────────────────────────────────────────────────

  describe('viewConversation', () => {
    it('sets viewingTranscript from backend response', async () => {
      const mockTranscript = {
        session_id: 's1',
        messages: [{ role: 'user', content: 'Hi', timestamp: '2026-03-06T10:00:00Z' }],
      };
      chatState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') return mockTranscript;
        return undefined;
      };

      await component.viewConversation('s1');

      expect(component.viewingTranscript).toEqual(mockTranscript);
    });

    it('sets viewError on backend failure', async () => {
      chatState.activeProject = 'test';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') throw new Error('not found');
        return undefined;
      };

      await component.viewConversation('s1');

      expect(component.viewError).toContain('Failed to load conversation');
      expect(component.viewingTranscript).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('viewConversation failed:', expect.any(Error));
      errorSpy.mockRestore();
    });
  });

  // ── resumeConversation ──────────────────────────────────────────────────────

  describe('resumeConversation', () => {
    it('populates messages from transcript and calls resume_conversation', async () => {
      const invokeCalls: string[] = [];
      const mockTranscript = {
        session_id: 's1',
        messages: [
          { role: 'user', content: 'Hi', timestamp: '2026-03-06T10:00:00Z' },
          { role: 'assistant', content: 'Hello!', timestamp: null },
        ],
      };
      component.viewingTranscript = mockTranscript;
      chatState.activeProject = 'test';

      mockTauri.invokeHandler = async (cmd: string) => {
        invokeCalls.push(cmd);
        return undefined;
      };

      await component.resumeConversation('s1');

      expect(chatState.messages).toHaveLength(2);
      expect(chatState.messages[0].role).toBe('user');
      expect(chatState.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hi' });
      expect(chatState.messages[1].role).toBe('assistant');
      expect(chatState.messages[1].blocks[0]).toEqual({ type: 'text', content: 'Hello!' });
      expect(invokeCalls).toContain('resume_conversation');
    });

    it('uses msg.blocks when available instead of flat content', async () => {
      const mockTranscript = {
        session_id: 's1',
        messages: [
          {
            role: 'user',
            content: 'Hi',
            timestamp: null,
            blocks: [
              { type: 'text' as const, content: 'Hi' },
              { type: 'text' as const, content: ' there' },
            ],
          },
        ],
      };
      component.viewingTranscript = mockTranscript;
      chatState.activeProject = 'test';

      await component.resumeConversation('s1');

      expect(chatState.messages).toHaveLength(1);
      expect(chatState.messages[0].blocks).toHaveLength(2);
      expect(chatState.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hi' });
      expect(chatState.messages[0].blocks[1]).toEqual({ type: 'text', content: ' there' });
    });

    it('shows error message when resume fails', async () => {
      const mockTranscript = {
        session_id: 's1',
        messages: [{ role: 'user', content: 'Hi', timestamp: null }],
      };
      component.viewingTranscript = mockTranscript;
      chatState.activeProject = 'test';

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'resume_conversation') throw new Error('container not running');
        return undefined;
      };

      await component.resumeConversation('s1');

      const lastMsg = chatState.messages[chatState.messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.blocks[0].type).toBe('error');
      expect((lastMsg.blocks[0] as { type: 'error'; content: string }).content).toContain(
        'Failed to resume session'
      );
    });

    it('clears transcript and history state after resuming', async () => {
      component.viewingTranscript = {
        session_id: 's1',
        messages: [{ role: 'user', content: 'Hi', timestamp: null }],
      };
      component.showHistory = true;
      chatState.activeProject = 'test';

      await component.resumeConversation('s1');

      expect(component.viewingTranscript).toBeNull();
      expect(component.showHistory).toBe(false);
    });
  });

  // ── newConversation ─────────────────────────────────────────────────────────

  describe('newConversation', () => {
    it('resets all state and re-initialises', async () => {
      chatState.messages = [
        { role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 },
      ];
      component.inputText = 'partial';
      chatState.isStreaming = true;
      chatState.currentBlocks = [{ type: 'text', content: 'stream' }];
      component.viewingTranscript = { session_id: 's1', messages: [] };
      component.showHistory = true;
      component.showMemory = true;

      await component.newConversation();

      expect(chatState.messages).toEqual([]);
      expect(component.inputText).toBe('');
      expect(chatState.isStreaming).toBe(false);
      expect(chatState.currentBlocks).toEqual([]);
      expect(component.viewingTranscript).toBeNull();
      expect(component.showHistory).toBe(false);
      expect(component.showMemory).toBe(false);
    });
  });

  // ── toggleHistory / toggleMemory ────────────────────────────────────────────

  describe('toggleHistory', () => {
    it('toggles showHistory boolean', async () => {
      chatState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') return [];
        return undefined;
      };

      expect(component.showHistory).toBe(false);
      await component.toggleHistory();
      expect(component.showHistory).toBe(true);
      await component.toggleHistory();
      expect(component.showHistory).toBe(false);
    });
  });

  describe('toggleMemory', () => {
    it('toggles showMemory boolean', async () => {
      chatState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') return 'memory content';
        return undefined;
      };

      expect(component.showMemory).toBe(false);
      await component.toggleMemory();
      expect(component.showMemory).toBe(true);
      await component.toggleMemory();
      expect(component.showMemory).toBe(false);
    });
  });

  describe('loadProjectMemory', () => {
    it('logs error on failure', async () => {
      chatState.activeProject = 'test';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') throw new Error('disk failure');
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('');
      expect(errorSpy).toHaveBeenCalledWith('loadProjectMemory failed:', expect.any(Error));
      errorSpy.mockRestore();
    });
  });

  // ── loadProjectMemory ──────────────────────────────────────────────────────

  describe('loadProjectMemory', () => {
    it('sets projectMemory on success', async () => {
      chatState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') return '# Project Memory\nSome content';
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('# Project Memory\nSome content');
    });

    it('sets empty string on backend failure without throwing', async () => {
      chatState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') throw new Error('file not found');
        return undefined;
      };

      // Should not throw
      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('');
    });

    it('sets empty string when no active project', async () => {
      chatState.activeProject = null;

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('');
    });
  });

  // ── closeTranscript ─────────────────────────────────────────────────────────

  describe('closeTranscript', () => {
    it('clears viewingTranscript', () => {
      component.viewingTranscript = { session_id: 's1', messages: [] };

      component.closeTranscript();

      expect(component.viewingTranscript).toBeNull();
    });
  });

  // ── onLinkClick — external links open in system browser ───────────────────

  describe('onLinkClick', () => {
    it('opens https links via open_url and prevents default', () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const anchor = document.createElement('a');
      anchor.setAttribute('href', 'https://example.com');
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: anchor });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      component.onLinkClick(event);

      expect(preventSpy).toHaveBeenCalled();
      expect(invokeSpy).toHaveBeenCalledWith('open_url', { url: 'https://example.com' });
    });

    it('opens http links via open_url', () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const anchor = document.createElement('a');
      anchor.setAttribute('href', 'http://example.com');
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: anchor });

      component.onLinkClick(event);

      expect(invokeSpy).toHaveBeenCalledWith('open_url', { url: 'http://example.com' });
    });

    it('ignores clicks on non-link elements', () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const span = document.createElement('span');
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: span });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      component.onLinkClick(event);

      expect(preventSpy).not.toHaveBeenCalled();
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('ignores links without href', () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const anchor = document.createElement('a');
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: anchor });

      component.onLinkClick(event);

      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('ignores non-http links (e.g. anchor fragments)', () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#section');
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: anchor });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      component.onLinkClick(event);

      expect(preventSpy).not.toHaveBeenCalled();
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('handles clicks on elements inside a link (bubbling)', () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const anchor = document.createElement('a');
      anchor.setAttribute('href', 'https://example.com/docs');
      const code = document.createElement('code');
      anchor.appendChild(code);
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'target', { value: code });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      component.onLinkClick(event);

      expect(preventSpy).toHaveBeenCalled();
      expect(invokeSpy).toHaveBeenCalledWith('open_url', { url: 'https://example.com/docs' });
    });
  });

  // ── state persistence ─────────────────────────────────────────────────────

  describe('state persistence', () => {
    it('ChatStateService is a singleton — state survives component recreation', () => {
      chatState.messages.push({
        role: 'user',
        blocks: [{ type: 'text', content: 'persisted' }],
        timestamp: 1,
      });
      chatState.containerStatus = 'running';

      // Destroy and recreate
      fixture.destroy();
      const fixture2 = TestBed.createComponent(ChatComponent);
      const component2 = fixture2.componentInstance;

      expect(component2.chat.messages).toHaveLength(1);
      expect(component2.chat.messages[0].blocks[0]).toEqual({ type: 'text', content: 'persisted' });
      expect(component2.chat.containerStatus).toBe('running');
      fixture2.destroy();
    });
  });
});
