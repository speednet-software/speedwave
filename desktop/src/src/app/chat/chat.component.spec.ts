import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { RouterModule } from '@angular/router';
import { ChatComponent } from './chat.component';
import { TauriService } from '../services/tauri.service';
import { ChatStateService } from '../services/chat-state.service';
import { ProjectStateService } from '../services/project-state.service';
import { UiStateService } from '../services/ui-state.service';
import { LoggerService } from '../services/logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('ChatComponent', () => {
  let component: ChatComponent;
  let fixture: ComponentFixture<ChatComponent>;
  let mockTauri: MockTauriService;
  let chatState: ChatStateService;
  let projectState: ProjectStateService;
  let uiState: UiStateService;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockLogger = makeMockLogger();

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
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: mockLogger },
      ],
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

  // ── resumeConversation: transcript-loading flag ────────────────────────────

  describe('resumeConversation loading flag', () => {
    it('sets loadingTranscript true during fetch and false after it resolves', async () => {
      projectState.activeProject.set('test');

      let releaseGetConversation: (() => void) | null = null;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') {
          await new Promise<void>((resolve) => {
            releaseGetConversation = resolve;
          });
          return { session_id: 's1', messages: [] };
        }
        return undefined;
      };

      const resumePromise = component.resumeConversation('11111111-1111-1111-1111-111111111111');
      await Promise.resolve();
      // Mid-flight: loader is showing.
      expect(chatState.loadingTranscriptFromState()).toBe(true);

      releaseGetConversation!();
      await resumePromise;
      // Settled: loader is hidden.
      expect(chatState.loadingTranscriptFromState()).toBe(false);
    });

    it('clears loadingTranscript even when get_conversation fails', async () => {
      projectState.activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') throw new Error('boom');
        return undefined;
      };

      await component.resumeConversation('11111111-1111-1111-1111-111111111111');

      expect(chatState.loadingTranscriptFromState()).toBe(false);
    });

    it('marks startingSession during resume so a racing send does not start a competing chat', async () => {
      projectState.activeProject.set('test');
      // Wrap the real disposer so we can assert when the start-in-progress flag
      // is released (the disposer replaces the old endStartingSession method).
      const dispose = vi.fn();
      const begin = vi.spyOn(chatState, 'beginStartingSession').mockReturnValue(dispose);

      let releaseGetConversation: (() => void) | null = null;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') {
          await new Promise<void>((resolve) => {
            releaseGetConversation = resolve;
          });
          return { session_id: 's1', messages: [] };
        }
        return undefined;
      };

      const resumePromise = component.resumeConversation('11111111-1111-1111-1111-111111111111');
      await Promise.resolve();
      // Mid-flight: the start-in-progress flag is set, not yet cleared.
      expect(begin).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();

      releaseGetConversation!();
      await resumePromise;
      // Settled: disposer released so later sends can start a session normally.
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  // ── Composition — shell sub-components ─────────────────────────────────────

  describe('shell composition', () => {
    it('renders app-chat-header and app-chat-message-list once project is ready', async () => {
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      await component.ngOnInit();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('app-chat-header')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-chat-message-list')).toBeTruthy();
    });

    it('renders the choose-a-provider surface when status is no_provider', async () => {
      projectState.activeProject.set('test');
      projectState.status.set('no_provider');
      await component.ngOnInit();
      fixture.detectChanges();

      const view = fixture.nativeElement.querySelector('[data-testid="chat-view-no-provider"]');
      expect(view).toBeTruthy();
      expect(view.textContent).toContain('No LLM provider selected');
      const link = view.querySelector('a');
      expect(link).toBeTruthy();
      expect(link.getAttribute('href')).toBe('/settings');
      // Header (with project pill) stays available so the user can switch away;
      // the composer is still gone since there is no conversation.
      expect(fixture.nativeElement.querySelector('app-chat-header')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-project-pill')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-composer')).toBeNull();
    });

    it('keeps the project pill reachable when status is auth_required', async () => {
      projectState.activeProject.set('test');
      projectState.status.set('auth_required');
      await component.ngOnInit();
      fixture.detectChanges();

      const view = fixture.nativeElement.querySelector('[data-testid="chat-view-blocked"]');
      expect(view).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-chat-header')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-project-pill')).toBeTruthy();
      expect(fixture.nativeElement.querySelector('app-composer')).toBeNull();
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
      // ComposerComponent emits already-trimmed text; empty payload = empty composer state.
      await component.sendMessage({ payload: '', displayText: '' });

      expect(chatState.messages).toHaveLength(0);
    });

    it('does not send when isStreaming is true', async () => {
      chatState.isStreaming = true;

      await component.sendMessage({ payload: 'Hello', displayText: 'Hello' });

      expect(chatState.messages).toHaveLength(0);
    });
  });

  // ── sendMessage success ────────────────────────────────────────────────────

  describe('sendMessage success', () => {
    it('adds user message and sets isStreaming', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockResolvedValue(undefined);

      await component.sendMessage({ payload: 'Hello Claude', displayText: 'Hello Claude' });

      expect(chatState.messages).toHaveLength(1);
      expect(chatState.messages[0].role).toBe('user');
      expect(chatState.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hello Claude' });
      expect(chatState.isStreaming).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith('send_message', {
        blocks: [{ type: 'text', text: 'Hello Claude' }],
        displayText: 'Hello Claude',
      });
    });

    it('handles invoke failure by adding error message and stopping streaming', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') {
          throw new Error('Connection refused');
        }
        return undefined;
      };

      await component.sendMessage({ payload: 'Hello', displayText: 'Hello' });

      expect(chatState.isStreaming).toBe(false);
      expect(chatState.messages).toHaveLength(2);
      const errorBlock = chatState.messages[1].blocks[0];
      expect(errorBlock.type).toBe('error');
    });
  });

  // ── composer integration ─────────────────────────────────────────────────
  describe('composer integration', () => {
    it('mounts app-composer when a live session is active', async () => {
      projectState.status.set('ready');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-composer')).toBeTruthy();
    });
  });

  // ── onQuestionAnswered ──────────────────────────────────────────────────

  describe('onQuestionAnswered', () => {
    it('calls submitAnswer with the correct tool ID, slot index, and value', async () => {
      chatState.handleStreamChunk({
        chunk_type: 'AskUserQuestion',
        data: {
          tool_id: 'test-tool',
          questions: [
            {
              question: 'Pick one',
              header: '',
              options: [{ label: 'A', value: 'a' }],
              multi_select: false,
            },
          ],
          current_index: 0,
        },
      });

      const answerSpy = vi.spyOn(chatState, 'submitAnswer').mockResolvedValue();

      await component.onQuestionAnswered({
        toolId: 'test-tool',
        questionIdx: 0,
        value: 'answer1',
      });

      expect(answerSpy).toHaveBeenCalledWith('test-tool', 0, 'answer1');
    });
  });

  // ── loadConversations ───────────────────────────────────────────────────────

  describe('loadConversations', () => {
    it('calls backend with active project and sets conversations', async () => {
      const mockConversations = [
        { session_id: 's1', timestamp: '2026-03-06T10:00:00Z', preview: 'Hello', message_count: 3 },
      ];
      projectState.activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') return mockConversations;
        return undefined;
      };

      await component.loadConversations();

      expect(component.conversations).toEqual(mockConversations);
      expect(component.historyLoading).toBe(false);
    });

    it('handles missing active project by setting empty conversations', async () => {
      projectState.activeProject.set(null);

      await component.loadConversations();

      expect(component.conversations).toEqual([]);
    });

    it('sets historyError on backend failure', async () => {
      projectState.activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') throw new Error('network error');
        return undefined;
      };

      await component.loadConversations();

      expect(component.historyError).toContain('Failed to load conversations');
      expect(component.conversations).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('loadConversations failed: Error: network error')
      );
    });

    it('sets historyLoading while loading', async () => {
      projectState.activeProject.set('test');
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

  // ── resume decider lifecycle (ngOnInit / ngOnDestroy) ──────────────────────

  describe('resume decider lifecycle', () => {
    it('ngOnInit registers a resume decider function on the service', async () => {
      const setSpy = vi.spyOn(chatState, 'setResumeDecider');
      await component.ngOnInit();
      // A mounted component opts into the overflow prompt via a callback.
      const last = setSpy.mock.calls[setSpy.mock.calls.length - 1]?.[0];
      expect(typeof last).toBe('function');
    });

    it('ngOnDestroy clears the resume decider so the service auto-resumes while unmounted', async () => {
      await component.ngOnInit();
      const setSpy = vi.spyOn(chatState, 'setResumeDecider');
      component.ngOnDestroy();
      expect(setSpy).toHaveBeenCalledWith(null);
    });
  });

  // ── resumeConversation ──────────────────────────────────────────────────────

  describe('resumeConversation', () => {
    it('calls resume_conversation and closes the sidebar', async () => {
      projectState.activeProject.set('test');
      uiState.toggleSidebar();
      const invokeCalls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        invokeCalls.push(cmd);
        return undefined;
      };

      await component.resumeConversation('s1');

      expect(invokeCalls).toContain('resume_conversation');
      expect(component.showHistory).toBe(false);
    });

    it('shows error message when resume fails', async () => {
      projectState.activeProject.set('test');
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

    it('does not leave the failed session marked active', async () => {
      projectState.activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'resume_conversation') throw new Error('container not running');
        return undefined;
      };

      await component.resumeConversation('11111111-1111-1111-1111-111111111111');

      // Optimistic accent cleared on failure → drawer doesn't show it as active.
      expect(component.currentViewSessionId).toBeNull();
    });

    it('routes auth error in resumeConversation to retryAuth', async () => {
      const retrySpy = vi.spyOn(projectState, 'retryAuth').mockResolvedValue();
      projectState.activeProject.set('test');

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'resume_conversation')
          throw new Error('Claude is not authenticated. Please authenticate first.');
        return undefined;
      };

      await component.resumeConversation('s1');
      expect(retrySpy).toHaveBeenCalled();
      retrySpy.mockRestore();
    });
  });

  // ── deleteConversation ──────────────────────────────────────────────────────

  describe('deleteConversation', () => {
    it('calls delete_conversation and removes the row locally', async () => {
      projectState.activeProject.set('test');
      component.conversations = [
        { session_id: 's1', timestamp: null, preview: 'a', message_count: 1 },
        { session_id: 's2', timestamp: null, preview: 'b', message_count: 1 },
      ];
      const calls: { cmd: string; args: unknown }[] = [];
      mockTauri.invokeHandler = async (cmd: string, args: unknown) => {
        calls.push({ cmd, args });
        return undefined;
      };

      await component.deleteConversation('s1');

      expect(calls).toContainEqual({
        cmd: 'delete_conversation',
        args: { project: 'test', sessionId: 's1' },
      });
      expect(component.conversations.map((c) => c.session_id)).toEqual(['s2']);
    });

    it('does nothing when no active project', async () => {
      projectState.activeProject.set(null);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.deleteConversation('s1');
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('sets historyError when backend fails and keeps the row', async () => {
      projectState.activeProject.set('test');
      component.conversations = [
        { session_id: 's1', timestamp: null, preview: 'a', message_count: 1 },
      ];
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'delete_conversation') throw new Error('io error');
        return undefined;
      };

      await component.deleteConversation('s1');

      expect(component.historyError).toContain('Failed to delete conversation');
      expect(component.conversations.length).toBe(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('deleteConversation failed: Error: io error')
      );
    });

    it('resets live chat when deleting the active session', async () => {
      projectState.activeProject.set('test');
      chatState._setState({
        messages: [],
        currentBlocks: [],
        sessionStats: {
          session_id: 's1',
          total_cost: 0,
          context_window_size: null,
          total_output_tokens: 0,
        },
      });
      component.conversations = [
        { session_id: 's1', timestamp: null, preview: 'a', message_count: 1 },
      ];
      const resetSpy = vi.spyOn(chatState, 'resetForNewConversation');
      mockTauri.invokeHandler = async () => undefined;

      await component.deleteConversation('s1');

      expect(resetSpy).toHaveBeenCalled();
      expect(component.conversations).toEqual([]);
    });

    it('clears the durable restart-resume id when deleting that session even if it is not the viewed one', async () => {
      projectState.activeProject.set('test');
      // Durable id points at an older session; the live view shows a different one.
      chatState.seedResumedSession('s-old');
      chatState._setState({
        sessionStats: {
          session_id: 's-live',
          total_cost: 0,
          context_window_size: null,
          total_output_tokens: 0,
        },
      });
      expect(chatState.lastKnownSessionId).toBe('s-old');
      component.conversations = [
        { session_id: 's-old', timestamp: null, preview: 'a', message_count: 1 },
      ];
      const resetSpy = vi.spyOn(chatState, 'resetForNewConversation');
      mockTauri.invokeHandler = async () => undefined;

      await component.deleteConversation('s-old');

      // The durable id is cleared so a later restart cannot resume a deleted session…
      expect(chatState.lastKnownSessionId).toBeNull();
      // …while the viewed session keeps running (no live-chat reset).
      expect(resetSpy).not.toHaveBeenCalled();
      expect(component.conversations).toEqual([]);
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
      uiState.toggleSidebar();
      uiState.toggleMemory();

      await component.newConversation();

      expect(chatState.messages).toEqual([]);
      expect(chatState.isStreaming).toBe(false);
      expect(chatState.currentBlocks).toEqual([]);
      expect(component.showHistory).toBe(false);
      expect(component.showMemory).toBe(false);
    });
  });

  // ── toggleHistory / toggleMemory ────────────────────────────────────────────

  describe('toggleHistory', () => {
    it('toggles showHistory boolean', async () => {
      projectState.activeProject.set('test');
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
      projectState.activeProject.set('test');
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
      projectState.activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') throw new Error('disk failure');
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('loadProjectMemory failed: Error: disk failure')
      );
    });

    it('sets projectMemory on success', async () => {
      projectState.activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') return '# Project Memory\nSome content';
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('# Project Memory\nSome content');
    });

    it('sets empty string on backend failure without throwing', async () => {
      projectState.activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') throw new Error('file not found');
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('');
    });

    it('sets empty string when no active project', async () => {
      projectState.activeProject.set(null);

      await component.loadProjectMemory();

      expect(component.projectMemory).toBe('');
    });

    it('surfaces user-facing memoryError on backend failure (parity with historyError)', async () => {
      projectState.activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_project_memory') throw new Error('disk failure');
        return undefined;
      };

      await component.loadProjectMemory();

      expect(component.memoryError).toContain('Failed to load memory');
      expect(component.memoryError).toContain('disk failure');
    });

    it('clears memoryError on a subsequent successful load', async () => {
      projectState.activeProject.set('test');
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
    });

    it('does not set memoryError when no active project', async () => {
      projectState.activeProject.set(null);
      component.memoryError = 'stale';

      await component.loadProjectMemory();

      expect(component.memoryError).toBe('');
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
      projectState.activeProject.set('test');
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
      projectState.activeProject.set('other-project');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_conversations') return newConversations;
        return undefined;
      };

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
      await fixture.whenStable();

      expect(component.conversations).toEqual(newConversations);
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

      projectState.status.set('ready');
      await component.ngOnInit();
      fixture.detectChanges();

      // Simulate auth expiry via notifyChange
      projectState.status.set('auth_required');
      projectState['notifyChange']();

      expect(navigateSpy).toHaveBeenCalledWith(['/settings']);
      navigateSpy.mockRestore();
    });
  });

  describe('Stop button and ESC handler', () => {
    it('shows Stop button when streaming, hides it when idle', () => {
      // Send button lives in <app-composer>; chat.component owns only the Stop button.
      projectState.status.set('ready');
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
      projectState.status.set('ready');
      const spy = vi.spyOn(chatState, 'stopConversation').mockResolvedValue();
      chatState.isStreaming = true;
      // isStreamingFromState() refreshes only after notifyChange rebuilds the tree.
      chatState['notifyChange']();
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
              questions: [{ question: 'q?', header: '', options: [], multi_select: false }],
              current_index: 0,
              answers: [null],
            },
          },
        ],
      });
      // currentBlocksFromState() sees the block only after notifyChange rebuilds the tree.
      chatState['notifyChange']();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('Stop button still stops when an unanswered ask_user block is active', () => {
      projectState.status.set('ready');
      const spy = vi.spyOn(chatState, 'stopConversation').mockResolvedValue();
      chatState.isStreaming = true;
      chatState._setState({
        currentBlocks: [
          {
            type: 'ask_user',
            question: {
              tool_id: 't1',
              questions: [{ question: 'q?', header: '', options: [], multi_select: false }],
              current_index: 0,
              answers: [null],
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

  // ── context-overflow dialog ─────────────────────────────────────────────────

  describe('context-overflow dialog', () => {
    it('promptResumeOrFresh opens the dialog and resolves "resume" on confirm', async () => {
      const choice = component.promptResumeOrFresh();
      expect(component.contextOverflowOpen()).toBe(true);
      component.onContextOverflowResume();
      expect(component.contextOverflowOpen()).toBe(false);
      await expect(choice).resolves.toBe('resume');
    });

    it('promptResumeOrFresh resolves "fresh" when the user starts fresh', async () => {
      const choice = component.promptResumeOrFresh();
      component.onContextOverflowFresh();
      expect(component.contextOverflowOpen()).toBe(false);
      await expect(choice).resolves.toBe('fresh');
    });

    it('renders the confirm dialog HTML while open and hides it when closed', async () => {
      // The overlay renders into a CDK Dialog container on document.body, not
      // into fixture.nativeElement — query the document.
      projectState.status.set('ready');
      await component.ngOnInit();
      component.promptResumeOrFresh();
      fixture.detectChanges();
      expect(document.querySelector('[data-testid="context-overflow-overlay"]')).toBeTruthy();

      component.onContextOverflowFresh();
      fixture.detectChanges();
      expect(document.querySelector('[data-testid="context-overflow-overlay"]')).toBeNull();
    });

    it('ngOnDestroy resolves a pending dialog as "fresh" (no leak)', async () => {
      const choice = component.promptResumeOrFresh();
      component.ngOnDestroy();
      await expect(choice).resolves.toBe('fresh');
    });

    it('a second promptResumeOrFresh resolves the pending prior dialog as "fresh"', async () => {
      const first = component.promptResumeOrFresh();
      const second = component.promptResumeOrFresh();

      // Re-entrancy: the superseded prompt settles (fresh) instead of leaking.
      await expect(first).resolves.toBe('fresh');
      expect(component.contextOverflowOpen()).toBe(true);

      // Only the latest prompt is still user-controlled.
      component.onContextOverflowResume();
      await expect(second).resolves.toBe('resume');
      expect(component.contextOverflowOpen()).toBe(false);
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
