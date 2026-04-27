import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { RouterModule } from '@angular/router';
import { ChatComponent } from './chat.component';
import { TauriService } from '../services/tauri.service';
import { ChatStateService } from '../services/chat-state.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('ChatComponent', () => {
  let component: ChatComponent;
  let fixture: ComponentFixture<ChatComponent>;
  let mockTauri: MockTauriService;
  let chatState: ChatStateService;
  let projectState: ProjectStateService;
  let uiState: UiStateService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'get_bundle_reconcile_state':
          return {
            phase: 'done',
            in_progress: false,
            last_error: null,
            pending_running_projects: [],
            applied_bundle_id: null,
          };
        case 'check_containers_running':
          return true;
        case 'start_containers':
          return undefined;
        case 'start_chat':
          return undefined;
        case 'send_message':
          return undefined;
        default:
          return undefined;
      }
    };

    await TestBed.configureTestingModule({
      imports: [ChatComponent, RouterModule.forRoot([])],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    chatState = TestBed.inject(ChatStateService);
    projectState = TestBed.inject(ProjectStateService);
    uiState = TestBed.inject(UiStateService);

    // Reset service state between tests
    chatState._setState({ messages: [], currentBlocks: [], sessionStats: null });
    chatState.isStreaming = false;
  });

  // ── Composition — shell sub-components ─────────────────────────────────────

  describe('shell composition', () => {
    it('renders app-chat-header and app-chat-message-list once project is ready', async () => {
      projectState.activeProject = 'test';
      projectState.status = 'ready';
      await component.ngOnInit();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('app-chat-header')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-chat-message-list')).toBeTruthy();
    });

    it('does not render the message list while a transcript is being viewed', async () => {
      projectState.activeProject = 'test';
      projectState.status = 'ready';
      await component.ngOnInit();
      component.viewingTranscript = { session_id: 's1', messages: [] };
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('app-chat-message-list')).toBeNull();
      // Chat header stays visible while viewing a transcript.
      expect(fixture.nativeElement.querySelector('app-chat-header')).toBeTruthy();
    });
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
        data: { session_id: 'abc', total_cost: 0.05 },
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
      chatState._setState({ currentBlocks: [{ type: 'text', content: 'partial data' }] });

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
      // ComposerComponent contract: emits already-trimmed text, so an empty
      // payload here represents a whitespace-only or empty composer state.
      await component.sendMessage('');

      expect(chatState.messages).toHaveLength(0);
    });

    it('does not send when isStreaming is true', async () => {
      chatState.isStreaming = true;

      await component.sendMessage('Hello');

      expect(chatState.messages).toHaveLength(0);
    });
  });

  // ── sendMessage success ────────────────────────────────────────────────────

  describe('sendMessage success', () => {
    it('adds user message and sets isStreaming', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockResolvedValue(undefined);

      await component.sendMessage('Hello Claude');

      expect(chatState.messages).toHaveLength(1);
      expect(chatState.messages[0].role).toBe('user');
      expect(chatState.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hello Claude' });
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

      await component.sendMessage('Hello');

      expect(chatState.isStreaming).toBe(false);
      expect(chatState.messages).toHaveLength(2);
      const errorBlock = chatState.messages[1].blocks[0];
      expect(errorBlock.type).toBe('error');
    });
  });

  // ── composer integration ─────────────────────────────────────────────────
  describe('composer integration', () => {
    it('mounts app-composer when a live session is active', async () => {
      projectState.status = 'ready';
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-composer')).toBeTruthy();
    });
  });

  // ── onQuestionAnswered ──────────────────────────────────────────────────

  describe('onQuestionAnswered', () => {
    it('calls answerQuestion with the correct tool ID and values', async () => {
      chatState.handleStreamChunk({
        chunk_type: 'AskUserQuestion',
        data: {
          tool_id: 'test-tool',
          question: 'Pick one',
          options: [{ label: 'A', value: 'a' }],
          header: '',
          multi_select: false,
        },
      });

      const answerSpy = vi.spyOn(chatState, 'answerQuestion').mockResolvedValue();

      await component.onQuestionAnswered({ toolId: 'test-tool', values: ['answer1'] });

      expect(answerSpy).toHaveBeenCalledWith('test-tool', ['answer1']);
    });
  });

  // ── loadConversations ───────────────────────────────────────────────────────

  describe('loadConversations', () => {
    it('calls backend with active project and sets conversations', async () => {
      const mockConversations = [
        { session_id: 's1', timestamp: '2026-03-06T10:00:00Z', preview: 'Hello', message_count: 3 },
      ];
      projectState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') return mockConversations;
        return undefined;
      };

      await component.loadConversations();

      expect(component.conversations).toEqual(mockConversations);
      expect(component.historyLoading).toBe(false);
    });

    it('handles missing active project by setting empty conversations', async () => {
      projectState.activeProject = null;

      await component.loadConversations();

      expect(component.conversations).toEqual([]);
    });

    it('sets historyError on backend failure', async () => {
      projectState.activeProject = 'test';
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
      projectState.activeProject = 'test';
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
      projectState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') return mockTranscript;
        return undefined;
      };

      await component.viewConversation('s1');

      expect(component.viewingTranscript).toEqual(mockTranscript);
    });

    it('sets viewError on backend failure', async () => {
      projectState.activeProject = 'test';
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
      projectState.activeProject = 'test';

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
      projectState.activeProject = 'test';

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
      projectState.activeProject = 'test';

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

    it('routes auth error in resumeConversation to retryAuth', async () => {
      const retrySpy = vi.spyOn(projectState, 'retryAuth').mockResolvedValue();
      const mockTranscript = {
        session_id: 's1',
        messages: [{ role: 'user', content: 'Hi', timestamp: '2026-03-06T10:00:00Z' }],
      };
      component.viewingTranscript = mockTranscript;
      projectState.activeProject = 'test';

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'resume_conversation')
          throw new Error('Claude is not authenticated. Please authenticate first.');
        return undefined;
      };

      await component.resumeConversation('s1');
      expect(retrySpy).toHaveBeenCalled();
      retrySpy.mockRestore();
    });

    it('normalizes history tool_use blocks into nested format', async () => {
      component.viewingTranscript = {
        session_id: 's1',
        messages: [
          {
            role: 'assistant',
            content: '[Tool: Read]',
            timestamp: null,
            blocks: [
              { type: 'tool_use', tool_name: 'Read', input_json: '{"file":"/a.ts"}' },
              { type: 'tool_result', content: 'file contents', is_error: false },
            ] as unknown as import('../models/chat').MessageBlock[],
          },
        ],
      };
      projectState.activeProject = 'test';

      await component.resumeConversation('s1');

      const msgs = chatState.messages;
      expect(msgs).toHaveLength(1);
      const block = msgs[0].blocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use' && block.tool.status !== 'running') {
        expect(block.tool.tool_name).toBe('Read');
        expect(block.tool.input_json).toBe('{"file":"/a.ts"}');
        expect(block.tool.status).toBe('done');
        expect(block.tool.result).toBe('file contents');
      }
    });

    it('normalizes history tool_use error result', async () => {
      component.viewingTranscript = {
        session_id: 's1',
        messages: [
          {
            role: 'assistant',
            content: '[Tool: Bash]',
            timestamp: null,
            blocks: [
              { type: 'tool_use', tool_name: 'Bash', input_json: '{"command":"fail"}' },
              { type: 'tool_result', content: 'command not found', is_error: true },
            ] as unknown as import('../models/chat').MessageBlock[],
          },
        ],
      };
      projectState.activeProject = 'test';

      await component.resumeConversation('s1');

      const block = chatState.messages[0].blocks[0];
      if (block.type === 'tool_use' && block.tool.status !== 'running') {
        expect(block.tool.status).toBe('error');
        expect(block.tool.result_is_error).toBe(true);
        expect(block.tool.result).toBe('command not found');
      }
    });

    it('passes through already-normalized tool_use blocks', async () => {
      const normalizedTool = {
        type: 'tool_use' as const,
        tool: {
          type: 'tool_use' as const,
          tool_id: 't1',
          tool_name: 'Read',
          input_json: '{}',
          status: 'done' as const,
          result: 'ok',
          result_is_error: false as const,
        },
      };
      component.viewingTranscript = {
        session_id: 's1',
        messages: [
          {
            role: 'assistant',
            content: 'test',
            timestamp: null,
            blocks: [normalizedTool],
          },
        ],
      };
      projectState.activeProject = 'test';

      await component.resumeConversation('s1');

      const block = chatState.messages[0].blocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use') {
        expect(block.tool.tool_id).toBe('t1');
      }
    });

    it('clears transcript and history state after resuming', async () => {
      component.viewingTranscript = {
        session_id: 's1',
        messages: [{ role: 'user', content: 'Hi', timestamp: null }],
      };
      uiState.toggleSidebar();
      projectState.activeProject = 'test';

      await component.resumeConversation('s1');

      expect(component.viewingTranscript).toBeNull();
      expect(component.showHistory).toBe(false);
    });

    it('calls resume_conversation directly when viewingTranscript is null (sidebar shortcut)', async () => {
      component.viewingTranscript = null;
      projectState.activeProject = 'test';
      const invokeCalls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        invokeCalls.push(cmd);
        return undefined;
      };

      await component.resumeConversation('s1');

      expect(invokeCalls).toContain('resume_conversation');
      expect(chatState.messages).toHaveLength(0);
    });
  });

  // ── newConversation ─────────────────────────────────────────────────────────

  describe('newConversation', () => {
    it('resets all state and re-initialises', async () => {
      chatState._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [{ type: 'text', content: 'stream' }],
      });
      chatState.isStreaming = true;
      component.viewingTranscript = { session_id: 's1', messages: [] };
      uiState.toggleSidebar();
      uiState.toggleMemory();

      await component.newConversation();

      expect(chatState.messages).toEqual([]);
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
      projectState.activeProject = 'test';
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
      projectState.activeProject = 'test';
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
      projectState.activeProject = 'test';
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

    it('sets projectMemory on success', async () => {
      projectState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') return '# Project Memory\nSome content';
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('# Project Memory\nSome content');
    });

    it('sets empty string on backend failure without throwing', async () => {
      projectState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') throw new Error('file not found');
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('');
    });

    it('sets empty string when no active project', async () => {
      projectState.activeProject = null;

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('');
    });

    it('surfaces user-facing memoryError on backend failure (parity with historyError)', async () => {
      projectState.activeProject = 'test';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') throw new Error('disk failure');
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.memoryError).toContain('Failed to load memory');
      expect(component.memoryError).toContain('disk failure');
      errorSpy.mockRestore();
    });

    it('clears memoryError on a subsequent successful load', async () => {
      projectState.activeProject = 'test';
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let shouldFail = true;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') {
          if (shouldFail) throw new Error('first failure');
          return '# recovered';
        }
        return undefined;
      };

      await component.loadProjectMemory();
      expect(component.memoryError).not.toBe('');

      shouldFail = false;
      await component.loadProjectMemory();

      expect(component.memoryError).toBe('');
      expect(component.projectMemory).toBe('# recovered');
      errorSpy.mockRestore();
    });

    it('does not set memoryError when no active project', async () => {
      projectState.activeProject = null;
      component.memoryError = 'stale';

      await component.loadProjectMemory();

      expect(component.memoryError).toBe('');
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

  // ── project_switch_succeeded event ──────────────────────────────────────────

  describe('project_switch_succeeded event', () => {
    it('reloads conversations when history panel is open', async () => {
      projectState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') return [];
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state')
          return {
            phase: 'done',
            in_progress: false,
            last_error: null,
            pending_running_projects: [],
            applied_bundle_id: null,
          };
        if (cmd === 'check_containers_running') return true;
        if (cmd === 'start_chat') return undefined;
        return undefined;
      };

      await projectState.init();
      await component.ngOnInit();
      uiState.toggleSidebar();
      component.conversations = [
        { session_id: 's1', timestamp: '2026-03-06T10:00:00Z', preview: 'old', message_count: 1 },
      ];

      const newConversations = [
        { session_id: 's2', timestamp: '2026-03-07T10:00:00Z', preview: 'new', message_count: 2 },
      ];
      projectState.activeProject = 'other-project';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') return newConversations;
        return undefined;
      };

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
      await fixture.whenStable();

      expect(component.conversations).toEqual(newConversations);
    });

    it('closes transcript view on project switch', async () => {
      projectState.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state')
          return {
            phase: 'done',
            in_progress: false,
            last_error: null,
            pending_running_projects: [],
            applied_bundle_id: null,
          };
        if (cmd === 'check_containers_running') return true;
        if (cmd === 'start_chat') return undefined;
        return undefined;
      };

      await projectState.init();
      await component.ngOnInit();
      component.viewingTranscript = { session_id: 's1', messages: [] };

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
      await fixture.whenStable();

      expect(component.viewingTranscript).toBeNull();
    });

    it('cleans up project ready listener on destroy', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state')
          return {
            phase: 'done',
            in_progress: false,
            last_error: null,
            pending_running_projects: [],
            applied_bundle_id: null,
          };
        if (cmd === 'check_containers_running') return true;
        if (cmd === 'start_chat') return undefined;
        return undefined;
      };

      await projectState.init();
      await component.ngOnInit();

      expect(
        (component as unknown as { unsubProjectReady: unknown })['unsubProjectReady']
      ).not.toBeNull();

      component.ngOnDestroy();

      expect(
        (component as unknown as { unsubProjectReady: unknown })['unsubProjectReady']
      ).toBeNull();
    });
  });

  // ── state persistence ─────────────────────────────────────────────────────

  describe('state persistence', () => {
    it('ChatStateService is a singleton — state survives component recreation', () => {
      chatState._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'persisted' }],
            timestamp: 1,
          },
        ],
      });

      fixture.destroy();
      const fixture2 = TestBed.createComponent(ChatComponent);
      const component2 = fixture2.componentInstance;

      expect(component2.chat.messages).toHaveLength(1);
      expect(component2.chat.messages[0].blocks[0]).toEqual({ type: 'text', content: 'persisted' });
      fixture2.destroy();
    });
  });

  // ── Auth-expired redirect ───────────────────────────────────────────────

  describe('auth-expired redirect', () => {
    it('navigates to /settings when projectState becomes auth_required', async () => {
      const router = TestBed.inject(Router);
      const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

      projectState.status = 'ready';
      await component.ngOnInit();
      fixture.detectChanges();

      // Simulate auth expiry via notifyChange
      projectState.status = 'auth_required';
      projectState['notifyChange']();

      expect(navigateSpy).toHaveBeenCalledWith(['/settings']);
      navigateSpy.mockRestore();
    });
  });

  describe('Stop button and ESC handler', () => {
    it('shows Stop button when streaming, hides it when idle', () => {
      // After Unit 9 (composer extraction), the Send button lives inside
      // <app-composer>; chat.component owns only the Stop button alongside.
      projectState.status = 'ready';
      chatState.isStreaming = false;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="chat-stop"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-composer')).toBeTruthy();

      chatState.isStreaming = true;
      chatState['notifyChange']();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="chat-stop"]')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-composer')).toBeTruthy();
    });

    it('clicking Stop calls stopConversation', () => {
      projectState.status = 'ready';
      const spy = vi.spyOn(chatState, 'stopConversation').mockResolvedValue();
      chatState.isStreaming = true;
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="chat-stop"]').click();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('pressing ESC while streaming calls stopConversation', () => {
      const spy = vi.spyOn(chatState, 'stopConversation').mockResolvedValue();
      chatState.isStreaming = true;
      fixture.detectChanges();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('pressing ESC while idle does nothing', () => {
      const spy = vi.spyOn(chatState, 'stopConversation').mockResolvedValue();
      chatState.isStreaming = false;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('pressing ESC does not stop when an unanswered ask_user block is active', () => {
      const spy = vi.spyOn(chatState, 'stopConversation').mockResolvedValue();
      chatState.isStreaming = true;
      chatState._setState({
        currentBlocks: [
          {
            type: 'ask_user',
            question: {
              tool_id: 't1',
              question: 'q?',
              options: [],
              header: '',
              multi_select: false,
              answered: false,
              selected_values: [],
            },
          },
        ],
      });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('Stop button still stops when an unanswered ask_user block is active', () => {
      projectState.status = 'ready';
      const spy = vi.spyOn(chatState, 'stopConversation').mockResolvedValue();
      chatState.isStreaming = true;
      chatState._setState({
        currentBlocks: [
          {
            type: 'ask_user',
            question: {
              tool_id: 't1',
              question: 'q?',
              options: [],
              header: '',
              multi_select: false,
              answered: false,
              selected_values: [],
            },
          },
        ],
      });
      chatState['notifyChange']();
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="chat-stop"]').click();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('ngOnDestroy removes the ESC listener', () => {
      const spy = vi.spyOn(chatState, 'stopConversation').mockResolvedValue();
      fixture.destroy();
      chatState.isStreaming = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── isLastAssistant: O(1) cached lookup ────────────────────────────────────

  describe('isLastAssistant', () => {
    it('returns false when there are no messages', () => {
      chatState.loadMessages([]);
      expect(component.isLastAssistant(0)).toBe(false);
    });

    it('returns true for the most recent assistant message', () => {
      chatState.loadMessages([
        { role: 'user', blocks: [{ type: 'text', content: 'hi' }], timestamp: 1 },
        { role: 'assistant', blocks: [{ type: 'text', content: 'A1' }], timestamp: 2 },
        { role: 'user', blocks: [{ type: 'text', content: 'next' }], timestamp: 3 },
        { role: 'assistant', blocks: [{ type: 'text', content: 'A2' }], timestamp: 4 },
      ]);
      expect(component.isLastAssistant(3)).toBe(true);
      expect(component.isLastAssistant(1)).toBe(false);
    });

    it('returns false for non-assistant rows even at the tail', () => {
      chatState.loadMessages([
        { role: 'assistant', blocks: [{ type: 'text', content: 'A1' }], timestamp: 1 },
        { role: 'user', blocks: [{ type: 'text', content: 'after' }], timestamp: 2 },
      ]);
      expect(component.isLastAssistant(0)).toBe(true);
      expect(component.isLastAssistant(1)).toBe(false);
    });

    it('returns false for every row when no assistant message exists', () => {
      chatState.loadMessages([
        { role: 'user', blocks: [{ type: 'text', content: 'q1' }], timestamp: 1 },
        { role: 'user', blocks: [{ type: 'text', content: 'q2' }], timestamp: 2 },
      ]);
      expect(component.isLastAssistant(0)).toBe(false);
      expect(component.isLastAssistant(1)).toBe(false);
    });

    it('updates the cached last index when new messages are appended', () => {
      chatState.loadMessages([
        { role: 'user', blocks: [{ type: 'text', content: 'q' }], timestamp: 1 },
        { role: 'assistant', blocks: [{ type: 'text', content: 'A1' }], timestamp: 2 },
      ]);
      expect(component.isLastAssistant(1)).toBe(true);

      chatState.loadMessages([
        { role: 'user', blocks: [{ type: 'text', content: 'q' }], timestamp: 1 },
        { role: 'assistant', blocks: [{ type: 'text', content: 'A1' }], timestamp: 2 },
        { role: 'user', blocks: [{ type: 'text', content: 'q2' }], timestamp: 3 },
        { role: 'assistant', blocks: [{ type: 'text', content: 'A2' }], timestamp: 4 },
      ]);
      expect(component.isLastAssistant(1)).toBe(false);
      expect(component.isLastAssistant(3)).toBe(true);
    });
  });
});
