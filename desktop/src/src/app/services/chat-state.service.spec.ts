import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  ChatStateService,
  MODEL_SWITCH_NOT_APPLIED,
  NEW_CONVERSATION_AUTH,
  NEW_CONVERSATION_BUSY,
  NEW_CONVERSATION_FAILED,
  NEW_CONVERSATION_NO_PROJECT,
  NEW_CONVERSATION_STREAMING,
  historyFitsTarget,
  isNotAuthenticatedError,
  mapContextOverflowError,
  mapNotLoggedInError,
  messageBlocksToState,
  stateBlocksToMessageBlocks,
  toChatMessages,
} from './chat-state.service';
import { ProjectStateService } from './project-state.service';
import { TauriService } from './tauri.service';
import { AnthropicModelsService } from './anthropic-models.service';
import { LoggerService } from './logger.service';
import { PlanUsageService } from './plan-usage.service';
import { MockTauriService, MOCK_BUNDLE_RECONCILE_DONE } from '../testing/mock-tauri.service';
import { createDeferred, type Deferred } from '../testing/deferred';
import { makeMockLogger } from '../testing/mock-logger';
import type { ConversationTranscript, StreamChunk, ToolUseBlock } from '../models/chat';
import { DEFAULT_CONTEXT_TOKENS } from '../models/llm';

describe('ChatStateService', () => {
  let service: ChatStateService;
  let mockTauri: MockTauriService;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    mockLogger = makeMockLogger();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'get_bundle_reconcile_state':
          return MOCK_BUNDLE_RECONCILE_DONE;
        case 'run_system_check':
          return undefined;
        case 'check_containers_running':
          return true;
        case 'start_containers':
          return undefined;
        case 'get_auth_status':
          return {
            api_key_configured: false,
            oauth_authenticated: true,
            needs_anthropic_auth: true,
            provider_configured: true,
          };
        case 'start_chat':
          return undefined;
        case 'send_message':
          return undefined;
        default:
          return undefined;
      }
    };

    TestBed.configureTestingModule({
      providers: [
        ChatStateService,
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(ChatStateService);

    service._setState({ messages: [], currentBlocks: [], sessionStats: null });
    service.isStreaming = false;
  });

  describe('loadingTranscript', () => {
    it('defaults to false', () => {
      expect(service.loadingTranscriptFromState()).toBe(false);
    });

    it('beginTranscriptLoad sets it true, endTranscriptLoad sets it false', () => {
      service.beginTranscriptLoad();
      expect(service.loadingTranscriptFromState()).toBe(true);
      service.endTranscriptLoad();
      expect(service.loadingTranscriptFromState()).toBe(false);
    });
  });

  describe('init', () => {
    it('surfaces a non-auth startChatSession failure to projectState and the logger', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat') throw new Error('chat backend crashed');
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
        if (cmd === 'check_containers_running') return true;
        return undefined;
      };

      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(projectState.status()).toBe('error');
      expect(projectState.error).toContain('chat backend crashed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to start chat session: Error: chat backend crashed')
      );
    });

    it('ignores a stale start_chat failure once a resume has superseded it', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();

      const pendingStart = createDeferred();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat') await pendingStart.promise;
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
        if (cmd === 'check_containers_running') return true;
        return undefined;
      };

      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      service.beginStartingSession();
      pendingStart.reject(new Error('chat backend crashed'));
      await new Promise((r) => setTimeout(r, 0));

      expect(projectState.status()).not.toBe('error');
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Failed to start chat session')
      );
    });

    it('maps a "not authenticated" startChatSession failure to auth_required (not error)', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat') throw new Error('not authenticated');
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
        if (cmd === 'check_containers_running') return true;
        return undefined;
      };

      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(projectState.status()).toBe('auth_required');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('only runs init once', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();
      const firstCallCount = spy.mock.calls.filter((c) => c[0] === 'start_chat').length;

      await service.init();
      const secondCallCount = spy.mock.calls.filter((c) => c[0] === 'start_chat').length;

      expect(firstCallCount).toBe(1);
      expect(secondCallCount).toBe(1);
    });
  });

  describe('startNewConversation', () => {
    function readyHandler(startChat: () => void) {
      return async (cmd: string) => {
        if (cmd === 'start_chat') return startChat();
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
        if (cmd === 'check_containers_running') return true;
        return undefined;
      };
    }

    it('clears the conversation and awaits a started session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      service._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [],
        sessionStats: null,
      });
      const spy = vi.spyOn(mockTauri, 'invoke');

      await service.startNewConversation();

      expect(service.messages.length).toBe(0);
      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(1);
      expect(service.lastKnownSessionId).toBeNull();
      expect(service.hasConversation()).toBe(false);
    });

    it('attaches the stream listener before the session starts', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      const order: string[] = [];
      vi.spyOn(mockTauri, 'listen').mockImplementation(async (event: string) => {
        order.push(`listen:${event}`);
        return () => undefined;
      });
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      invokeSpy.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        order.push(`invoke:${cmd}`);
        return mockTauri.invokeHandler(cmd, args);
      });

      await service.startNewConversation();

      expect(order.indexOf('listen:chat_stream')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('listen:chat_stream')).toBeLessThan(order.indexOf('invoke:start_chat'));
    });

    it('claims the bootstrap slot so a later init does not start a second session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      const spy = vi.spyOn(mockTauri, 'invoke');

      await service.startNewConversation();
      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(1);
    });

    it('throws and releases the slot when the session never starts', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      let fail = true;
      mockTauri.invokeHandler = readyHandler(() => {
        if (fail) throw new Error('chat backend crashed');
        return undefined;
      });

      service.seedSessionId('sess-old');

      await expect(service.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_FAILED);

      expect(service.messages.length).toBe(0);
      expect(service.lastKnownSessionId).toBe('sess-old');

      fail = false;
      projectState.status.set('ready');
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.startNewConversation();
      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(1);
    });

    it('keeps the conversation and names the cause when the project is not ready', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      service._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [],
        sessionStats: null,
      });
      projectState.status.set('starting');
      const spy = vi.spyOn(mockTauri, 'invoke');

      await expect(service.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_BUSY);

      expect(service.messages.length).toBe(1);
      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(0);
    });

    it('tells the user to open a project instead of asking them to wait', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set(null);

      await expect(service.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_NO_PROJECT);
    });

    it('refuses while a resume owns the session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      const resuming = service.resumeConversation('sess-1');

      await expect(service.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_BUSY);
      await resuming;
    });

    it('leaves a resume that superseded it owning the session id', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingStart = createDeferred();
      const pendingResume = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'start_chat':
            await pendingStart.promise;
            return undefined;
          case 'resume_conversation':
            await pendingResume.promise;
            return undefined;
          case 'get_conversation':
            return { session_id: 'sess-resumed', messages: [] };
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };
      service.seedSessionId('sess-stale');

      const starting = service.startNewConversation();
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      const resuming = service.resumeConversation('sess-resumed');
      pendingStart.resolve();

      await expect(starting).rejects.toThrow(NEW_CONVERSATION_BUSY);
      expect(service.lastKnownSessionId).toBe('sess-resumed');
      expect(service.newConversationBlockedReason()).toBe(NEW_CONVERSATION_BUSY);

      pendingResume.resolve();
      await resuming;
      expect(service.lastKnownSessionId).toBe('sess-resumed');
    });

    it('shows the resumed transcript when a header new-conversation start finishes during the resume', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingStart = createDeferred();
      const pendingResume = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'start_chat':
            await pendingStart.promise;
            return undefined;
          case 'resume_conversation':
            await pendingResume.promise;
            return undefined;
          case 'get_conversation':
            return {
              session_id: 'sess-resumed',
              messages: [
                { role: 'user', content: 'Say hello in one word.', timestamp: null },
                { role: 'assistant', content: 'Hello', timestamp: null, uuid: 'a-1' },
                { role: 'user', content: 'Say goodbye in one word.', timestamp: null },
                { role: 'assistant', content: 'Goodbye', timestamp: null, uuid: 'a-2' },
              ],
            };
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      service.resetForNewConversation();
      await service.init();
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      const resuming = service.resumeConversation('sess-resumed');
      await vi.waitFor(() => {
        expect(calls).toContain('resume_conversation');
      });
      pendingStart.resolve();
      await pendingStart.promise;
      pendingResume.resolve();
      await resuming;

      const replies = service
        .messagesFromState()
        .filter((m) => m.role === 'assistant')
        .map((m) => m.blocks.map((b) => ('content' in b ? b.content : '')).join(''));
      expect(replies).toEqual(['Hello', 'Goodbye']);
      expect(service.lastKnownSessionId).toBe('sess-resumed');
    });

    it('reads the resumed transcript only after the resume stopped the session writing it', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingResume = createDeferred();
      let resumed = false;
      const hello = { role: 'assistant', content: 'Hello', timestamp: null, uuid: 'a-1' };
      const goodbye = { role: 'assistant', content: 'Goodbye', timestamp: null, uuid: 'a-2' };
      mockTauri.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'resume_conversation':
            await pendingResume.promise;
            resumed = true;
            return undefined;
          case 'get_conversation':
            return {
              session_id: 'sess-resumed',
              messages: resumed ? [hello, goodbye] : [hello],
            };
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const resuming = service.resumeConversation('sess-resumed');
      pendingResume.resolve();
      await resuming;

      const replies = service
        .messagesFromState()
        .filter((m) => m.role === 'assistant')
        .map((m) => m.blocks.map((b) => ('content' in b ? b.content : '')).join(''));
      expect(replies).toEqual(['Hello', 'Goodbye']);
    });

    it('keeps the conversation when a reply is still streaming', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      service._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [],
        sessionStats: null,
      });
      service.isStreaming = true;
      const spy = vi.spyOn(mockTauri, 'invoke');

      await expect(service.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_STREAMING);

      expect(service.messages.length).toBe(1);
      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(0);
    });

    it('keeps the conversation when a session start is already in flight', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      service._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [],
        sessionStats: null,
      });
      const release = service.beginStartingSession();

      await expect(service.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_BUSY);

      expect(service.messages.length).toBe(1);
      release();
    });

    it('points at Settings when the backend rejects the start as unauthenticated', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => {
        throw new Error('not authenticated');
      });

      await expect(service.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_AUTH);
      expect(projectState.status()).toBe('auth_required');
    });
  });

  describe('setupStreamListener error handling', () => {
    it('surfaces stream listener error to projectState when running in Tauri', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      mockTauri.isRunningInTauri = () => true;
      mockTauri.listen = async () => {
        throw new Error('WebSocket unavailable');
      };

      await service.init();
      expect(projectState.status()).toBe('error');
      expect(projectState.error).toContain('Failed to set up stream listener');
    });

    it('ignores listen failure when not running inside Tauri', async () => {
      mockTauri.listen = async () => {
        throw new Error('Tauri not available');
      };

      await service.init();
      expect(service).toBeTruthy();
    });
  });

  describe('sendMessage', () => {
    it('adds user message and invokes backend', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      await service.sendMessage('Hello');

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hello' });
      expect(service.isStreaming).toBe(true);
      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [{ type: 'text', text: 'Hello' }],
        displayText: 'Hello',
      });
    });

    it('inlines image attachments as @/workspace/... in the wire text (ADR-065)', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      await service.sendMessage({
        text: 'Co tu widać?',
        attachments: [
          {
            filename: 'paste-1.png',
            mediaType: 'image/png',
            containerPath: '/workspace/.speedwave/pastes/paste-1.png',
            hostPath: '/Users/x/proj/.speedwave/pastes/paste-1.png',
          },
        ],
      });

      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [
          {
            type: 'text',
            text: 'Co tu widać?\n\n@/workspace/.speedwave/pastes/paste-1.png',
          },
        ],
        displayText: 'Co tu widać?',
      });
      expect(service.messages[0].blocks).toEqual([
        { type: 'text', content: 'Co tu widać?' },
        { type: 'image', media_type: 'image/png', alt: 'paste-1.png' },
      ]);
    });

    it('accepts image-only ChatInput and emits a wire text block containing the @path only', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      await service.sendMessage({
        text: '',
        attachments: [
          {
            filename: 'paste-2.jpg',
            mediaType: 'image/jpeg',
            containerPath: '/workspace/.speedwave/pastes/paste-2.jpg',
            hostPath: '/Users/x/proj/.speedwave/pastes/paste-2.jpg',
          },
        ],
      });

      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [{ type: 'text', text: '@/workspace/.speedwave/pastes/paste-2.jpg' }],
        displayText: '',
      });
    });

    it('ignores empty text', async () => {
      await service.sendMessage('');
      expect(service.messages).toHaveLength(0);
    });

    it('ignores a lone slash or whitespace-only text (skill-menu trigger)', async () => {
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      await service.sendMessage('/');
      await service.sendMessage('  /  ');
      await service.sendMessage('   ');
      expect(service.messages).toHaveLength(0);
      expect(service.isStreaming).toBe(false);
      expect(calls).not.toContain('send_message');
    });

    it('still sends a real slash command', async () => {
      await service.sendMessage('/code-review');
      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].role).toBe('user');
    });

    it('ignores when already streaming', async () => {
      service.isStreaming = true;
      await service.sendMessage('Hello');
      expect(service.messages).toHaveLength(0);
    });

    it('handles invoke failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') throw new Error('fail');
        return undefined;
      };

      await service.sendMessage('Hello');

      expect(service.isStreaming).toBe(false);
      expect(service.messages).toHaveLength(2);
      const errorBlock = service.messages[1].blocks[0];
      expect(errorBlock.type).toBe('error');
      expect((errorBlock as { type: 'error'; content: string }).content).toContain(
        'Failed to send message'
      );
    });

    it('reports a busy session as a failed send without starting a new session', async () => {
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'send_message') throw new Error('chat session is busy');
        return undefined;
      };

      await service.sendMessage('Hello');

      expect(calls.filter((cmd) => cmd === 'send_message')).toHaveLength(1);
      expect(calls).not.toContain('start_chat');
      expect(calls).not.toContain('list_projects');
      expect(service.isStreaming).toBe(false);
      const errorBlock = service.messages[1].blocks[0] as { type: string; content: string };
      expect(errorBlock.type).toBe('error');
      expect(errorBlock.content).toMatch(/^Failed to send message: .*chat session is busy/);
    });

    it('auto-retries on "session exited" by re-sending', async () => {
      let sendAttempt = 0;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') {
          sendAttempt++;
          if (sendAttempt === 1) throw new Error('session exited (exit status: 0)');
          return undefined;
        }
        if (cmd === 'list_projects') {
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        }
        return undefined;
      };

      await service.sendMessage('Hello');

      expect(sendAttempt).toBe(2);
      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].role).toBe('user');
    });

    it('auto-retries on "no active session"', async () => {
      let sendAttempt = 0;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') {
          sendAttempt++;
          if (sendAttempt === 1) throw new Error('no active session');
          return undefined;
        }
        if (cmd === 'list_projects') {
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        }
        return undefined;
      };

      await service.sendMessage('Retry me');

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Retry me' });
    });

    it('drops a send that fails while a resume replaces the conversation', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingResume = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            void service.resumeConversation('sess-resumed');
            throw new Error('no active session');
          case 'resume_conversation':
            await pendingResume.promise;
            return undefined;
          case 'get_conversation':
            return {
              session_id: 'sess-resumed',
              messages: [{ role: 'assistant', content: 'Hello', timestamp: null, uuid: 'a-1' }],
            };
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      await service.sendMessage('written before the resume');
      expect(service.messages).toHaveLength(0);

      pendingResume.resolve();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(false);
      });

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(calls).not.toContain('start_chat');
      expect(service.messagesFromState().map((m) => m.role)).toEqual(['assistant']);
      expect(service.isStreaming).toBe(false);
    });

    it('shows the still-starting error instead of resending when a start began during the failed send', async () => {
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'send_message') {
          (service as unknown as { startingSession: boolean }).startingSession = true;
          throw new Error('no active session');
        }
        return undefined;
      };

      await service.sendMessage('hello');

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(calls).not.toContain('start_chat');
      expect(service.isStreaming).toBe(false);
      const lastMsg = service.messages[service.messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect((lastMsg.blocks[0] as { content: string }).content).toContain(
        'Session is still starting'
      );
    });

    it("does not resend after the user stops the turn during the retry's own start", async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingRetryStart = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            if (calls.filter((c) => c === 'send_message').length === 1) {
              throw new Error('session exited (exit status: 1)');
            }
            return undefined;
          case 'start_chat':
            return pendingRetryStart.promise;
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const sending = service.sendMessage('never mind');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      await service.stopConversation();
      pendingRetryStart.resolve();
      await sending;

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(service.isStreaming).toBe(false);
      expect(service.sessionStartInFlightFromState()).toBe(false);
    });

    it('does not start a retry session when the project starts switching while the retry looks it up', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingLookup = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            throw new Error('session exited (exit status: 1)');
          case 'list_projects':
            if (calls.includes('send_message')) await pendingLookup.promise;
            return { projects: [{ name: 'other', dir: '/tmp/other' }], active_project: 'other' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const sending = service.sendMessage('written before the switch');
      await vi.waitFor(() => {
        expect(calls.lastIndexOf('list_projects')).toBeGreaterThan(calls.indexOf('send_message'));
      });
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      pendingLookup.resolve();
      await sending;

      expect(calls).not.toContain('start_chat');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
    });

    function installFailingSendWithPendingRetryStart(activeProject = 'test') {
      const pendingRetryStart = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            if (calls.filter((c) => c === 'send_message').length === 1) {
              throw new Error('session exited (exit status: 1)');
            }
            return undefined;
          case 'start_chat':
            return pendingRetryStart.promise;
          case 'list_projects':
            return {
              projects: [{ name: activeProject, dir: `/tmp/${activeProject}` }],
              active_project: activeProject,
            };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          case 'get_auth_status':
            return {
              api_key_configured: false,
              oauth_authenticated: true,
              needs_anthropic_auth: true,
              provider_configured: true,
            };
          default:
            return undefined;
        }
      };
      return { pendingRetryStart, calls };
    }

    it("marks the project as needing sign-in when the retry's own start fails after Stop", async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = service.sendMessage('never mind');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      await service.stopConversation();
      pendingRetryStart.reject(
        new Error('Claude is not authenticated. Please authenticate first.')
      );
      await sending;

      expect(projectState.status()).toBe('auth_required');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(service.isStreaming).toBe(false);
    });

    it('does not mark a project as needing sign-in for a retry that a project switch superseded', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = service.sendMessage('written before the switch');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      pendingRetryStart.reject(
        new Error('Claude is not authenticated. Please authenticate first.')
      );
      await sending;

      expect(projectState.status()).toBe('switching');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
    });

    it('does not mark the new project as needing sign-in after a switch finished during the retry', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = service.sendMessage('written before the switch');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other' });
      await vi.waitFor(() => {
        expect(projectState.status()).toBe('ready');
      });
      pendingRetryStart.reject(
        new Error('Claude is not authenticated. Please authenticate first.')
      );
      await sending;

      expect(projectState.activeProject()).toBe('other');
      expect(projectState.status()).toBe('ready');
    });

    it("does not send after a project switch failed back during the retry's own start", async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = service.sendMessage('written before the switch');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'switch failed' });
      pendingRetryStart.resolve();
      await sending;

      expect(projectState.activeProject()).toBe('test');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(service.isStreaming).toBe(false);
    });

    it('does not start a session when the backend already moved to another project', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { calls } = installFailingSendWithPendingRetryStart('other');

      await service.sendMessage('written for test');

      expect(calls).not.toContain('start_chat');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(service.isStreaming).toBe(false);
      const lastMsg = service.messages[service.messages.length - 1];
      expect((lastMsg.blocks[0] as { content: string }).content).toContain(
        "The active project is now 'other', not 'test'"
      );
    });

    it('shows the no-active-project error when the backend has no active project', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'send_message') throw new Error('session exited (exit status: 1)');
        if (cmd === 'list_projects') return { projects: [], active_project: null };
        return undefined;
      };

      await service.sendMessage('hello');

      expect(calls).not.toContain('start_chat');
      const lastMsg = service.messages[service.messages.length - 1];
      expect((lastMsg.blocks[0] as { content: string }).content).toContain('No active project');
    });

    it('shows the still-starting error when a resume waits for a container restart during the retry', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingRestart = createDeferred();
      projectState.restartInFlight = pendingRestart.promise;
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            void service.resumeConversation('sess-resumed');
            throw new Error('session exited (exit status: 1)');
          case 'get_conversation':
            return { session_id: 'sess-resumed', messages: [] };
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      await service.sendMessage('written during the restart');

      expect(calls).not.toContain('start_chat');
      expect(calls).not.toContain('resume_conversation');
      const lastMsg = service.messages[service.messages.length - 1];
      expect((lastMsg.blocks[0] as { content: string }).content).toContain(
        'Session is still starting'
      );

      projectState.restartInFlight = null;
      pendingRestart.resolve();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(false);
      });
    });

    it('gives up when the dying session reports its end while the retry looks up the project', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingLookup = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            throw new Error('Broken pipe (os error 32)');
          case 'list_projects':
            if (calls.includes('send_message')) await pendingLookup.promise;
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const sending = service.sendMessage('hello');
      await vi.waitFor(() => {
        expect(calls.lastIndexOf('list_projects')).toBeGreaterThan(calls.indexOf('send_message'));
      });
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Error',
        data: { content: 'Claude session ended unexpectedly', turn_ended: false },
      });
      pendingLookup.resolve();
      await sending;

      expect(calls).not.toContain('start_chat');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(service.isStreaming).toBe(false);
      const lastMsg = service.messages[service.messages.length - 1];
      expect((lastMsg.blocks[0] as { content: string }).content).toContain(
        'Claude session ended unexpectedly'
      );
    });

    it("drops the dying session's end report during the retry's own start and resends", async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = service.sendMessage('hello');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Error',
        data: { content: 'Claude session ended unexpectedly', turn_ended: false },
      });
      pendingRetryStart.resolve();
      await sending;

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(2);
      expect(service.isStreaming).toBe(true);
      expect(service.messages.map((m) => m.role)).toEqual(['user']);
    });

    it('keeps a late failure of a replaced send out of the new chat', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingSend = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            await pendingSend.promise;
            return undefined;
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const sending = service.sendMessage('written before New');
      await vi.waitFor(() => {
        expect(calls).toContain('send_message');
      });
      service.resetForNewConversation();
      await service.init();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(false);
      });
      pendingSend.reject(new Error('Message too long'));
      await sending;

      expect(service.messages).toHaveLength(0);
      expect(service.isStreaming).toBe(false);
    });

    it('keeps the error of a superseded retry start out of the new chat', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingRetryStart = createDeferred();
      const pendingNewStart = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            throw new Error('session exited (exit status: 1)');
          case 'start_chat':
            return calls.filter((c) => c === 'start_chat').length === 1
              ? pendingRetryStart.promise
              : pendingNewStart.promise;
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const sending = service.sendMessage('written before New');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      service.resetForNewConversation();
      await service.init();
      await vi.waitFor(() => {
        expect(calls.filter((c) => c === 'start_chat')).toHaveLength(2);
      });
      pendingRetryStart.reject(new Error('boom'));
      await sending;

      expect(service.messages).toHaveLength(0);
      expect(service.sessionStartInFlightFromState()).toBe(true);

      pendingNewStart.resolve();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(false);
      });
    });

    it("keeps a new chat's start in flight when the retry's own start ends after it, and does not resend", async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingRetryStart = createDeferred();
      const pendingNewStart = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            if (calls.filter((c) => c === 'send_message').length === 1) {
              throw new Error('session exited (exit status: 1)');
            }
            return undefined;
          case 'start_chat':
            return calls.filter((c) => c === 'start_chat').length === 1
              ? pendingRetryStart.promise
              : pendingNewStart.promise;
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const sending = service.sendMessage('written before New');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      service.resetForNewConversation();
      await service.init();
      await vi.waitFor(() => {
        expect(calls.filter((c) => c === 'start_chat')).toHaveLength(2);
      });
      pendingRetryStart.resolve();
      await sending;

      expect(service.sessionStartInFlightFromState()).toBe(true);
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);

      pendingNewStart.resolve();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(false);
      });
    });

    it('does not start its own session when a new chat begins while the retry looks up the project', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingLookup = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'send_message':
            throw new Error('session exited (exit status: 1)');
          case 'list_projects':
            if (calls.includes('send_message')) await pendingLookup.promise;
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const sending = service.sendMessage('written before New');
      await vi.waitFor(() => {
        expect(calls.lastIndexOf('list_projects')).toBeGreaterThan(calls.indexOf('send_message'));
      });
      service.resetForNewConversation();
      await service.init();
      pendingLookup.resolve();
      await sending;

      expect(calls.filter((c) => c === 'start_chat')).toHaveLength(1);
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
    });

    it('queues a model pick made while a resume runs and sends it once the resume completes', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingResume = createDeferred();
      const calls: { cmd: string; args: unknown }[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case 'resume_conversation':
            await pendingResume.promise;
            return undefined;
          case 'get_conversation':
            return {
              session_id: 'sess-resumed',
              messages: [{ role: 'assistant', content: 'Hello', timestamp: null, uuid: 'a-1' }],
            };
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };
      const modelSent = () =>
        calls.some(
          (c) =>
            c.cmd === 'send_message' && JSON.stringify(c.args).includes('/model claude-haiku-4-5')
        );

      const resuming = service.resumeConversation('sess-resumed');
      await vi.waitFor(() => {
        expect(calls.map((c) => c.cmd)).toContain('resume_conversation');
      });
      await service.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });

      expect(modelSent()).toBe(false);
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');

      pendingResume.resolve();
      await resuming;
      await vi.waitFor(() => {
        expect(modelSent()).toBe(true);
      });
    });

    it('sends nothing while a new chat session starts and sends normally once it has started', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingStart = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'start_chat') return pendingStart.promise;
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
        if (cmd === 'check_containers_running') return true;
        return undefined;
      };

      await service.init();
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      expect(service.sessionStartInFlightFromState()).toBe(true);

      await service.sendMessage('too early');

      expect(calls).not.toContain('send_message');
      expect(service.messages).toHaveLength(0);
      expect(service.isStreaming).toBe(false);

      pendingStart.resolve();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(false);
      });
      await service.sendMessage('on time');

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(service.messages).toHaveLength(1);
      expect(service.isStreaming).toBe(true);
    });

    it('sends nothing while a resume runs, from its wait for a container restart to its end', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingRestart = createDeferred();
      const pendingResume = createDeferred();
      projectState.restartInFlight = pendingRestart.promise;
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        switch (cmd) {
          case 'resume_conversation':
            await pendingResume.promise;
            return undefined;
          case 'get_conversation':
            return { session_id: 'sess-resumed', messages: [] };
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'get_bundle_reconcile_state':
            return MOCK_BUNDLE_RECONCILE_DONE;
          case 'check_containers_running':
            return true;
          default:
            return undefined;
        }
      };

      const resuming = service.resumeConversation('sess-resumed');
      await new Promise((r) => setTimeout(r, 0));
      expect(service.sessionStartInFlightFromState()).toBe(true);
      await service.sendMessage('typed during the restart wait');

      projectState.restartInFlight = null;
      pendingRestart.resolve();
      await vi.waitFor(() => {
        expect(calls).toContain('resume_conversation');
      });
      await service.sendMessage('typed during the resume');

      pendingResume.resolve();
      await resuming;

      expect(calls).not.toContain('send_message');
      expect(service.messages).toHaveLength(0);
      expect(service.sessionStartInFlightFromState()).toBe(false);
    });

    it('ignores stream output of the replaced process while a session start is in flight', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const pendingStart = createDeferred();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat') return pendingStart.promise;
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
        if (cmd === 'check_containers_running') return true;
        return undefined;
      };

      await service.init();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(true);
      });
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'QueueDrained',
        data: { session_id: 'sess-old', text: 'queued in the old conversation' },
      });
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'SystemInit',
        data: { model: 'old-model', session_id: 'sess-old' },
      });

      expect(service.messages).toHaveLength(0);
      expect(service.isStreaming).toBe(false);
      expect(service.lastKnownSessionId).toBeNull();

      pendingStart.resolve();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(false);
      });
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'SystemInit',
        data: { model: 'new-model', session_id: 'sess-new' },
      });

      expect(service.lastKnownSessionId).toBe('sess-new');
    });

    it('auto-retries on "Broken pipe"', async () => {
      let sendAttempt = 0;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') {
          sendAttempt++;
          if (sendAttempt === 1) throw new Error('Broken pipe (os error 32)');
          return undefined;
        }
        if (cmd === 'list_projects') {
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        }
        return undefined;
      };

      await service.sendMessage('Hello');

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].role).toBe('user');
    });

    it('shows error when retry itself fails', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') throw new Error('session exited (exit status: 1)');
        if (cmd === 'list_projects') throw new Error('backend crashed');
        return undefined;
      };

      await service.sendMessage('Hello');

      expect(service.isStreaming).toBe(false);
      expect(service.messages).toHaveLength(2);
      const errorBlock = service.messages[1].blocks[0];
      expect(errorBlock.type).toBe('error');
      expect((errorBlock as { type: 'error'; content: string }).content).toContain(
        'Failed to restart session'
      );
      expect((errorBlock as { type: 'error'; content: string }).content).toContain(
        'backend crashed'
      );
    });

    it('skips retry when no active project on restart', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') throw new Error('no active session');
        if (cmd === 'list_projects') {
          return { projects: [], active_project: null };
        }
        return undefined;
      };

      await service.sendMessage('Hello');

      expect(service.isStreaming).toBe(false);
      expect(service.messages).toHaveLength(2);
      const errorBlock = service.messages[1].blocks[0];
      expect(errorBlock.type).toBe('error');
    });
  });

  describe('control-shape check runs on the wire text, not displayText', () => {
    const PLAN_MODE_PREFIX = '[Plan mode] Produce a plan only.\n\n';

    it('suppresses the optimistic bubble when the wire text is control-shaped even though displayText carries a plan-mode prefix', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      await service.sendMessage(
        { text: '/model claude-sonnet-5', attachments: [] },
        '/model claude-sonnet-5'
      );

      expect(service.messages).toHaveLength(0);
      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [{ type: 'text', text: '/model claude-sonnet-5' }],
        displayText: '/model claude-sonnet-5',
      });
    });

    it('shows the optimistic bubble when displayText looks control-shaped but the wire text (plan-mode prefixed) is not', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      const wireText = `${PLAN_MODE_PREFIX}/model claude-sonnet-5`;
      await service.sendMessage({ text: wireText, attachments: [] }, '/model claude-sonnet-5');

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].role).toBe('user');
      expect(service.messages[0].blocks[0]).toEqual({
        type: 'text',
        content: '/model claude-sonnet-5',
      });
      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [{ type: 'text', text: wireText }],
        displayText: '/model claude-sonnet-5',
      });
    });
  });

  describe('ControlChip chunk handling', () => {
    it('appends a chip message when a control-shaped send is emitted', () => {
      const beforeLen = service.messages.length;

      service.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'claude-sonnet-5' },
      });

      expect(service.messages.length).toBe(beforeLen + 1);
      const last = service.messages[service.messages.length - 1];
      expect(last.role).toBe('user');
      expect(last.blocks).toEqual([
        { type: 'chip', command: 'model', argument: 'claude-sonnet-5' },
      ]);
    });

    it('appends a chip message carrying a uuid when the chunk provides one', () => {
      service.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'effort', argument: 'high', uuid: 'u_effort_1' },
      });

      const last = service.messages[service.messages.length - 1];
      expect(last.uuid).toBe('u_effort_1');
      expect(last.uuid_status).toBe('Committed');
      expect(last.blocks).toEqual([{ type: 'chip', command: 'effort', argument: 'high' }]);
    });

    it('appends a chip with no uuid when the chunk carries none (the normal live-send case)', () => {
      service.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'claude-opus-4-8' },
      });
      const last = service.messages[service.messages.length - 1];
      expect(last.uuid).toBeUndefined();
      expect(last.blocks).toEqual([
        { type: 'chip', command: 'model', argument: 'claude-opus-4-8' },
      ]);
    });

    it('ControlChip then QueueDrained for the same control text yields exactly one chip, no plain bubble', () => {
      const beforeLen = service.messages.length;

      service.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'claude-sonnet-5' },
      });
      service.handleStreamChunk({
        chunk_type: 'QueueDrained',
        data: { session_id: 's-1', text: '/model claude-sonnet-5' },
      });

      expect(service.messages.length).toBe(beforeLen + 1);
      const last = service.messages[service.messages.length - 1];
      expect(last.blocks).toEqual([
        { type: 'chip', command: 'model', argument: 'claude-sonnet-5' },
      ]);
      expect(service.messages.some((m) => m.blocks.some((b) => b.type === 'text'))).toBe(false);
    });
  });

  describe('handleStreamChunk', () => {
    it('accumulates text chunks into currentBlocks', () => {
      const chunk1: StreamChunk = { chunk_type: 'Text', data: { content: 'Hello ' } };
      const chunk2: StreamChunk = { chunk_type: 'Text', data: { content: 'world!' } };
      service.handleStreamChunk(chunk1);
      service.handleStreamChunk(chunk2);

      expect(service.currentBlocks).toHaveLength(1);
      expect(service.currentBlocks[0]).toEqual({ type: 'text', content: 'Hello world!' });
      expect(service.isStreaming).toBe(true);
    });

    it('accumulates thinking chunks', () => {
      const chunk1: StreamChunk = { chunk_type: 'Thinking', data: { content: '' } };
      const chunk2: StreamChunk = { chunk_type: 'Thinking', data: { content: 'Let me think...' } };
      service.handleStreamChunk(chunk1);
      service.handleStreamChunk(chunk2);

      expect(service.currentBlocks).toHaveLength(1);
      expect(service.currentBlocks[0]).toEqual({
        type: 'thinking',
        content: 'Let me think...',
        collapsed: true,
      });
    });

    it('handles ToolStart chunk', () => {
      const chunk: StreamChunk = {
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      };
      service.handleStreamChunk(chunk);

      expect(service.currentBlocks).toHaveLength(1);
      const block = service.currentBlocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use') {
        expect(block.tool.tool_id).toBe('t1');
        expect(block.tool.tool_name).toBe('Read');
        expect(block.tool.status).toBe('running');
      }
    });

    it('handles ToolInputDelta chunk', () => {
      service.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '{"file' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '":"a.ts"}' },
      });

      const block = service.currentBlocks[0];
      if (block.type === 'tool_use') {
        expect(block.tool.input_json).toBe('{"file":"a.ts"}');
      }
    });

    it('assembles complete tool input_json from multiple ToolInputDelta chunks', () => {
      service.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Bash' },
      });

      service.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '{"com' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: 'mand' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '":"ls' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: ' -la"}' },
      });

      expect(service.currentBlocks).toHaveLength(1);
      const block = service.currentBlocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use') {
        expect(block.tool.input_json).toBe('{"command":"ls -la"}');
        const parsed = JSON.parse(block.tool.input_json);
        expect(parsed).toEqual({ command: 'ls -la' });
      }
    });

    it('handles ToolResult chunk', () => {
      service.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolResult',
        data: { tool_id: 't1', content: 'file contents', is_error: false },
      });

      const block = service.currentBlocks[0];
      if (block.type === 'tool_use' && block.tool.status === 'done') {
        expect(block.tool.result).toBe('file contents');
        expect(block.tool.status).toBe('done');
      }
    });

    it('handles ToolResult with error', () => {
      service.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Bash' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolResult',
        data: { tool_id: 't1', content: 'command not found', is_error: true },
      });

      const block = service.currentBlocks[0];
      if (block.type === 'tool_use' && block.tool.status === 'error') {
        expect(block.tool.result_is_error).toBe(true);
        expect(block.tool.status).toBe('error');
      }
    });

    describe('tool input completion and parse warnings', () => {
      const TRUNCATED = '{"to": "ab97ec49c3f64e4c0"';
      const COMPLETE = '{"to":"ab97ec49c3f64e4c0","message":"Any progress?"}';

      function toolBlock(index = 0): ToolUseBlock {
        const block = service.currentBlocks[index];
        if (block.type !== 'tool_use') throw new Error(`block ${index} is ${block.type}`);
        return block.tool;
      }

      function startTool(inputDelta: string, toolName = 'SendMessage'): void {
        service.handleStreamChunk({
          chunk_type: 'ToolStart',
          data: { tool_id: 't1', tool_name: toolName },
        });
        if (inputDelta) {
          service.handleStreamChunk({
            chunk_type: 'ToolInputDelta',
            data: { tool_id: 't1', partial_json: inputDelta },
          });
        }
      }

      function complete(inputJson: string, toolId = 't1'): void {
        service.handleStreamChunk({
          chunk_type: 'ToolInputComplete',
          data: { tool_id: toolId, input_json: inputJson },
        });
      }

      function result(isError = false, toolId = 't1'): void {
        service.handleStreamChunk({
          chunk_type: 'ToolResult',
          data: { tool_id: toolId, content: 'out', is_error: isError },
        });
      }

      it('ToolInputComplete replaces the delta-assembled input_json', () => {
        startTool(TRUNCATED);
        complete(COMPLETE);
        expect(toolBlock().input_json).toBe(COMPLETE);
        expect(toolBlock().status).toBe('running');
      });

      it('ToolInputComplete warns once when the streamed input was incomplete', () => {
        startTool(TRUNCATED);
        complete(COMPLETE);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        const message = mockLogger.warn.mock.calls[0][0] as string;
        expect(message).toContain('"SendMessage"');
        expect(message).toContain('t1');
        expect(message).toContain('incomplete after streaming');
      });

      it('ToolInputComplete keeps a streamed input that parses and stays silent', () => {
        const streamed = '{"to": "ab97ec49c3f64e4c0", "message": "Any progress?"}';
        startTool(streamed);
        complete(COMPLETE);
        expect(toolBlock().input_json).toBe(streamed);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('ToolInputComplete treats an empty streamed input completed to {} as a no-argument tool', () => {
        startTool('', 'TodoRead');
        complete('{}');
        expect(toolBlock().input_json).toBe('{}');
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('ToolInputComplete warns when an empty streamed input is completed with real arguments', () => {
        startTool('', 'Bash');
        complete('{"command":"ls"}');
        expect(toolBlock().input_json).toBe('{"command":"ls"}');
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });

      it('ToolInputComplete for an unknown tool id leaves blocks untouched and stays silent', () => {
        startTool(TRUNCATED);
        const before = service.currentBlocks;
        complete('{}', 'toolu_subagent');
        expect(service.currentBlocks).toEqual(before);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('ToolResult warns exactly once for an unparseable input despite later state rebuilds', () => {
        startTool(TRUNCATED);
        result();
        expect(toolBlock().status).toBe('done');
        expect(toolBlock().input_json).toBe(TRUNCATED);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Failed to parse tool input for "SendMessage"')
        );

        for (let i = 0; i < 25; i += 1) {
          service.handleStreamChunk({ chunk_type: 'Text', data: { content: `delta ${i} ` } });
        }
        service.handleStreamChunk({ chunk_type: 'Result', data: { session_id: 'sid' } });
        service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'next turn' } });
        expect(service.messages[0].blocks[0].type).toBe('tool_use');
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });

      it('ToolResult with is_error also warns once for an unparseable input', () => {
        startTool('{"command":', 'Bash');
        result(true);
        expect(toolBlock().status).toBe('error');
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });

      it('ToolResult does not warn when input_json parses', () => {
        startTool('{"file_path":"/a.ts"}', 'Read');
        result();
        expect(toolBlock().status).toBe('done');
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('ToolResult for a tool id without a block (subagent tool) does not warn', () => {
        result(false, 'toolu_subagent');
        expect(service.currentBlocks).toEqual([]);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('a healed block reaches ToolResult without a parse warning', () => {
        startTool(TRUNCATED);
        complete(COMPLETE);
        result();
        expect(toolBlock().status).toBe('done');
        expect(toolBlock().input_json).toBe(COMPLETE);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('Failed to parse')
        );
      });

      it('the parse warning names the tool, id and length but bounds the echoed input', () => {
        const huge = '{"content":"' + 'x'.repeat(5000);
        startTool(huge, 'Write');
        result();
        const message = mockLogger.warn.mock.calls[0][0] as string;
        expect(message).toContain('"Write"');
        expect(message).toContain('t1');
        expect(message).toContain(`${huge.length} chars`);
        expect(message).toContain('x'.repeat(50));
        expect(message).not.toContain('x'.repeat(1000));
      });

      it('the parse warning preview never cuts a surrogate pair', () => {
        const head = '{"content":"';
        const input = head + 'x'.repeat(199 - head.length) + '😀' + 'y'.repeat(50);
        startTool(input, 'Write');
        result();
        const message = mockLogger.warn.mock.calls[0][0] as string;
        expect(message).toContain('😀');
        expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      });

      it('Result finalizes a still-running tool block as Interrupted', () => {
        startTool(TRUNCATED);
        service.handleStreamChunk({ chunk_type: 'Result', data: { session_id: 'sid' } });
        const block = service.messages[0].blocks[0];
        expect(block.type).toBe('tool_use');
        if (block.type === 'tool_use' && block.tool.status === 'error') {
          expect(block.tool.result).toBe('Interrupted');
        } else {
          throw new Error('expected an errored tool block');
        }
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('Error finalizes a still-running tool block as Interrupted', () => {
        startTool(TRUNCATED);
        service.handleStreamChunk({ chunk_type: 'Error', data: { content: 'Error: rate limit' } });
        const [tool, error] = service.messages[0].blocks;
        expect(tool.type === 'tool_use' && tool.tool.status).toBe('error');
        expect(error.type).toBe('error');
      });

      it('stopConversation marks a streaming tool Interrupted without a parse warning', async () => {
        startTool(TRUNCATED);
        service.isStreaming = true;
        await service.stopConversation();
        const block = service.messages[0].blocks[0];
        expect(block.type).toBe('tool_use');
        if (block.type === 'tool_use') expect(block.tool.status).toBe('error');
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });
    });

    it('Result finalizes currentBlocks into messages', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Response' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.05,
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Response' });
      expect(service.isStreaming).toBe(false);
      expect(service.currentBlocks).toHaveLength(0);
      expect(service.sessionStats).toEqual({
        session_id: 'abc',
        total_cost: 0.05,
        usage: { input_tokens: 100, output_tokens: 50 },
        total_output_tokens: 50,
        context_window_size: null,
        model: undefined,
      });
    });

    it('Result stores context_usage and the fit-gate tokens from the last API call', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'x' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.05,
          usage: { input_tokens: 4864, output_tokens: 1808, cache_read_tokens: 464_000 },
          context_usage: {
            input_tokens: 2,
            output_tokens: 1660,
            cache_read_tokens: 66_844,
            cache_write_tokens: 4920,
          },
        },
      });

      expect(service.sessionStats?.context_usage).toEqual({
        input_tokens: 2,
        output_tokens: 1660,
        cache_read_tokens: 66_844,
        cache_write_tokens: 4920,
      });
      expect(service.lastContextTokens).toBe(71_766);
    });

    it('a Result without context_usage keeps the previous meter value', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'x' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.05,
          context_usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 30,
            cache_write_tokens: 40,
          },
        },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'y' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(service.sessionStats?.context_usage?.cache_read_tokens).toBe(30);
      expect(service.lastContextTokens).toBe(80);
    });

    it('footer total comes from get_conversation_cost (single aggregator), not a frontend sum', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      let aggregatorTotal = 0.2;
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_usage_for_response') return { cost_usd: 0.2, cost_source: 'catalog' };
        if (cmd === 'get_conversation_cost') return aggregatorTotal;
        return undefined;
      });

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.99 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(service.sessionStats?.total_cost).toBeCloseTo(0.2, 6);

      aggregatorTotal = 0.5;
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'b' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_2', total_cost: 1.5 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(service.sessionStats?.total_cost).toBeCloseTo(0.5, 6);
    });

    it('sends all conversation response_ids (both turns) to get_conversation_cost', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      let sentIds: string[] = [];
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'get_usage_for_response') return { cost_usd: 0.1, cost_source: 'catalog' };
        if (cmd === 'get_conversation_cost') {
          sentIds = (args as { responseIds: string[] }).responseIds;
          return 0.2;
        }
        return undefined;
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.1 },
      });
      await new Promise((r) => setTimeout(r, 0));
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'b' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_2', total_cost: 0.2 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(sentIds).toContain('msg_1');
      expect(sentIds).toContain('msg_2');
    });

    it('lagging proxy append (get_usage_for_response null) keeps live CC and skips get_conversation_cost', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_usage_for_response') return null;
        if (cmd === 'get_conversation_cost') return 9.99;
        return undefined;
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.42 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(service.sessionStats?.total_cost).toBe(0.42);
      expect(spy).not.toHaveBeenCalledWith('get_conversation_cost', expect.anything());
    });

    it('reconcile hides the per-message cost when the proxy SSOT is free/null', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        if (cmd === 'get_usage_for_response') return { cost_usd: null, cost_source: 'free' };
        return undefined;
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', turn_cost: 0.046 },
      });
      await new Promise((r) => setTimeout(r, 0));
      const entry = service.messages.find((m) => m.uuid === 'msg_1');
      expect(entry?.meta?.cost).toBeUndefined();
    });

    it('subscription (null aggregator total) yields null footer ("—"), not CC estimate', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_usage_for_response')
          return { cost_usd: null, cost_source: 'subscription' };
        if (cmd === 'get_conversation_cost') return null;
        return undefined;
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.42 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(service.sessionStats?.total_cost).toBeNull();
    });

    it('local provider suppresses the live CC cost preview (no $0.00x flicker)', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      (service as unknown as { _currentProvider: string | null })._currentProvider = 'local';
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.002, turn_cost: 0.002 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(service.sessionStats?.total_cost).toBeNull();
      const entry = service.messages.find((m) => m.uuid === 'msg_1');
      expect(entry?.meta?.cost).toBeUndefined();
    });

    it('re-reconciles a deferred OpenRouter cost once /generation prices it later', async () => {
      vi.useFakeTimers();
      try {
        TestBed.inject(ProjectStateService).activeProject.set('proj');
        let priced = false;
        vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
          if (cmd === 'get_usage_for_response') {
            return priced
              ? { cost_usd: 0.0046, cost_source: 'actual' }
              : { cost_usd: null, cost_source: 'deferred' };
          }
          if (cmd === 'get_conversation_cost') return priced ? 0.0046 : null;
          return undefined;
        });

        service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        service.handleStreamChunk({
          chunk_type: 'Result',
          data: {
            session_id: 'abc',
            assistant_uuid: 'msg_1',
            total_cost: 0.99,
            model: 'openrouter/anthropic/claude-haiku-4.5',
            turn_usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
            },
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeUndefined();
        expect(service.sessionStats?.total_cost).toBe(0.99);

        priced = true;
        await vi.advanceTimersByTimeAsync(5000);

        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeCloseTo(0.0046, 6);
        expect(service.sessionStats?.total_cost).toBeCloseTo(0.0046, 6);
      } finally {
        vi.useRealTimers();
      }
    });

    it('deferred reconcile keeps the visible preview cost instead of blanking it (#31)', async () => {
      vi.useFakeTimers();
      try {
        TestBed.inject(ProjectStateService).activeProject.set('proj');
        let priced = false;
        vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
          if (cmd === 'get_usage_for_response') {
            return priced
              ? { cost_usd: 0.0046, cost_source: 'actual' }
              : { cost_usd: null, cost_source: 'deferred' };
          }
          if (cmd === 'get_conversation_cost') return priced ? 0.0046 : null;
          return undefined;
        });

        service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        service.handleStreamChunk({
          chunk_type: 'Result',
          data: {
            session_id: 'abc',
            assistant_uuid: 'msg_1',
            total_cost: 0.5,
            turn_cost: 0.5,
            model: 'openrouter/anthropic/claude-haiku-4.5',
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBe(0.5);
        expect(service.sessionStats?.total_cost).toBe(0.5);

        priced = true;
        await vi.advanceTimersByTimeAsync(5000);
        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeCloseTo(0.0046, 6);
        expect(service.sessionStats?.total_cost).toBeCloseTo(0.0046, 6);
      } finally {
        vi.useRealTimers();
      }
    });

    it('picks up an OpenRouter cost that /generation prices only after ~30s', async () => {
      vi.useFakeTimers();
      try {
        TestBed.inject(ProjectStateService).activeProject.set('proj');
        let elapsed = 0;
        vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
          if (cmd === 'get_usage_for_response') {
            return elapsed >= 30_000
              ? { cost_usd: 0.0858, cost_source: 'actual' }
              : { cost_usd: null, cost_source: 'deferred' };
          }
          if (cmd === 'get_conversation_cost') return elapsed >= 30_000 ? 0.0858 : null;
          return undefined;
        });

        service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        service.handleStreamChunk({
          chunk_type: 'Result',
          data: {
            session_id: 'abc',
            assistant_uuid: 'msg_1',
            total_cost: 0.13,
            turn_cost: 0.13,
            model: 'openrouter/z-ai/glm-5-turbo',
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBe(0.13);

        for (let t = 0; t < 35_000; t += 5000) {
          elapsed += 5000;
          await vi.advanceTimersByTimeAsync(5000);
        }

        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeCloseTo(0.0858, 6);
        expect(service.sessionStats?.total_cost).toBeCloseTo(0.0858, 6);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops re-reconciling a deferred turn once a newer turn supersedes it', async () => {
      vi.useFakeTimers();
      try {
        TestBed.inject(ProjectStateService).activeProject.set('proj');
        let calls = 0;
        vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
          if (cmd === 'get_usage_for_response') {
            calls += 1;
            return { cost_usd: null, cost_source: 'deferred' };
          }
          if (cmd === 'get_conversation_cost') return null;
          return undefined;
        });

        service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        service.handleStreamChunk({
          chunk_type: 'Result',
          data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.1 },
        });
        await vi.advanceTimersByTimeAsync(0);
        const callsAfterFirst = calls;

        await service.sendMessage('next question');
        await vi.advanceTimersByTimeAsync(10_000);

        expect(calls).toBeLessThanOrEqual(callsAfterFirst + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('Result with empty currentBlocks does not add message', () => {
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });

      expect(service.messages).toHaveLength(0);
      expect(service.isStreaming).toBe(false);
    });

    it('Result with result_text creates text block and finalizes', () => {
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          result_text: 'Session cost: $0.003\nTotal cost: $0.015',
        },
      });

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks).toHaveLength(1);
      expect(service.messages[0].blocks[0]).toEqual({
        type: 'text',
        content: 'Session cost: $0.003\nTotal cost: $0.015',
      });
      expect(service.isStreaming).toBe(false);
    });

    it('Result without result_text finalizes normally', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks).toHaveLength(1);
      expect(service.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hello' });
    });

    it('Result with result_text appends after tool blocks', () => {
      service.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolResult',
        data: { tool_id: 't1', content: 'file contents', is_error: false },
      });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', result_text: 'Review complete.' },
      });

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks).toHaveLength(2);
      expect(service.messages[0].blocks[0].type).toBe('tool_use');
      expect(service.messages[0].blocks[1]).toEqual({
        type: 'text',
        content: 'Review complete.',
      });
    });

    it('Text deltas followed by Result with result_text skips duplicate', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Streamed text.' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', result_text: 'Result text.' },
      });

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks).toHaveLength(1);
      expect(service.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Streamed text.' });
    });

    it('Error chunk finalizes as error message', () => {
      service.isStreaming = true;
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'partial' } });
      service.handleStreamChunk({ chunk_type: 'Error', data: { content: 'Something went wrong' } });

      expect(service.isStreaming).toBe(false);
      expect(service.currentBlocks).toHaveLength(0);
      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks).toHaveLength(2);
      expect(service.messages[0].blocks[1]).toEqual({
        type: 'error',
        content: 'Something went wrong',
      });
    });

    it('does not notify on unknown chunk type', () => {
      const before = service.state();

      service.handleStreamChunk({
        chunk_type: 'UnknownFutureType' as StreamChunk['chunk_type'],
        data: {},
      } as StreamChunk);

      expect(service.state()).toBe(before);
      expect(service.currentBlocks).toHaveLength(0);
      expect(service.isStreaming).toBe(false);
    });

    it('SystemInit stores model name and Result includes it in sessionStats', () => {
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6' },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(service.sessionStats?.model).toBe('claude-opus-4-6');
    });

    it('Result without prior SystemInit has no model in sessionStats', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(service.sessionStats?.model).toBeUndefined();
    });

    it('full streaming sequence produces correct state', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Let me ' } });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'read that.' } });
      service.handleStreamChunk({ chunk_type: 'Thinking', data: { content: '' } });
      service.handleStreamChunk({
        chunk_type: 'Thinking',
        data: { content: 'I should check the file' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '{"file_path":"/a.ts"}' },
      });
      service.handleStreamChunk({
        chunk_type: 'ToolResult',
        data: { tool_id: 't1', content: 'contents', is_error: false },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'The file looks good.' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sid', total_cost: 0.01 },
      });

      expect(service.messages).toHaveLength(1);
      const blocks = service.messages[0].blocks;
      expect(blocks).toHaveLength(4);
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('thinking');
      expect(blocks[2].type).toBe('tool_use');
      expect(blocks[3].type).toBe('text');
      expect(service.isStreaming).toBe(false);
    });
  });

  describe('project switching clears state via ProjectStateService', () => {
    it('project_switch_started clears chat state', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();
      service._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
      });
      service.isStreaming = true;

      mockTauri.dispatchEvent('project_switch_started', { project: 'other-project' });
      await new Promise((r) => setTimeout(r, 10));

      expect(service.messages).toEqual([]);
      expect(service.isStreaming).toBe(false);
      expect(service.sessionStats).toBeNull();
    });

    it('project switch clears model so subsequent Result has no model', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6' },
      });

      mockTauri.dispatchEvent('project_switch_started', { project: 'other-project' });
      await new Promise((r) => setTimeout(r, 10));

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(service.sessionStats?.model).toBeUndefined();
    });
  });

  describe('sessionStatsFromState signal (reactive footer)', () => {
    it('defaults to null and mirrors the getter', () => {
      expect(service.sessionStatsFromState()).toBeNull();
      expect(service.sessionStatsFromState()).toBe(service.sessionStats);
    });

    it('updates reactively on Result without needing another change-detection trigger', () => {
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.5, usage: { input_tokens: 2, output_tokens: 9 } },
      });
      const sig = service.sessionStatsFromState();
      expect(sig?.session_id).toBe('abc');
      expect(sig?.total_cost).toBe(0.5);
      expect(service.sessionStatsFromState()).toBe(service.sessionStats);
    });

    it('updates reactively on seedSessionId', () => {
      service.seedSessionId('11111111-1111-1111-1111-111111111111');
      expect(service.sessionStatsFromState()?.session_id).toBe(
        '11111111-1111-1111-1111-111111111111'
      );
    });

    it('clears reactively on resetForNewConversation', () => {
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.5 },
      });
      expect(service.sessionStatsFromState()).not.toBeNull();
      service.resetForNewConversation();
      expect(service.sessionStatsFromState()).toBeNull();
    });
  });

  describe('SystemInit model lifecycle', () => {
    it('resetForNewConversation clears model so subsequent Result has no model', () => {
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6' },
      });
      service.resetForNewConversation();
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(service.sessionStats?.model).toBeUndefined();
    });
  });

  describe('pendingModelOverride', () => {
    it('pendingModelOverride is null when nothing was set', () => {
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('a no-session Anthropic pick persists the pin and respawns without ever queuing (SPEED-544)', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.pendingModelOverride()).toBeNull();
      const startCall = invokeSpy.mock.calls.find(([cmd]) => cmd === 'start_chat');
      expect(startCall?.[1]).toEqual({ project: 'test' });
    });

    it('a reset during an in-flight resume discards its transcript and starts fresh', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      let resolveTranscript: ((t: ConversationTranscript) => void) | null = null;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation')
          return new Promise<ConversationTranscript>((resolve) => {
            resolveTranscript = resolve;
          });
        return undefined;
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      const resume = service.resumeConversation('old-sess');
      await new Promise((r) => setTimeout(r, 0));
      service.resetForNewConversation();
      resolveTranscript!({
        session_id: 'old-sess',
        messages: [{ role: 'assistant', content: 'old reply', timestamp: null }],
      });
      await resume;
      await new Promise((r) => setTimeout(r, 0));

      expect(service.messagesFromState()).toHaveLength(0);
      expect(service.lastKnownSessionId).toBeNull();
      const startCall = invokeSpy.mock.calls.find(([cmd]) => cmd === 'start_chat');
      expect(startCall).toBeDefined();
    });

    it('an undisturbed resume still loads its transcript and seeds the session id', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation')
          return {
            session_id: 'old-sess',
            messages: [{ role: 'assistant', content: 'old reply', timestamp: null }],
          };
        return undefined;
      };

      await service.resumeConversation('old-sess');

      expect(service.messagesFromState()).toHaveLength(1);
      expect(service.lastKnownSessionId).toBe('old-sess');
    });

    it('SystemInit never flushes a queued mid-stream pick; only Result (turn end) does', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      service.isStreaming = true;
      invokeSpy.mockClear();

      await service.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-restart' },
      });
      await Promise.resolve();
      let modelSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSend).toBeUndefined();
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-restart' },
      } as never);
      await vi.waitFor(() => {
        modelSend = invokeSpy.mock.calls.find(
          ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
        );
        expect(modelSend).toBeDefined();
      });
      expect(JSON.stringify(modelSend?.[1])).toContain('/model claude-haiku-4-5');
      expect(service.pendingModelOverride()).toBeNull();
    });

    function reportTakesWireEffort(takesWire: boolean): void {
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) =>
        cmd === 'get_chat_takes_wire_effort' ? takesWire : base(cmd, args);
    }

    it('applyEffortSelection in a conversation launched with --effort writes the pin, checks the process, then wires /effort', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      reportTakesWireEffort(true);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-live' },
      } as never);
      await Promise.resolve();
      expect(service.hasConversation()).toBe(true);
      invokeSpy.mockClear();

      await service.applyEffortSelection('low');
      const pinCallIdx = invokeSpy.mock.calls.findIndex(([cmd]) => cmd === 'set_effort_pin');
      const effortSendIdx = invokeSpy.mock.calls.findIndex(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort low')
      );
      const checkIdx = invokeSpy.mock.calls.findIndex(
        ([cmd, args]) =>
          cmd === 'get_chat_takes_wire_effort' &&
          JSON.stringify(args) === JSON.stringify({ project: 'test' })
      );
      expect(pinCallIdx).toBeGreaterThanOrEqual(0);
      expect(checkIdx).toBeGreaterThan(pinCallIdx);
      expect(effortSendIdx).toBeGreaterThan(checkIdx);
      expect(invokeSpy.mock.calls.find(([cmd]) => cmd === 'resume_conversation')).toBeUndefined();
      expect(invokeSpy.mock.calls.find(([cmd]) => cmd === 'get_conversation')).toBeUndefined();
    });

    it('applyEffortSelection mid-stream queues and flushes the wire /effort after the turn', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      reportTakesWireEffort(true);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();
      service.isStreaming = true;

      await service.applyEffortSelection('xhigh');
      let effortSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort ')
      );
      expect(effortSend).toBeUndefined();

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-live' },
      } as never);
      await vi.waitFor(() => {
        effortSend = invokeSpy.mock.calls.find(
          ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort xhigh')
        );
        expect(effortSend).toBeDefined();
      });
    });

    it('applyEffortSelection blocks the wire and sets an error when the pin write fails', async () => {
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        if (cmd === 'set_effort_pin') throw new Error('locked config');
        return undefined;
      });

      await service.applyEffortSelection('low');

      const effortSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort')
      );
      expect(effortSend).toBeUndefined();
      expect(service.modelSelectionError()).toContain('locked config');
    });

    it('applyEffortSelection without a live session respawns the idle pre-first-turn process', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyEffortSelection('low');
      await new Promise((r) => setTimeout(r, 0));

      const pinCall = invokeSpy.mock.calls.find(([cmd]) => cmd === 'set_effort_pin');
      expect(pinCall).toBeDefined();
      const startCalls = invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat');
      expect(startCalls.length).toBeGreaterThan(0);
      const effortSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort')
      );
      expect(effortSend).toBeUndefined();
    });

    it('applyEffortSelection on a live session with no conversation yet respawns instead of wiring /effort', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-fable-5', session_id: 'sess-idle' },
      });
      await Promise.resolve();
      expect(service.hasConversation()).toBe(false);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyEffortSelection('low');
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
      const effortSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort')
      );
      expect(effortSend).toBeUndefined();
    });

    it('applyEffortSelection while the first turn streams before any session id queues it for the turn end', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      reportTakesWireEffort(true);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.isStreaming = true;

      await service.applyEffortSelection('max');
      expect(
        invokeSpy.mock.calls.find(
          ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort')
        )
      ).toBeUndefined();
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-5', session_id: 'sess-first' },
      });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-first' },
      } as never);
      await vi.waitFor(() => {
        const effortSend = invokeSpy.mock.calls.find(
          ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort max')
        );
        expect(effortSend).toBeDefined();
      });
    });

    describe('a conversation whose process may hold the launch effort (SPEED-650)', () => {
      const LIVE = 'sess-held';

      function liveConversation(takesWire: boolean): void {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        TestBed.inject(ProjectStateService).status.set('ready');
        mockTauri.invokeHandler = async (cmd: string) =>
          cmd === 'get_chat_takes_wire_effort' ? takesWire : undefined;
        service.handleStreamChunk({
          chunk_type: 'SystemInit',
          data: { model: 'claude-fable-5', session_id: LIVE },
        });
        service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
        service.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
      }

      function overrideInvoke(cmd: string, answer: () => Promise<unknown>): void {
        const base = mockTauri.invokeHandler;
        mockTauri.invokeHandler = async (c, args) => (c === cmd ? answer() : base(c, args));
      }

      function indexOfCall(calls: unknown[][], match: (cmd: string, args: unknown) => boolean) {
        return calls.findIndex(([cmd, args]) => match(cmd as string, args));
      }

      const wiredEffort = (level: string) => (cmd: string, args: unknown) =>
        cmd === 'send_message' && JSON.stringify(args).includes(`/effort ${level}`);
      const wiredModel = (cmd: string, args: unknown) =>
        cmd === 'send_message' && JSON.stringify(args).includes('/model ');
      const checked = (cmd: string) => cmd === 'get_chat_takes_wire_effort';
      const restarted = (cmd: string) => cmd === 'resume_conversation';

      it('defers the pick to the next session when the process holds its launch effort', async () => {
        liveConversation(false);
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.applyEffortSelection('low');

        const calls = invokeSpy.mock.calls;
        expect(indexOfCall(calls, (cmd) => cmd === 'set_effort_pin')).toBeGreaterThan(-1);
        expect(indexOfCall(calls, checked)).toBeGreaterThan(-1);
        expect(indexOfCall(calls, wiredEffort('low'))).toBe(-1);
        expect(indexOfCall(calls, restarted)).toBe(-1);
        expect(service.deferredEffort()).toBe('low');
        expect(service.messagesFromState()).toHaveLength(1);
      });

      it('defers the pick when the check fails, rather than wiring a /effort that may be refused', async () => {
        liveConversation(true);
        overrideInvoke('get_chat_takes_wire_effort', async () => {
          throw new Error('ipc closed');
        });
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.applyEffortSelection('medium');

        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('medium'))).toBe(-1);
        expect(service.deferredEffort()).toBe('medium');
      });

      it('a later pick replaces the deferred level', async () => {
        liveConversation(false);
        await Promise.resolve();

        await service.applyEffortSelection('low');
        await service.applyEffortSelection('max');

        expect(service.deferredEffort()).toBe('max');
      });

      it('Restart now resumes the conversation, which launches with the pin, and clears the notice', async () => {
        liveConversation(false);
        await Promise.resolve();
        await service.applyEffortSelection('max');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.restartForDeferredEffort();

        expect(invokeSpy).toHaveBeenCalledWith('resume_conversation', {
          project: 'test',
          sessionId: LIVE,
        });
        expect(service.deferredEffort()).toBeNull();
        expect(service.lastKnownSessionId).toBe(LIVE);
      });

      it('Restart now does nothing while the project is not ready', async () => {
        liveConversation(false);
        await Promise.resolve();
        await service.applyEffortSelection('max');
        TestBed.inject(ProjectStateService).status.set('switching');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.restartForDeferredEffort();

        expect(indexOfCall(invokeSpy.mock.calls, restarted)).toBe(-1);
      });

      it('a start of a new process clears the notice, since that spawn carries the pin', async () => {
        liveConversation(false);
        await Promise.resolve();
        await service.applyEffortSelection('max');
        expect(service.deferredEffort()).toBe('max');
        service.clearSessionTracking();
        TestBed.inject(ProjectStateService).status.set('ready');

        await service.init();
        await new Promise((r) => setTimeout(r, 0));

        expect(service.deferredEffort()).toBeNull();
      });

      it('a send that restarts a dead process clears the notice', async () => {
        liveConversation(false);
        await Promise.resolve();
        await service.applyEffortSelection('max');
        let sends = 0;
        overrideInvoke('send_message', async () => {
          sends += 1;
          if (sends === 1) throw new Error('session exited (exit status: 1)');
          return undefined;
        });
        overrideInvoke('list_projects', async () => ({
          projects: [{ name: 'test', dir: '/tmp/test' }],
          active_project: 'test',
        }));

        await service.sendMessage('next question');

        expect(sends).toBe(2);
        expect(service.deferredEffort()).toBeNull();
      });

      it('warns when the check fails, so a broken command does not pass for a hold', async () => {
        liveConversation(true);
        overrideInvoke('get_chat_takes_wire_effort', async () => {
          throw new Error('command get_chat_takes_wire_effort not found');
        });
        await Promise.resolve();

        await service.applyEffortSelection('medium');

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('get_chat_takes_wire_effort failed')
        );
      });

      it('Restart now does nothing while a turn streams', async () => {
        liveConversation(false);
        await Promise.resolve();
        await service.applyEffortSelection('max');
        service.isStreaming = true;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.restartForDeferredEffort();

        expect(indexOfCall(invokeSpy.mock.calls, restarted)).toBe(-1);
        expect(service.deferredEffort()).toBe('max');
      });

      it('a new conversation clears the notice', async () => {
        liveConversation(false);
        await Promise.resolve();
        await service.applyEffortSelection('max');

        service.resetForNewConversation();

        expect(service.deferredEffort()).toBeNull();
      });

      it('wires /effort into a live process that launched with --effort and shows no notice', async () => {
        liveConversation(true);
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.applyEffortSelection('xhigh');

        const calls = invokeSpy.mock.calls;
        expect(indexOfCall(calls, wiredEffort('xhigh'))).toBeGreaterThan(
          indexOfCall(calls, checked)
        );
        expect(service.deferredEffort()).toBeNull();
      });

      it('a pick made mid-stream is checked when the turn ends', async () => {
        liveConversation(false);
        await Promise.resolve();
        service.isStreaming = true;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.applyEffortSelection('xhigh');
        expect(indexOfCall(invokeSpy.mock.calls, checked)).toBe(-1);
        expect(service.deferredEffort()).toBeNull();

        service.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await vi.waitFor(() => {
          expect(service.deferredEffort()).toBe('xhigh');
        });
        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('xhigh'))).toBe(-1);
      });

      it('wires a pick while a queued message is about to drain, since nothing is restarted', async () => {
        liveConversation(true);
        service._setState({ pendingQueue: { text: 'next question', queued_at: 1 } });
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.applyEffortSelection('medium');

        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('medium'))).toBeGreaterThan(-1);
      });

      it('applies only the latest of two quick picks', async () => {
        liveConversation(true);
        const firstPin = createDeferred<void>();
        let pinWrites = 0;
        overrideInvoke('set_effort_pin', async () => {
          pinWrites += 1;
          if (pinWrites === 1) await firstPin.promise;
        });
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const first = service.applyEffortSelection('low');
        await service.applyEffortSelection('max');
        firstPin.resolve();
        await first;
        service.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await new Promise((r) => setTimeout(r, 10));

        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('max'))).toBeGreaterThan(-1);
        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('low'))).toBe(-1);
      });

      it('drops a pick whose check returns after a newer pick', async () => {
        liveConversation(true);
        const firstCheck = createDeferred<boolean>();
        let checks = 0;
        overrideInvoke('get_chat_takes_wire_effort', async () => {
          checks += 1;
          return checks === 1 ? firstCheck.promise : true;
        });
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const first = service.applyEffortSelection('low');
        await vi.waitFor(() => {
          expect(checks).toBe(1);
        });
        await service.applyEffortSelection('max');
        firstCheck.resolve(true);
        await first;
        service.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await new Promise((r) => setTimeout(r, 10));

        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('max'))).toBeGreaterThan(-1);
        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('low'))).toBe(-1);
      });

      it('drops the pick when the conversation is replaced while the check runs', async () => {
        liveConversation(false);
        const check = createDeferred<boolean>();
        let checks = 0;
        overrideInvoke('get_chat_takes_wire_effort', () => {
          checks += 1;
          return check.promise;
        });
        await Promise.resolve();

        const applying = service.applyEffortSelection('low');
        await vi.waitFor(() => {
          expect(checks).toBe(1);
        });
        service.resetForNewConversation();
        check.resolve(false);
        await applying;

        expect(service.deferredEffort()).toBeNull();
      });

      it('holds a pick flushed at a turn end without a session id until one arrives', async () => {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        mockTauri.invokeHandler = async (cmd: string) =>
          cmd === 'get_chat_takes_wire_effort' ? true : undefined;
        service.isStreaming = true;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.applyEffortSelection('low');
        service.handleStreamChunk({ chunk_type: 'Result', data: {} } as never);
        await new Promise((r) => setTimeout(r, 0));
        expect(indexOfCall(invokeSpy.mock.calls, checked)).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('low'))).toBe(-1);

        service.handleStreamChunk({
          chunk_type: 'SystemInit',
          data: { model: 'claude-opus-4-8', session_id: LIVE },
        });
        service.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('low'))).toBeGreaterThan(-1);
        });
      });

      it('applies a pick made during a resume as soon as the resume completes', async () => {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        const resumed = createDeferred<void>();
        mockTauri.invokeHandler = async (cmd: string) => {
          if (cmd === 'resume_conversation') return resumed.promise;
          if (cmd === 'get_chat_takes_wire_effort') return true;
          if (cmd === 'get_conversation') {
            return {
              session_id: LIVE,
              messages: [{ role: 'assistant', content: 'Hello', timestamp: null }],
            };
          }
          return undefined;
        };
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const resuming = service.resumeConversation(LIVE);
        await service.applyEffortSelection('high');
        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('high'))).toBe(-1);
        resumed.resolve();
        await resuming;

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('high'))).toBeGreaterThan(-1);
        });
      });

      it('an error that ends the turn applies a pending effort pick', async () => {
        liveConversation(true);
        await Promise.resolve();
        service.isStreaming = true;
        await service.applyEffortSelection('max');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        service.handleStreamChunk({
          chunk_type: 'Error',
          data: { content: 'Overloaded', turn_ended: true },
        });

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('max'))).toBeGreaterThan(-1);
        });
      });

      it('an error that ends the turn applies a pending model pick', async () => {
        liveConversation(true);
        await Promise.resolve();
        service.isStreaming = true;
        await service.applyModelSelection({
          catalogId: 'claude-haiku-4-5',
          wireId: 'claude-haiku-4-5',
          providerId: 'anthropic',
          kind: 'anthropic_oauth',
          isDefault: false,
        });
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        service.handleStreamChunk({
          chunk_type: 'Error',
          data: { content: 'Overloaded', turn_ended: true },
        });

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, wiredModel)).toBeGreaterThan(-1);
        });
        expect(service.pendingModelOverride()).toBeNull();
      });

      it('an error that may arrive mid-turn leaves the pending picks queued', async () => {
        liveConversation(true);
        await Promise.resolve();
        service.isStreaming = true;
        await service.applyEffortSelection('max');
        await service.applyModelSelection({
          catalogId: 'claude-haiku-4-5',
          wireId: 'claude-haiku-4-5',
          providerId: 'anthropic',
          kind: 'anthropic_oauth',
          isDefault: false,
        });
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        service.handleStreamChunk({ chunk_type: 'Error', data: { content: 'rate limit' } });
        await new Promise((r) => setTimeout(r, 0));

        expect(indexOfCall(invokeSpy.mock.calls, wiredModel)).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, wiredEffort('max'))).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, checked)).toBe(-1);
        expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');
      });
    });

    it('an idle model-pick respawn claims init() so a remount starts no second session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
    });

    it('an idle effort-pick respawn claims init() so a remount starts no second session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyEffortSelection('high');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
    });

    it('picking the Default row clears the pin and switches the live session to the account default', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();

      await service.applyModelSelection({
        catalogId: 'claude-opus-5',
        wireId: 'claude-opus-5[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: true,
      });

      const commands = invokeSpy.mock.calls.map(([cmd]) => cmd);
      expect(commands).toContain('clear_model_pin');
      expect(commands).not.toContain('set_model_pin');
      expect(commands.indexOf('clear_model_pin')).toBeLessThan(commands.indexOf('send_message'));
      const sent = invokeSpy.mock.calls.find(([cmd]) => cmd === 'send_message');
      expect(JSON.stringify(sent?.[1])).toContain('/model default');
      expect(JSON.stringify(sent?.[1])).not.toContain('[1m]');
    });

    it('picking the Default row mid-stream queues the default alias, never the 1M wire id', async () => {
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5', session_id: 'sess-live' },
      });
      await Promise.resolve();
      service.isStreaming = true;

      await service.applyModelSelection({
        catalogId: 'claude-opus-5',
        wireId: 'claude-opus-5[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: true,
      });

      expect(service.pendingModelOverride()).toBe('default');
    });

    it('a Default flag on a proxy-routed pick is ignored: the provider model is still written', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'qwen3',
        wireId: 'local/qwen3',
        providerId: 'local',
        kind: 'local',
        isDefault: true,
      });

      const commands = invokeSpy.mock.calls.map(([cmd]) => cmd);
      expect(commands).toContain('set_provider_model');
      expect(commands).not.toContain('clear_model_pin');
    });

    it('a failed pin clear surfaces the error and never touches the live session', async () => {
      const original = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) => {
        if (cmd === 'clear_model_pin') throw new Error('malformed settings.json');
        return original(cmd, args);
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();

      await service.applyModelSelection({
        catalogId: 'claude-opus-5',
        wireId: 'claude-opus-5[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: true,
      });

      expect(service.modelSelectionError()).toBe('malformed settings.json');
      expect(invokeSpy.mock.calls.some(([cmd]) => cmd === 'send_message')).toBe(false);
    });

    it('applyModelSelection during a streaming turn queues the switch instead of silently dropping it', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();
      service.isStreaming = true;

      await service.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      const modelSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSend).toBeUndefined();
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');
    });

    it('resetForNewConversation clears a queued mid-stream pick so it cannot leak into the fresh session', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-old' },
      });
      await Promise.resolve();
      service.isStreaming = true;
      await service.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');

      service.isStreaming = false;
      service.resetForNewConversation();
      expect(service.pendingModelOverride()).toBeNull();

      invokeSpy.mockClear();
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-new' },
      });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-new' },
      } as never);
      await new Promise((r) => setTimeout(r, 0));

      const modelSendCall = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSendCall).toBeUndefined();
    });

    it('resumeConversation clears a queued mid-stream pick so a later SystemInit/Result sends no /model', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      mockTauri.invokeHandler = async () => undefined;
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'old-sess' },
      });
      await Promise.resolve();
      service.isStreaming = true;
      await service.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');
      service.isStreaming = false;

      await service.resumeConversation('old-sess');
      expect(service.pendingModelOverride()).toBeNull();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'old-sess' },
      });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'old-sess' },
      } as never);
      await new Promise((r) => setTimeout(r, 0));

      const modelSendCall = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSendCall).toBeUndefined();
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('a project switch clears a queued mid-stream pick so a later SystemInit sends no /model', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      service.isStreaming = true;
      await service.applyModelSelection({
        catalogId: 'claude-opus-4-8-1m',
        wireId: 'claude-opus-4-8[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      expect(service.pendingModelOverride()).toBe('claude-opus-4-8[1m]');
      service.isStreaming = false;

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.dispatchEvent('project_switch_started', { project: 'other-project' });
      await new Promise((r) => setTimeout(r, 10));
      expect(service.pendingModelOverride()).toBeNull();

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-other' },
      });
      await Promise.resolve();

      const modelSendCall = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSendCall).toBeUndefined();
    });
  });

  describe('plan usage limits (get_usage) and the rate_limit_event signal', () => {
    const NOW = Date.parse('2026-09-18T10:00:00Z');
    const WARNING = {
      status: 'allowed_warning',
      rate_limit_type: 'five_hour',
      utilization_percent: 60,
      resets_at: 1738425600,
      overage_status: null,
      is_using_overage: false,
    };
    let usageCalls: number;

    function useProvider(kind: string): void {
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) => {
        if (cmd === 'get_llm_config') {
          return {
            provider: kind.startsWith('anthropic') ? 'anthropic' : 'local',
            model: null,
            base_url: null,
            default_base_url: null,
            providers: [{ id: 'active', kind }],
            active: { provider_id: 'active' },
          };
        }
        if (cmd === 'get_plan_usage') {
          usageCalls += 1;
          return {
            subscription_type: 'max',
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 15, resets_at: '2026-09-18T12:40:00.744446+00:00' },
              seven_day: { utilization: 70, resets_at: '2026-09-22T21:00:00.744471+00:00' },
              seven_day_opus: null,
              seven_day_sonnet: null,
              model_scoped: [],
              extra_usage: null,
            },
          };
        }
        return base(cmd, args);
      };
    }

    async function settle(): Promise<void> {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    }

    beforeEach(() => {
      usageCalls = 0;
      TestBed.inject(ProjectStateService).activeProject.set('test');
    });

    it('reads the limits as soon as the session answers initialize', async () => {
      useProvider('anthropic_oauth');

      mockTauri.dispatchEvent('chat_session_info', {
        project: 'test',
        status: { state: 'ready', info: { models: [], account: {} } },
      });
      TestBed.tick();
      await settle();

      expect(usageCalls).toBe(1);
      const windows = TestBed.inject(PlanUsageService).limits('test', NOW)?.windows ?? [];
      expect(windows.map((w) => [w.key, w.utilization])).toEqual([
        ['five_hour', 15],
        ['seven_day', 70],
      ]);
    });

    it('re-reads the limits after every completed turn', async () => {
      useProvider('anthropic_oauth');
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });
      await settle();

      expect(usageCalls).toBe(1);
    });

    it('re-reads the limits after a turn that ended in an error', async () => {
      useProvider('anthropic_oauth');

      service.handleStreamChunk({ chunk_type: 'Error', data: { content: 'boom' } });
      await settle();

      expect(usageCalls).toBe(1);
    });

    it('stores a 60% warning as the status signal and triggers a refresh', async () => {
      useProvider('anthropic_oauth');

      service.handleStreamChunk({ chunk_type: 'RateLimit', data: WARNING });
      await settle();

      expect(TestBed.inject(PlanUsageService).lastSignal('test')).toEqual(WARNING);
      expect(usageCalls).toBe(1);
    });

    it('keeps the status and reset time of an event that carries no utilization', async () => {
      useProvider('anthropic_oauth');
      const allowed = { ...WARNING, status: 'allowed', utilization_percent: null };

      service.handleStreamChunk({ chunk_type: 'RateLimit', data: allowed });
      await settle();

      expect(TestBed.inject(PlanUsageService).lastSignal('test')).toEqual(allowed);
      expect(usageCalls).toBe(1);
    });

    it('keeps the limits across a new conversation', async () => {
      useProvider('anthropic_oauth');
      service.handleStreamChunk({ chunk_type: 'RateLimit', data: WARNING });
      await settle();

      service.resetForNewConversation();

      const planUsage = TestBed.inject(PlanUsageService);
      expect(planUsage.limits('test', NOW)?.windows.length).toBe(2);
      expect(planUsage.lastSignal('test')).toEqual(WARNING);
    });

    it('never asks for plan limits with an API key: there are none', async () => {
      useProvider('anthropic_api_key');

      service.handleStreamChunk({ chunk_type: 'RateLimit', data: WARNING });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });
      await settle();

      expect(usageCalls).toBe(0);
      expect(TestBed.inject(PlanUsageService).limits('test', NOW)).toBeNull();
      expect(TestBed.inject(PlanUsageService).lastSignal('test')).toBeNull();
    });

    it('never sends a control request for a proxy-routed provider', async () => {
      useProvider('local');

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });
      await settle();

      expect(usageCalls).toBe(0);
    });

    it('drops the limits on logout', async () => {
      useProvider('anthropic_oauth');
      const projectState = TestBed.inject(ProjectStateService);
      await service.init();
      service.handleStreamChunk({ chunk_type: 'RateLimit', data: WARNING });
      await settle();
      expect(TestBed.inject(PlanUsageService).limits('test', NOW)).not.toBeNull();

      projectState.forceUnconfigured();

      expect(TestBed.inject(PlanUsageService).limits('test', NOW)).toBeNull();
      expect(TestBed.inject(PlanUsageService).lastSignal('test')).toBeNull();
    });

    it('drops the limits when the provider stops being an Anthropic sign-in', async () => {
      useProvider('anthropic_oauth');
      service.handleStreamChunk({ chunk_type: 'RateLimit', data: WARNING });
      await settle();
      expect(TestBed.inject(PlanUsageService).limits('test', NOW)).not.toBeNull();

      useProvider('local');
      await service.refreshLlmConfigCache();

      expect(TestBed.inject(PlanUsageService).limits('test', NOW)).toBeNull();
    });

    it('output tokens accumulate across turns', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.02,
          usage: { input_tokens: 3, output_tokens: 65 },
        },
      });
      expect(service.sessionStats?.total_output_tokens).toBe(65);

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'bye' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.04,
          usage: { input_tokens: 3, output_tokens: 88 },
        },
      });
      expect(service.sessionStats?.total_output_tokens).toBe(153);
    });
  });

  describe('resetForNewConversation', () => {
    it('clears messages, blocks, and streaming state', () => {
      service._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [{ type: 'text', content: 'partial' }],
        sessionStats: {
          session_id: 'x',
          total_cost: 0,
          total_output_tokens: 0,
          context_window_size: 200000,
        },
      });
      service.isStreaming = true;

      service.resetForNewConversation();

      expect(service.messages).toEqual([]);
      expect(service.currentBlocks).toEqual([]);
      expect(service.isStreaming).toBe(false);
      expect(service.sessionStats).toBeNull();
    });

    it('rebuilds the state-tree signal', () => {
      service._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'x' } });
      expect(service.state().entries.length).toBeGreaterThan(0);

      service.resetForNewConversation();

      expect(service.state().entries).toEqual([]);
      expect(service.state().is_streaming).toBe(false);
    });
  });

  describe('loadMessages', () => {
    it('sets messages array', () => {
      service.loadMessages([
        { role: 'user', blocks: [{ type: 'text', content: 'loaded' }], timestamp: 1 },
      ]);

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks[0]).toEqual({ type: 'text', content: 'loaded' });
    });

    it('re-reconciles the last assistant turn from the proxy SSOT on reload', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        if (cmd === 'get_usage_for_response') {
          return { cost_usd: 0.0858, cost_source: 'actual' };
        }
        if (cmd === 'get_conversation_cost') return 0.0858;
        return undefined;
      });

      service.loadMessages([
        { role: 'user', blocks: [{ type: 'text', content: 'q' }], timestamp: 1 },
        {
          role: 'assistant',
          blocks: [{ type: 'text', content: 'a' }],
          timestamp: 2,
          uuid: 'gen-1',
          meta: { cost: 0.13 },
        },
      ]);

      await vi.waitFor(() => {
        expect(service.messages.find((m) => m.uuid === 'gen-1')?.meta?.cost).toBeCloseTo(0.0858, 6);
      });
    });
  });

  describe('state-tree signal rebuild on mutation', () => {
    it('rebuilds the signal on a stream chunk so projections refresh', () => {
      const before = service.state();
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });

      expect(service.state()).not.toBe(before);
      expect(service.currentBlocksFromState()).toEqual([{ type: 'text', content: 'hi' }]);
      expect(service.isStreamingFromState()).toBe(true);
    });

    it('leaves the signal untouched when a chunk produces no state change', () => {
      const before = service.state();
      service.handleStreamChunk({
        chunk_type: 'UnknownFutureType' as StreamChunk['chunk_type'],
        data: {},
      } as StreamChunk);
      expect(service.state()).toBe(before);
    });
  });

  describe('immutable updates', () => {
    it('creates new array references on text chunk', () => {
      const originalBlocks = service.currentBlocks;
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      expect(service.currentBlocks).not.toBe(originalBlocks);
    });

    it('creates new array references on ToolStart', () => {
      const originalBlocks = service.currentBlocks;
      service.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      expect(service.currentBlocks).not.toBe(originalBlocks);
    });

    it('creates new messages array on Result', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'test' } });
      const originalMessages = service.messages;
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });
      expect(service.messages).not.toBe(originalMessages);
    });
  });

  describe('AskUserQuestion', () => {
    function askChunk(toolId: string, count: number): StreamChunk {
      return {
        chunk_type: 'AskUserQuestion',
        data: {
          tool_id: toolId,
          questions: Array.from({ length: count }, (_, i) => ({
            question: `Q${i}`,
            header: `H${i}`,
            options: [
              { label: 'A', value: 'a' },
              { label: 'B', value: 'b' },
            ],
            multi_select: false,
          })),
          current_index: 0,
        },
      };
    }

    it('chunk handler builds composite block with one question', () => {
      service.handleStreamChunk(askChunk('toolu_ask1', 1));

      expect(service.currentBlocks).toHaveLength(1);
      const block = service.currentBlocks[0];
      expect(block.type).toBe('ask_user');
      if (block.type === 'ask_user') {
        expect(block.question.tool_id).toBe('toolu_ask1');
        expect(block.question.questions).toHaveLength(1);
        expect(block.question.questions[0].question).toBe('Q0');
        expect(block.question.current_index).toBe(0);
        expect(block.question.answers).toEqual([null]);
      }
    });

    it('chunk handler builds composite block with four questions', () => {
      service.handleStreamChunk(askChunk('toolu_ask4', 4));
      const block = service.currentBlocks[0];
      if (block.type === 'ask_user') {
        expect(block.question.questions).toHaveLength(4);
        expect(block.question.answers).toEqual([null, null, null, null]);
      }
    });

    it('submitAnswer optimistically advances current_index to next null slot', async () => {
      service.handleStreamChunk(askChunk('toolu_ask3', 3));

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.submitAnswer('toolu_ask3', 0, 'A');

      const block = service.currentBlocks[0];
      if (block.type === 'ask_user') {
        expect(block.question.answers).toEqual(['A', null, null]);
        expect(block.question.current_index).toBe(1);
      }
      expect(invokeSpy).toHaveBeenCalledWith('submit_question_answer', {
        toolUseId: 'toolu_ask3',
        questionIdx: 0,
        answer: 'A',
      });
    });

    it('submitAnswer for final slot fills the last answers slot and points current_index past the end', async () => {
      service.handleStreamChunk(askChunk('toolu_ask2', 2));
      await service.submitAnswer('toolu_ask2', 0, 'first');
      await service.submitAnswer('toolu_ask2', 1, 'second');

      const block = service.currentBlocks[0];
      if (block.type === 'ask_user') {
        expect(block.question.answers).toEqual(['first', 'second']);
        expect(block.question.current_index).toBe(2);
      }
    });

    it('submitAnswer reverts the slot and appends an error block on backend failure', async () => {
      service.isStreaming = true;
      service.handleStreamChunk(askChunk('toolu_ask1', 1));

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'submit_question_answer') throw new Error('pipe broken');
        return undefined;
      };

      await service.submitAnswer('toolu_ask1', 0, 'A');

      expect(service.isStreaming).toBe(false);

      const askBlock = service.currentBlocks.find(
        (b) => b.type === 'ask_user' && b.question.tool_id === 'toolu_ask1'
      );
      expect(askBlock).toBeDefined();
      if (askBlock && askBlock.type === 'ask_user') {
        expect(askBlock.question.answers).toEqual([null]);
        expect(askBlock.question.current_index).toBe(0);
      }

      const lastBlock = service.currentBlocks[service.currentBlocks.length - 1];
      expect(lastBlock.type).toBe('error');
      if (lastBlock.type === 'error') {
        expect(lastBlock.content).toContain('Failed to send answer');
      }
    });

    it('submitAnswer with stale tool_use_id calls backend (host validates)', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.submitAnswer('toolu_nonexistent', 0, 'yes');

      expect(service.currentBlocks).toHaveLength(0);
      expect(invokeSpy).toHaveBeenCalledWith('submit_question_answer', {
        toolUseId: 'toolu_nonexistent',
        questionIdx: 0,
        answer: 'yes',
      });
    });

    it('submitAnswer forwards multi-select joined value verbatim', async () => {
      service.handleStreamChunk({
        chunk_type: 'AskUserQuestion',
        data: {
          tool_id: 'toolu_ask1',
          questions: [
            {
              question: 'Pick fruits',
              header: '',
              multi_select: true,
              options: [
                { label: 'A', value: 'apple' },
                { label: 'B', value: 'banana' },
              ],
            },
          ],
          current_index: 0,
        },
      });

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.submitAnswer('toolu_ask1', 0, 'A, B');

      expect(invokeSpy).toHaveBeenCalledWith('submit_question_answer', {
        toolUseId: 'toolu_ask1',
        questionIdx: 0,
        answer: 'A, B',
      });
    });
  });

  describe('AskUserQuestion persistence round-trip', () => {
    function multiQuestionBlock() {
      return {
        type: 'ask_user' as const,
        question: {
          tool_id: 'toolu_round',
          questions: [
            {
              question: 'Q0',
              header: 'H0',
              multi_select: false,
              options: [
                { label: 'A', value: 'a' },
                { label: 'B', value: 'b' },
              ],
            },
            {
              question: 'Q1',
              header: '',
              multi_select: true,
              options: [],
            },
          ],
          current_index: 1,
          answers: ['A', null] as (string | null)[],
        },
      };
    }

    it('messageBlocksToState round-trips ask_user composite without losing data', () => {
      const block = multiQuestionBlock();
      const state = messageBlocksToState([block]);
      const recovered = stateBlocksToMessageBlocks(state);
      expect(recovered).toEqual([block]);
    });

    it('round-trips an empty single-question block', () => {
      const block = {
        type: 'ask_user' as const,
        question: {
          tool_id: 't1',
          questions: [{ question: 'Solo', header: '', multi_select: false, options: [] }],
          current_index: 0,
          answers: [null] as (string | null)[],
        },
      };
      const recovered = stateBlocksToMessageBlocks(messageBlocksToState([block]));
      expect(recovered).toEqual([block]);
    });

    it('round-trips a fully-answered 4-question block', () => {
      const block = {
        type: 'ask_user' as const,
        question: {
          tool_id: 't4',
          questions: ['A', 'B', 'C', 'D'].map((q) => ({
            question: q,
            header: '',
            multi_select: false,
            options: [],
          })),
          current_index: 4,
          answers: ['a', 'b', 'c', 'd'] as (string | null)[],
        },
      };
      const recovered = stateBlocksToMessageBlocks(messageBlocksToState([block]));
      expect(recovered).toEqual([block]);
    });
  });

  describe('chip block persistence round-trip', () => {
    it('messageBlocksToState round-trips a control-chip block instead of dropping it', () => {
      const block = { type: 'chip' as const, command: 'model', argument: 'claude-sonnet-5' };
      const state = messageBlocksToState([block]);
      expect(state).toEqual([{ kind: 'chip', command: 'model', argument: 'claude-sonnet-5' }]);
      const recovered = stateBlocksToMessageBlocks(state);
      expect(recovered).toEqual([block]);
    });

    it('a ControlChip message projected through the full state tree keeps its chip block', () => {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'chip', command: 'effort', argument: 'high' }],
            timestamp: 1,
            uuid: 'msg_chip_1',
            uuid_status: 'Committed',
          },
        ],
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: '' } });

      const projectedEntry = service.state().entries[0];
      expect(projectedEntry.blocks).toEqual([
        { kind: 'chip', command: 'effort', argument: 'high' },
      ]);

      const projectedMessage = service.messagesFromState()[0];
      expect(projectedMessage.blocks).toEqual([
        { type: 'chip', command: 'effort', argument: 'high' },
      ]);
    });
  });

  describe('stateBlocksToMessageBlocks unknown-kind handling (ADR-042 drift guard)', () => {
    it('renders a placeholder error block instead of silently dropping an unknown kind', () => {
      const unknown = { kind: 'future_widget', payload: 42 } as unknown as Parameters<
        typeof stateBlocksToMessageBlocks
      >[0][number];

      const out = stateBlocksToMessageBlocks([unknown]);

      expect(out).toEqual([{ type: 'error', content: 'Unsupported message block: future_widget' }]);
    });

    it('preserves known blocks around an unknown one rather than aborting the loop', () => {
      const known = { kind: 'text', content: 'hello' } as Parameters<
        typeof stateBlocksToMessageBlocks
      >[0][number];
      const unknown = { kind: 'mystery' } as unknown as Parameters<
        typeof stateBlocksToMessageBlocks
      >[0][number];

      const out = stateBlocksToMessageBlocks([known, unknown, known]);

      expect(out).toEqual([
        { type: 'text', content: 'hello' },
        { type: 'error', content: 'Unsupported message block: mystery' },
        { type: 'text', content: 'hello' },
      ]);
    });
  });

  describe('stateBlocksToMessageBlocks error kind (Claude Code watchdog interruptions)', () => {
    it('tags a watchdog error entry with its ErrorBlockKind', () => {
      const errorState = {
        kind: 'error',
        content: 'API Error: Connection lost mid-response. The response above may be incomplete.',
      } as Parameters<typeof stateBlocksToMessageBlocks>[0][number];

      const out = stateBlocksToMessageBlocks([errorState]);

      expect(out).toStrictEqual([
        {
          type: 'error',
          content: 'API Error: Connection lost mid-response. The response above may be incomplete.',
          kind: 'connection_interrupted',
        },
      ]);
    });

    it('leaves an unrelated error entry with no kind property at all', () => {
      const errorState = {
        kind: 'error',
        content: 'Something went wrong',
      } as Parameters<typeof stateBlocksToMessageBlocks>[0][number];

      const out = stateBlocksToMessageBlocks([errorState]);

      expect(out).toStrictEqual([{ type: 'error', content: 'Something went wrong' }]);
    });
  });

  describe('auth error routing', () => {
    it('surfaces auth error as auth_required status', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      projectState.activeProject.set('test');
      projectState.status.set('ready');

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat')
          throw new Error('Claude is not authenticated. Please authenticate first.');
        return undefined;
      };

      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      expect(projectState.status()).toBe('auth_required');
    });

    it('routes auth error in sendMessage retry to auth_required', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      projectState.activeProject.set('test');
      projectState.status.set('ready');

      let callCount = 0;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat') {
          callCount++;
          if (callCount > 1)
            throw new Error('Claude is not authenticated. Please authenticate first.');
          return undefined;
        }
        if (cmd === 'send_message') throw new Error('session exited');
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        return undefined;
      };

      await service.init();
      await vi.waitFor(() => {
        expect(service.sessionStartInFlightFromState()).toBe(false);
      });
      await service.sendMessage('hello');
      expect(projectState.status()).toBe('auth_required');
    });
  });

  describe('stopConversation', () => {
    it('stopConversation finalizes text blocks and resets isStreaming', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.isStreaming = true;
      service._setState({ currentBlocks: [{ type: 'text', content: 'partial' }] });
      await service.stopConversation();
      expect(invokeSpy).toHaveBeenCalledWith('stop_chat');
      expect(invokeSpy).toHaveBeenCalledTimes(1);
      expect(service.isStreaming).toBe(false);
      expect(service.currentBlocks).toEqual([]);
      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].role).toBe('assistant');
      expect(service.messages[0].blocks).toEqual([{ type: 'text', content: 'partial' }]);
    });

    it('stopConversation drops unanswered ask_user blocks when finalizing', async () => {
      service.isStreaming = true;
      service._setState({
        currentBlocks: [
          { type: 'text', content: 'Let me ask:' },
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
      await service.stopConversation();
      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].blocks).toEqual([{ type: 'text', content: 'Let me ask:' }]);
    });

    it('stopConversation skips appending an assistant message if only ask_user was pending', async () => {
      service.isStreaming = true;
      service._setState({
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
      await service.stopConversation();
      expect(service.messages).toHaveLength(0);
      expect(service.isStreaming).toBe(false);
    });

    it('stopConversation called twice only invokes stop_chat once', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.isStreaming = true;
      const p1 = service.stopConversation();
      const p2 = service.stopConversation();
      await Promise.all([p1, p2]);
      expect(invokeSpy.mock.calls.filter((c) => c[0] === 'stop_chat')).toHaveLength(1);
    });

    it('stopConversation is a no-op when not streaming', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.isStreaming = false;
      await service.stopConversation();
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('stopConversation resets state and surfaces a real backend failure to the user', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'stop_chat') throw new Error('ipc broken');
        return undefined;
      };
      service.isStreaming = true;
      service._setState({ currentBlocks: [{ type: 'text', content: 'x' }] });
      await service.stopConversation();
      expect(service.isStreaming).toBe(false);
      expect(service.messages).toHaveLength(2);
      const errorBlock = service.messages[1].blocks[0];
      expect(errorBlock.type).toBe('error');
      expect((errorBlock as { type: 'error'; content: string }).content).toContain('Stop failed');
    });

    it('stopConversation suppresses benign "no active session" without surfacing an error', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'stop_chat') throw new Error('no active session');
        return undefined;
      };
      service.isStreaming = true;
      service._setState({ currentBlocks: [{ type: 'text', content: 'x' }] });
      await service.stopConversation();
      expect(service.isStreaming).toBe(false);
      expect(service.messages).toHaveLength(1);
    });

    it('stopConversation increments _turnId so late stream chunks are dropped', async () => {
      service.isStreaming = true;
      const before = service.turnId;
      await service.stopConversation();
      expect(service.turnId).toBeGreaterThan(before);
    });

    it('stop_chat reuses the existing session — next sendMessage skips start_chat / resume_conversation', async () => {
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };

      service.isStreaming = true;
      service._setState({ currentBlocks: [{ type: 'text', content: 'partial' }] });
      await service.stopConversation();

      expect(calls).toContain('stop_chat');
      expect(calls).not.toContain('resume_conversation');
      expect(calls).not.toContain('start_chat');

      await service.sendMessage('next turn on same session');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
    });

    it('QueueDrained after Result dispatches the queued turn (not-streaming gate must pass it)', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
      service._setState({ pendingQueue: { text: 'queued follow-up', queued_at: 1 } });
      service.isStreaming = true;
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Result',
        data: {
          session_id: 's-q',
          total_cost: 0.01,
          usage: { output_tokens: 5 },
          result_text: null,
          context_window_size: 200_000,
        },
      });
      expect(service.isStreaming).toBe(false);

      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'QueueDrained',
        data: { session_id: 's-q', text: 'queued follow-up' },
      });
      expect(service.pendingQueue).toBeNull();
      expect(service.isStreaming).toBe(true);
      const lastUser = [...service.messages].reverse().find((m) => m.role === 'user');
      expect(
        lastUser?.blocks.some((b) => b.type === 'text' && b.content === 'queued follow-up')
      ).toBe(true);

      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Text',
        data: { content: 'ACK' },
      });
      expect(service.currentBlocks.some((b) => b.type === 'text' && b.content === 'ACK')).toBe(
        true
      );
    });

    it('late content chunks arriving after stopConversation are dropped via _turnId guard', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
      service.isStreaming = true;
      await service.stopConversation();
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Text',
        data: { content: 'late content from stopped turn' },
      });
      expect(service.isStreaming).toBe(false);
      expect(service.currentBlocks).toEqual([]);
      const lateText = service.messages.some((m) =>
        m.blocks.some((b) => b.type === 'text' && b.content === 'late content from stopped turn')
      );
      expect(lateText).toBe(false);
    });

    it('RateLimit chunk dispatched between turns still reaches the plan usage signal', async () => {
      mockTauri.isRunningInTauri = () => true;
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) =>
        cmd === 'get_llm_config'
          ? {
              provider: 'anthropic',
              model: null,
              base_url: null,
              default_base_url: null,
              providers: [{ id: 'anthropic', kind: 'anthropic_oauth' }],
              active: { provider_id: 'anthropic' },
            }
          : base(cmd, args);
      TestBed.inject(ProjectStateService).activeProject.set('test');
      await service.init();
      await service.refreshLlmConfigCache();
      service.isStreaming = true;
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Result',
        data: {
          session_id: 's1',
          total_cost: 0.01,
          usage: { output_tokens: 10 },
          result_text: null,
          context_window_size: 200_000,
        },
      });
      expect(service.isStreaming).toBe(false);
      expect(service.sessionStats).not.toBeNull();
      const signal = {
        status: 'rejected',
        rate_limit_type: 'five_hour',
        utilization_percent: 100,
        resets_at: 1776513600,
        overage_status: 'rejected',
        is_using_overage: false,
      };
      mockTauri.dispatchEvent('chat_stream', { chunk_type: 'RateLimit', data: signal });
      await new Promise((r) => setTimeout(r, 0));

      expect(TestBed.inject(PlanUsageService).lastSignal('test')).toEqual(signal);
    });

    it('SystemInit chunk dispatched between turns updates the model', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
      expect(service.isStreaming).toBe(false);
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-7' },
      });
      service.isStreaming = true;
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Result',
        data: {
          session_id: 's2',
          total_cost: 0,
          usage: null,
          result_text: null,
          context_window_size: 200_000,
        },
      });
      expect(service.sessionStats?.model).toBe('claude-opus-4-7');
    });

    it('drops late Text chunks after stopConversation — _messages and _sessionStats unchanged', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
      service.isStreaming = true;
      service._setState({ currentBlocks: [{ type: 'text', content: 'first' }] });
      await service.stopConversation();
      const messagesBefore = service.messages;
      const statsBefore = service.sessionStats;
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Text',
        data: { content: 'LATE' },
      });
      expect(service.messages).toBe(messagesBefore);
      expect(service.sessionStats).toBe(statsBefore);
      expect(service.currentBlocks).toEqual([]);
      expect(service.isStreaming).toBe(false);
    });

    it('drops late Result chunks after stopConversation — _messages length and _sessionStats identity unchanged', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
      service.isStreaming = true;
      await service.stopConversation();
      const lengthBefore = service.messages.length;
      const statsBefore = service.sessionStats;
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Result',
        data: {
          session_id: 'late',
          total_cost: 99,
          usage: null,
          result_text: 'late',
          context_window_size: 200_000,
        },
      });
      expect(service.messages.length).toBe(lengthBefore);
      expect(service.sessionStats).toBe(statsBefore);
      expect(service.isStreaming).toBe(false);
    });

    it('submitAnswer: stopConversation wins the race, no error block is appended', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
      service.isStreaming = true;
      service._setState({
        currentBlocks: [
          {
            type: 'ask_user',
            question: {
              tool_id: 't1',
              questions: [
                {
                  question: 'q?',
                  header: '',
                  options: [{ value: 'a', label: 'A' }],
                  multi_select: false,
                },
              ],
              current_index: 0,
              answers: [null],
            },
          },
        ],
      });
      const pendingAnswer = createDeferred<undefined>();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'submit_question_answer') return pendingAnswer.promise;
        return undefined;
      };
      const answerPromise = service.submitAnswer('t1', 0, 'A');
      await service.stopConversation();
      pendingAnswer.reject(new Error('Broken pipe'));
      await answerPromise;
      expect(service.messages.every((m) => m.blocks.every((b) => b.type !== 'error'))).toBe(true);
      expect(service.currentBlocks).toEqual([]);
    });
  });

  describe('UserMessageCommit chunk', () => {
    it('commits the UUID onto the most recent user entry that is missing one', () => {
      service._setState({
        messages: [
          { role: 'user', blocks: [{ type: 'text', content: 'first' }], timestamp: 1, uuid: 'u-1' },
          { role: 'user', blocks: [{ type: 'text', content: 'second' }], timestamp: 2 },
        ],
      });
      service.handleStreamChunk({
        chunk_type: 'UserMessageCommit',
        data: { uuid: 'u-2' },
      });
      expect(service.messages[1].uuid).toBe('u-2');
      expect(service.messages[1].uuid_status).toBe('Committed');
      expect(service.messages[0].uuid).toBe('u-1');
    });

    it('is a no-op when no user entry is missing a UUID', () => {
      service._setState({
        messages: [
          { role: 'user', blocks: [{ type: 'text', content: 'first' }], timestamp: 1, uuid: 'u-1' },
        ],
      });
      const before = service.messages;
      service.handleStreamChunk({
        chunk_type: 'UserMessageCommit',
        data: { uuid: 'u-2' },
      });
      expect(service.messages).toBe(before);
    });

    it('is a no-op when the message list is empty', () => {
      const before = service.messages;
      service.handleStreamChunk({
        chunk_type: 'UserMessageCommit',
        data: { uuid: 'u-1' },
      });
      expect(service.messages).toBe(before);
    });
  });

  describe('Result chunk with assistant_uuid', () => {
    it('stamps the committed UUID onto the finalized assistant entry', () => {
      service.isStreaming = true;
      service._setState({ currentBlocks: [{ type: 'text', content: 'reply' }] });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 's-1',
          total_cost: 0,
          usage: undefined,
          result_text: undefined,
          context_window_size: 200_000,
          assistant_uuid: 'a-1',
        },
      });
      const last = service.messages[service.messages.length - 1];
      expect(last.role).toBe('assistant');
      expect(last.uuid).toBe('a-1');
      expect(last.uuid_status).toBe('Committed');
    });

    it('omits uuid_status when assistant_uuid is missing', () => {
      service.isStreaming = true;
      service._setState({ currentBlocks: [{ type: 'text', content: 'reply' }] });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 's-1',
          total_cost: 0,
          usage: undefined,
          result_text: undefined,
          context_window_size: 200_000,
        },
      });
      const last = service.messages[service.messages.length - 1];
      expect(last.uuid).toBeUndefined();
      expect(last.uuid_status).toBeUndefined();
    });
  });

  describe('lastContextTokens', () => {
    it('exposes the last call context total from Result and survives reset', () => {
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 's1',
          usage: { input_tokens: 24771, output_tokens: 20 },
          context_usage: {
            input_tokens: 24771,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      });
      expect(service.lastContextTokens).toBe(24771);
      (service as unknown as { resetCoreStreamState(): void }).resetCoreStreamState();
      expect(service.lastContextTokens).toBe(24771);
    });
  });

  describe('copyMessage', () => {
    let copySpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const { Clipboard } = await import('@angular/cdk/clipboard');
      const cdkClipboard = TestBed.inject(Clipboard);
      copySpy = vi.fn().mockReturnValue(true);
      cdkClipboard.copy = copySpy as unknown as typeof cdkClipboard.copy;
    });

    it('writes flattened text content to the clipboard and returns true', () => {
      service._setState({
        messages: [
          {
            role: 'assistant',
            blocks: [
              { type: 'text', content: 'Hello' },
              {
                type: 'tool_use',
                tool: {
                  type: 'tool_use',
                  tool_id: 't',
                  tool_name: 'Read',
                  input_json: '{}',
                  status: 'done',
                  result: 'ok',
                  result_is_error: false,
                },
              },
              { type: 'text', content: 'World' },
            ],
            timestamp: 1,
          },
        ],
      });
      const ok = service.copyMessage(0);
      expect(ok).toBe(true);
      expect(copySpy).toHaveBeenCalledWith('Hello\n\nWorld');
    });

    it('returns false for an out-of-range index', () => {
      const ok = service.copyMessage(99);
      expect(ok).toBe(false);
      expect(copySpy).not.toHaveBeenCalled();
    });

    it('returns false when there is no copyable text (only tool_use/thinking)', () => {
      service._setState({
        messages: [
          {
            role: 'assistant',
            blocks: [{ type: 'thinking', content: 'hmm', collapsed: true }],
            timestamp: 1,
          },
        ],
      });
      const ok = service.copyMessage(0);
      expect(ok).toBe(false);
      expect(copySpy).not.toHaveBeenCalled();
    });

    it('returns false and warns when CDK Clipboard.copy returns false', () => {
      copySpy.mockReturnValueOnce(false);
      service._setState({
        messages: [{ role: 'assistant', blocks: [{ type: 'text', content: 'x' }], timestamp: 1 }],
      });
      const ok = service.copyMessage(0);
      expect(ok).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('canRetryLastAssistant / retryLastAssistant', () => {
    function seedRetryableSession(): void {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'q' }],
            timestamp: 1,
            uuid: 'msg_user_1',
            uuid_status: 'Committed',
          },
          {
            role: 'assistant',
            blocks: [{ type: 'text', content: 'a' }],
            timestamp: 2,
            uuid: 'msg_assist_1',
            uuid_status: 'Committed',
          },
        ],
        sessionStats: {
          session_id: '550e8400-e29b-41d4-a716-446655440000',
          total_cost: 0,
          usage: undefined,
          model: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;
    }

    it('canRetryLastAssistant returns true when last assistant is committed and a session id is known', () => {
      seedRetryableSession();
      expect(service.canRetryLastAssistant()).toBe(true);
    });

    it('canRetryLastAssistant returns false while streaming', () => {
      seedRetryableSession();
      service.isStreaming = true;
      expect(service.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant returns false when no assistant entry exists', () => {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'q' }],
            timestamp: 1,
            uuid: 'msg_user_1',
            uuid_status: 'Committed',
          },
        ],
        sessionStats: {
          session_id: '550e8400-e29b-41d4-a716-446655440000',
          total_cost: 0,
          usage: undefined,
          model: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      expect(service.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant returns false when the user UUID is missing', () => {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'q' }],
            timestamp: 1,
          },
          {
            role: 'assistant',
            blocks: [{ type: 'text', content: 'a' }],
            timestamp: 2,
            uuid: 'msg_assist_1',
            uuid_status: 'Committed',
          },
        ],
        sessionStats: {
          session_id: '550e8400-e29b-41d4-a716-446655440000',
          total_cost: 0,
          usage: undefined,
          model: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      expect(service.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant returns false when assistant uuid_status is Pending', () => {
      seedRetryableSession();
      service._setState({
        messages: [
          ...service.messages.slice(0, -1),
          { ...service.messages[service.messages.length - 1], uuid_status: 'Pending' },
        ],
      });
      expect(service.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant returns false without a session id', () => {
      seedRetryableSession();
      service._setState({ sessionStats: null });
      expect(service.canRetryLastAssistant()).toBe(false);
    });

    it('retryLastAssistant invokes the backend, trims the assistant entry, and starts streaming', async () => {
      seedRetryableSession();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const before = service.turnId;
      await service.retryLastAssistant();
      expect(invokeSpy).toHaveBeenCalledWith('retry_last_turn', {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        userUuid: 'msg_user_1',
      });
      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].role).toBe('user');
      expect(service.messages[0].edited_at).toBeDefined();
      expect(service.isStreaming).toBe(true);
      expect(service.turnId).toBeGreaterThan(before);
    });

    it('retryLastAssistant is a no-op when canRetry is false', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.retryLastAssistant();
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(service.isStreaming).toBe(false);
    });

    it('retryLastAssistant restores state and surfaces an error block on backend failure', async () => {
      seedRetryableSession();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'retry_last_turn') throw new Error('resume failed');
        return undefined;
      };
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await service.retryLastAssistant();
      expect(service.isStreaming).toBe(false);
      expect(service.messages).toHaveLength(3);
      const last = service.messages[2];
      expect(last.role).toBe('assistant');
      expect(last.blocks[0].type).toBe('error');
      expect((last.blocks[0] as { type: 'error'; content: string }).content).toContain(
        'Retry failed'
      );
      errSpy.mockRestore();
    });

    it('canRetryLastAssistant returns false when the anchor candidate is a control-chip message', () => {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'chip', command: 'model', argument: 'claude-sonnet-5' }],
            timestamp: 1,
            uuid: 'msg_user_1',
            uuid_status: 'Committed',
          },
          {
            role: 'assistant',
            blocks: [{ type: 'text', content: 'a' }],
            timestamp: 2,
            uuid: 'msg_assist_1',
            uuid_status: 'Committed',
          },
        ],
        sessionStats: {
          session_id: '550e8400-e29b-41d4-a716-446655440000',
          total_cost: 0,
          usage: undefined,
          model: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;

      expect(service.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant keeps the real anchor when a chip trails the last assistant', () => {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'real question' }],
            timestamp: 1,
            uuid: 'msg_user_1',
            uuid_status: 'Committed',
          },
          {
            role: 'assistant',
            blocks: [{ type: 'text', content: 'real answer' }],
            timestamp: 2,
            uuid: 'msg_assist_1',
            uuid_status: 'Committed',
          },
          {
            role: 'user',
            blocks: [{ type: 'chip', command: 'effort', argument: 'high' }],
            timestamp: 3,
            uuid: 'msg_user_2',
            uuid_status: 'Committed',
          },
        ],
        sessionStats: {
          session_id: '550e8400-e29b-41d4-a716-446655440000',
          total_cost: 0,
          usage: undefined,
          model: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;

      expect(service.canRetryLastAssistant()).toBe(true);
    });

    it('canRetryLastAssistant returns false when a chip sits directly before the last assistant', () => {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'chip', command: 'model', argument: 'claude-sonnet-5' }],
            timestamp: 1,
            uuid: 'msg_user_1',
            uuid_status: 'Committed',
          },
          {
            role: 'assistant',
            blocks: [{ type: 'text', content: 'real answer' }],
            timestamp: 2,
            uuid: 'msg_assist_1',
            uuid_status: 'Committed',
          },
        ],
        sessionStats: {
          session_id: '550e8400-e29b-41d4-a716-446655440000',
          total_cost: 0,
          usage: undefined,
          model: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;

      expect(service.canRetryLastAssistant()).toBe(false);
    });

    it('retryEnabled signal (state-tree path) stays false when a chip sits directly before the last assistant', () => {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'chip', command: 'model', argument: 'claude-sonnet-5' }],
            timestamp: 1,
            uuid: 'msg_user_1',
            uuid_status: 'Committed',
          },
          {
            role: 'assistant',
            blocks: [{ type: 'text', content: 'real answer' }],
            timestamp: 2,
            uuid: 'msg_assist_1',
            uuid_status: 'Committed',
          },
        ],
        sessionStats: {
          session_id: '550e8400-e29b-41d4-a716-446655440000',
          total_cost: 0,
          usage: undefined,
          model: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;
      service.handleStreamChunk({
        chunk_type: 'RateLimit',
        data: {
          status: 'allowed',
          rate_limit_type: null,
          utilization_percent: null,
          resets_at: null,
          overage_status: null,
          is_using_overage: null,
        },
      });

      expect(service.retryEnabled()).toBe(false);
    });

    it('retryEnabled signal (state-tree path) stays true when the anchor is a real question, chip trailing', () => {
      service._setState({
        messages: [
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'real question' }],
            timestamp: 1,
            uuid: 'msg_user_1',
            uuid_status: 'Committed',
          },
          {
            role: 'assistant',
            blocks: [{ type: 'text', content: 'real answer' }],
            timestamp: 2,
            uuid: 'msg_assist_1',
            uuid_status: 'Committed',
          },
          {
            role: 'user',
            blocks: [{ type: 'chip', command: 'effort', argument: 'high' }],
            timestamp: 3,
            uuid: 'msg_user_2',
            uuid_status: 'Committed',
          },
        ],
        sessionStats: {
          session_id: '550e8400-e29b-41d4-a716-446655440000',
          total_cost: 0,
          usage: undefined,
          model: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;
      service.handleStreamChunk({
        chunk_type: 'RateLimit',
        data: {
          status: 'allowed',
          rate_limit_type: null,
          utilization_percent: null,
          resets_at: null,
          overage_status: null,
          is_using_overage: null,
        },
      });

      expect(service.retryEnabled()).toBe(true);
    });
  });

  describe('per-turn meta on assistant entries', () => {
    it('attaches meta with model, usage, and cost from Result chunk', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.05,
          usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 10 },
          model: 'claude-opus-4-7',
          turn_usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 10,
            cache_write_tokens: 0,
          },
          turn_cost: 0.018,
        },
      });

      expect(service.messages).toHaveLength(1);
      const meta = service.messages[0].meta;
      expect(meta).toBeDefined();
      expect(meta?.model).toBe('claude-opus-4-7');
      expect(meta?.usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_write_tokens: 0,
      });
      expect(meta?.cost).toBe(0.018);
    });

    it('does not compute cost on the frontend when backend omits turn_cost', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.01,
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
          model: 'claude-sonnet-4-6',
          turn_usage: {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      });

      const meta = service.messages[0].meta;
      expect(meta?.model).toBe('claude-sonnet-4-6');
      expect(meta?.cost).toBeUndefined();
    });

    it('uses SystemInit model when the Result chunk omits `model`', () => {
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5' },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.001,
          usage: { input_tokens: 1, output_tokens: 1 },
          turn_usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
          turn_cost: 0.0005,
        },
      });

      expect(service.messages[0].meta?.model).toBe('claude-haiku-4-5');
    });

    it('leaves meta undefined when chunk has no usage/model/cost', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });

      expect(service.messages[0].meta).toBeUndefined();
    });

    it('simulates patch sequence: Add → Replace meta provisional → Replace meta final', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hi.' } });

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.002,
          usage: { input_tokens: 1_000, output_tokens: 500 },
          model: 'claude-haiku-4-5',
          turn_usage: {
            input_tokens: 1_000,
            output_tokens: 500,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
        },
      });

      const provisional = service.messages[0].meta;
      expect(provisional?.model).toBe('claude-haiku-4-5');
      expect(provisional?.cost).toBeUndefined();

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Final.' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.005,
          usage: { input_tokens: 2_000, output_tokens: 1_000 },
          model: 'claude-haiku-4-5',
          turn_usage: {
            input_tokens: 2_000,
            output_tokens: 1_000,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
          turn_cost: 0.007,
        },
      });

      expect(service.messages).toHaveLength(2);
      const finalMeta = service.messages[1].meta;
      expect(finalMeta?.cost).toBe(0.007);
    });
  });

  describe('queueMessage / cancelQueuedMessage / QueueDrained', () => {
    function setSession(id: string): void {
      service._setState({
        sessionStats: {
          session_id: id,
          total_cost: 0,
          model: '',
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          context_used: 0,
          total_output_tokens: 0,
          context_window_size: 200_000,
        } as never,
      });
    }

    it('queueMessage invokes backend with sessionId+text and sets pendingQueue', async () => {
      setSession('s-1');
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'queue_message') return null;
        return undefined;
      };

      const prior = await service.queueMessage('next');
      expect(prior).toBeNull();
      expect(calls).toEqual([{ cmd: 'queue_message', args: { sessionId: 's-1', text: 'next' } }]);
      expect(service.pendingQueue?.text).toBe('next');
    });

    it('queueMessage returns previous text when slot was already occupied', async () => {
      setSession('s-1');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'queue_message') return { text: 'older', queued_at: 1 };
        return undefined;
      };
      const prior = await service.queueMessage('newer');
      expect(prior).toBe('older');
      expect(service.pendingQueue?.text).toBe('newer');
    });

    it('SystemInit session_id enables queueMessage during the first turn (ADR-045)', async () => {
      service._setState({ sessionStats: null });
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6', session_id: 'init-1' },
      });
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'queue_message') return null;
        return undefined;
      };

      const prior = await service.queueMessage('follow-up');
      expect(prior).toBeNull();
      expect(calls).toEqual([
        { cmd: 'queue_message', args: { sessionId: 'init-1', text: 'follow-up' } },
      ]);
      expect(service.pendingQueue?.text).toBe('follow-up');
    });

    it('SystemInit with empty model seeds the session id without clobbering the model', () => {
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6' },
      });
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: '', session_id: 'init-2' },
      });
      expect(service.sessionStats?.session_id).toBe('init-2');
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });
      expect(service.sessionStats?.model).toBe('claude-opus-4-6');
    });

    it('queueMessage before any session id fills the local slot and defers the backend', async () => {
      service._setState({ sessionStats: null });
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      const prior = await service.queueMessage('next');
      expect(prior).toBeNull();
      expect(calls).not.toContain('queue_message');
      expect(service.pendingQueue?.text).toBe('next');
    });

    it('deferred queue flushes to the backend when SystemInit delivers the session id', async () => {
      service._setState({ sessionStats: null });
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'queue_message') return null;
        return undefined;
      };
      await service.queueMessage('early bird');
      expect(calls).toEqual([]);

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6', session_id: 'late-1' },
      });
      await vi.waitFor(() =>
        expect(calls).toEqual([
          { cmd: 'queue_message', args: { sessionId: 'late-1', text: 'early bird' } },
        ])
      );
      expect(service.pendingQueue?.text).toBe('early bird');
    });

    it('deferred queue flushes when the first Result delivers the session id', async () => {
      service._setState({ sessionStats: null });
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'queue_message') return null;
        return undefined;
      };
      await service.queueMessage('early bird');

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'res-1', total_cost: 0.01 },
      });
      await vi.waitFor(() =>
        expect(calls.filter((c) => c.cmd === 'queue_message')).toEqual([
          { cmd: 'queue_message', args: { sessionId: 'res-1', text: 'early bird' } },
        ])
      );
    });

    it('cancelling a deferred queue clears the slot and never reaches the backend', async () => {
      service._setState({ sessionStats: null });
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      await service.queueMessage('doomed');
      await service.cancelQueuedMessage();
      expect(service.pendingQueue).toBeNull();

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'm', session_id: 'late-2' },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(calls).not.toContain('queue_message');
    });

    it('queueMessage no-ops on empty text', async () => {
      setSession('s-1');
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      const prior = await service.queueMessage('');
      expect(prior).toBeNull();
      expect(calls).not.toContain('queue_message');
    });

    it('cancelQueuedMessage invokes backend and clears pendingQueue', async () => {
      setSession('s-1');
      service._setState({ pendingQueue: { text: 'q', queued_at: 1 } });
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        return undefined;
      };
      await service.cancelQueuedMessage();
      expect(calls).toContainEqual({
        cmd: 'cancel_queued_message',
        args: { sessionId: 's-1' },
      });
      expect(service.pendingQueue).toBeNull();
    });

    it('cancelQueuedMessage clears local slot when no session id is set', async () => {
      service._setState({
        sessionStats: null,
        pendingQueue: { text: 'orphan', queued_at: 1 },
      });
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      await service.cancelQueuedMessage();
      expect(service.pendingQueue).toBeNull();
      expect(calls).not.toContain('cancel_queued_message');
    });

    it('handleStreamChunk("QueueDrained") clears pendingQueue, appends user entry, flips streaming=true', () => {
      service._setState({
        messages: [],
        pendingQueue: { text: 'next', queued_at: 5 },
      });
      service.isStreaming = false;
      service.handleStreamChunk({
        chunk_type: 'QueueDrained',
        data: { session_id: 's-1', text: 'next' },
      });
      expect(service.pendingQueue).toBeNull();
      expect(service.isStreaming).toBe(true);
      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].role).toBe('user');
      expect(service.messages[0].blocks).toEqual([{ type: 'text', content: 'next' }]);
    });

    it('queueMessage swallows backend errors and keeps the visible slot', async () => {
      setSession('s-1');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'queue_message') throw new Error('backend down');
        return undefined;
      };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const prior = await service.queueMessage('next');
      warnSpy.mockRestore();
      expect(prior).toBeNull();
      expect(service.pendingQueue?.text).toBe('next');
    });

    it('resetForNewConversation clears pendingQueue', () => {
      service._setState({ pendingQueue: { text: 'leftover', queued_at: 1 } });
      service.resetForNewConversation();
      expect(service.pendingQueue).toBeNull();
    });
  });

  describe('state-tree signal projections', () => {
    it('initial state matches DEFAULT_STATE_TREE', () => {
      const s = service.state();
      expect(s.session_id).toBeNull();
      expect(s.entries).toEqual([]);
      expect(s.is_streaming).toBe(false);
      expect(s.pending_queue).toBeNull();
      expect(s.session_totals.cost).toBe(0);
    });

    it('messagesFromState mirrors messages getter after streaming a turn', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: ' world' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 's-mirror',
          total_cost: 0.001,
          usage: { input_tokens: 5, output_tokens: 2 },
          model: 'claude-opus-4-7',
          turn_usage: {
            input_tokens: 5,
            output_tokens: 2,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          },
          turn_cost: 0.001,
        },
      });
      const legacy = service.messages;
      const projected = service.messagesFromState();
      expect(projected.length).toBe(legacy.length);
      expect(projected[0].role).toBe(legacy[0].role);
      expect(projected[0].blocks.length).toBe(legacy[0].blocks.length);
      expect(service.isStreamingFromState()).toBe(service.isStreaming);
      expect(service.currentBlocksFromState().length).toBe(0);
    });

    it('currentBlocksFromState exposes trailing live-streaming entry', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'streaming...' } });
      expect(service.currentBlocksFromState().length).toBeGreaterThan(0);
      expect(service.isStreamingFromState()).toBe(true);
      expect(service.messagesFromState().length).toBe(0);
    });

    it('pendingQueueFromState mirrors pending_queue field after notifyChange', () => {
      service._setState({ pendingQueue: { text: 'next', queued_at: 1 } });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'tick' } });
      expect(service.pendingQueueFromState()?.text).toBe('next');
    });
  });

  describe('seedSessionId', () => {
    it('stamps the session id when none is set so retry/queue work pre-Result', () => {
      service._setState({ messages: [], currentBlocks: [], sessionStats: null });
      service.seedSessionId('resumed-sess-1');
      expect(service.sessionStats?.session_id).toBe('resumed-sess-1');
      expect(service.sessionStats?.total_cost).toBeNull();
      expect(service.sessionStats?.total_output_tokens).toBe(0);
    });

    it('is a no-op when the session id already matches', () => {
      service._setState({
        messages: [],
        currentBlocks: [],
        sessionStats: {
          session_id: 'sess-x',
          total_cost: 0.123,
          context_window_size: 200_000,
          total_output_tokens: 42,
        },
      });
      const before = service.sessionStats;
      service.seedSessionId('sess-x');
      expect(service.sessionStats).toBe(before);
      expect(service.sessionStats?.total_cost).toBe(0.123);
    });

    it('refuses an empty session id', () => {
      service._setState({ messages: [], currentBlocks: [], sessionStats: null });
      service.seedSessionId('');
      expect(service.sessionStats).toBeNull();
    });
  });

  describe('refreshLlmConfigCache', () => {
    it('updates the persisted context_tokens cache from the backend', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') return { context_tokens: 32_768 };
        return undefined;
      };
      await service.refreshLlmConfigCache();
      const internal = service as unknown as { _persistedContextTokens: number | null };
      expect(internal._persistedContextTokens).toBe(32_768);
    });

    it('clears the cache when the backend reports null context_tokens', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') return { context_tokens: null };
        return undefined;
      };
      const internal = service as unknown as { _persistedContextTokens: number | null };
      internal._persistedContextTokens = 99;
      await service.refreshLlmConfigCache();
      expect(internal._persistedContextTokens).toBeNull();
    });

    it('logs at debug level on backend failure without throwing', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') throw new Error('backend gone');
        return undefined;
      };
      await expect(service.refreshLlmConfigCache()).resolves.toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('does not dedupe — every call hits the backend', async () => {
      let calls = 0;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') {
          calls++;
          return { context_tokens: 1_000_000 };
        }
        return undefined;
      };
      await service.refreshLlmConfigCache();
      await service.refreshLlmConfigCache();
      await service.refreshLlmConfigCache();
      expect(calls).toBe(3);
    });
  });

  describe('resolveContextWindow priority chain', () => {
    type Internal = {
      resolveContextWindow: (live: number | undefined) => number | null;
      _persistedContextTokens: number | null;
      _contextWindowSize: number | null;
      _currentProvider: string | null;
      _activeKind: string | null;
      _contextSnapshot: { max_tokens: number } | null;
    };

    it('OpenRouter keeps the DEFAULT_CONTEXT_TOKENS fallback although its legacy provider reads "anthropic"', () => {
      const internal = service as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'open_router';
      internal._persistedContextTokens = null;
      internal._contextWindowSize = null;
      expect(internal.resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_TOKENS);
      expect(internal.resolveContextWindow(128_000)).toBe(128_000);
    });

    it('an Anthropic kind keeps the Claude Code path and invents no default', () => {
      const internal = service as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'anthropic_oauth';
      internal._persistedContextTokens = null;
      internal._contextWindowSize = null;
      expect(internal.resolveContextWindow(undefined)).toBeNull();
      internal._contextSnapshot = { max_tokens: 200_000 };
      expect(internal.resolveContextWindow(1_000_000)).toBe(200_000);
    });

    it('prefers the live stream value over every fallback for a routed provider', () => {
      const internal = service as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'open_router';
      internal._persistedContextTokens = 16_384;
      internal._contextWindowSize = 8_192;
      expect(internal.resolveContextWindow(500_000)).toBe(500_000);
    });

    it('falls back to persisted context_tokens when the live value is absent', () => {
      const internal = service as unknown as Internal;
      internal._currentProvider = 'local';
      internal._activeKind = 'local';
      internal._persistedContextTokens = 32_768;
      internal._contextWindowSize = 8_192;
      expect(internal.resolveContextWindow(undefined)).toBe(32_768);
    });

    it('falls back to previous _contextWindowSize when persisted is also absent', () => {
      const internal = service as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'open_router';
      internal._persistedContextTokens = null;
      internal._contextWindowSize = 65_536;
      expect(internal.resolveContextWindow(undefined)).toBe(65_536);
    });

    it('falls back to DEFAULT_CONTEXT_TOKENS as the last resort for OpenRouter only', () => {
      const internal = service as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'open_router';
      internal._persistedContextTokens = null;
      internal._contextWindowSize = 0;
      expect(internal.resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_TOKENS);
    });

    it('never invents a window for a local model or before the provider is known', () => {
      const internal = service as unknown as Internal;
      internal._persistedContextTokens = null;
      internal._contextWindowSize = null;
      internal._currentProvider = 'local';
      internal._activeKind = 'local';
      expect(internal.resolveContextWindow(undefined)).toBeNull();
      internal._currentProvider = null;
      internal._activeKind = null;
      expect(internal.resolveContextWindow(undefined)).toBeNull();
    });

    it("Anthropic: Claude Code's maxTokens wins over the result stream and no default exists", () => {
      const internal = service as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._persistedContextTokens = 32_768;
      internal._contextWindowSize = null;
      expect(internal.resolveContextWindow(undefined)).toBeNull();
      expect(internal.resolveContextWindow(1_000_000)).toBe(1_000_000);
      internal._contextSnapshot = { max_tokens: 200_000 };
      expect(internal.resolveContextWindow(1_000_000)).toBe(200_000);
    });
  });

  describe('context window for OpenRouter as get_llm_config reports it', () => {
    beforeEach(() => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') {
          return {
            provider: 'anthropic',
            model: null,
            base_url: null,
            context_tokens: null,
            default_base_url: null,
            active: { provider_id: 'openrouter', model: 'openai/gpt-4o-mini' },
            providers: [
              { id: 'anthropic', kind: 'anthropic_oauth', model: null, context_tokens: null },
              { id: 'local', kind: 'local', model: 'qwen3-coder-30b', context_tokens: null },
              {
                id: 'openrouter',
                kind: 'open_router',
                model: 'openai/gpt-4o-mini',
                context_tokens: null,
              },
            ],
          };
        }
        return undefined;
      };
    });

    it('gives the session stats the default window after a turn that reports none', async () => {
      await service.refreshLlmConfigCache();

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-or', usage: { input_tokens: 2_835, output_tokens: 2 } },
      });

      expect(service.sessionStats?.context_window_size).toBe(DEFAULT_CONTEXT_TOKENS);
    });

    it('keeps the window across a /model control chip', async () => {
      await service.refreshLlmConfigCache();
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-or', usage: { input_tokens: 2_835, output_tokens: 2 } },
      });

      service.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'openrouter/openai/gpt-4o', uuid: 'chip-1' },
      });

      expect(service.sessionStats?.context_window_size).toBe(DEFAULT_CONTEXT_TOKENS);
    });
  });

  describe('context meter uses the conversation model, not a subagent model', () => {
    it('reports the conversation model and its window despite a subagent-heavy usage', () => {
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-fable-5' },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.5,
          model: 'claude-fable-5',
          context_window_size: 1_000_000,
          usage: { input_tokens: 4_000, output_tokens: 300_000 },
          context_usage: {
            input_tokens: 100_000,
            output_tokens: 1_000,
            cache_read_tokens: 550_000,
            cache_write_tokens: 0,
          },
        },
      });

      expect(service.sessionStats?.context_window_size).toBe(1_000_000);
      expect(service.sessionStats?.model).toBe('claude-fable-5');
    });

    it('Anthropic: a result without a window shows no max instead of the catalog window or 200k', async () => {
      mockTauri.invokeHandler = async (cmd: string) =>
        cmd === 'get_llm_config'
          ? {
              provider: 'anthropic',
              model: null,
              base_url: null,
              default_base_url: null,
              providers: [{ id: 'anthropic', kind: 'anthropic_oauth' }],
              active: { provider_id: 'anthropic' },
            }
          : undefined;
      await service.refreshLlmConfigCache();

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-fable-5' },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.5, model: 'claude-fable-5' },
      });

      expect(service.sessionStats?.context_window_size).toBeNull();
    });
  });

  describe('context usage from get_context_usage (Anthropic)', () => {
    const SNAPSHOT_1M = {
      model: 'claude-opus-5[1m]',
      total_tokens: 46_567,
      max_tokens: 1_000_000,
      percentage: 5,
      categories: [{ name: 'System prompt', tokens: 3_902, is_deferred: false }],
    };
    const SNAPSHOT_HAIKU = {
      model: 'claude-haiku-4-5',
      total_tokens: 62_767,
      max_tokens: 200_000,
      percentage: 31,
      categories: [{ name: 'System prompt', tokens: 8_257, is_deferred: false }],
    };
    let snapshot: unknown;
    let contextCalls: number;

    function useKind(kind: string): void {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') {
          return {
            provider: kind === 'local' ? 'local' : 'anthropic',
            model: null,
            base_url: null,
            default_base_url: null,
            providers: [{ id: 'active', kind }],
            active: { provider_id: 'active' },
          };
        }
        if (cmd === 'get_context_usage') {
          contextCalls += 1;
          if (snapshot instanceof Error) throw snapshot;
          return snapshot;
        }
        return undefined;
      };
    }

    async function settle(): Promise<void> {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    }

    function sessionReady(): void {
      mockTauri.dispatchEvent('chat_session_info', {
        project: 'test',
        status: { state: 'ready', info: { models: [], account: {} } },
      });
      TestBed.tick();
    }

    beforeEach(() => {
      snapshot = SNAPSHOT_1M;
      contextCalls = 0;
      TestBed.inject(ProjectStateService).activeProject.set('test');
    });

    it('shows used and max before the first turn of a fresh session', async () => {
      useKind('anthropic_oauth');

      sessionReady();
      await settle();

      expect(service.sessionStats?.context).toEqual(SNAPSHOT_1M);
      expect(service.sessionStats?.context_window_size).toBe(1_000_000);
      expect(service.sessionStats?.session_id).toBe('');
    });

    it('also serves an API-key session: the context is not a plan limit', async () => {
      useKind('anthropic_api_key');

      sessionReady();
      await settle();

      expect(service.sessionStats?.context_window_size).toBe(1_000_000);
    });

    it('keeps the seeded window when SystemInit later brings the session id', async () => {
      useKind('anthropic_oauth');
      sessionReady();
      await settle();

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-5[1m]', session_id: 'sess-1' },
      });

      expect(service.sessionStats?.session_id).toBe('sess-1');
      expect(service.sessionStats?.context).toEqual(SNAPSHOT_1M);
      expect(service.sessionStats?.context_window_size).toBe(1_000_000);
    });

    it('re-reads the context after every completed turn and keeps it in the new stats', async () => {
      useKind('anthropic_oauth');
      await service.refreshLlmConfigCache();
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05, context_window_size: 1_000_000 },
      });
      await settle();

      expect(contextCalls).toBe(1);
      expect(service.sessionStats?.context).toEqual(SNAPSHOT_1M);
      expect(service.sessionStats?.session_id).toBe('abc');
    });

    it('after a switch from a 1M model to Haiku the window is 200k before the next turn ends', async () => {
      useKind('anthropic_oauth');
      sessionReady();
      await settle();
      expect(service.sessionStats?.context_window_size).toBe(1_000_000);

      service.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'claude-haiku-4-5' },
      });
      expect(service.sessionStats?.context_window_size).toBeNull();
      expect(service.sessionStats?.context).toBeUndefined();

      snapshot = SNAPSHOT_HAIKU;
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0 },
      });
      await settle();

      expect(service.sessionStats?.context_window_size).toBe(200_000);
      expect(service.sessionStats?.context?.total_tokens).toBe(62_767);
    });

    it('an effort chip leaves the window alone', async () => {
      useKind('anthropic_oauth');
      sessionReady();
      await settle();

      service.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'effort', argument: 'high' },
      });

      expect(service.sessionStats?.context_window_size).toBe(1_000_000);
    });

    it('with get_context_usage failing the window comes from the result, and none is shown before it', async () => {
      useKind('anthropic_oauth');
      snapshot = new Error("control request 'get_context_usage' got no response within 5000 ms");

      sessionReady();
      await settle();
      expect(service.sessionStats).toBeNull();

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0, context_window_size: 1_000_000 },
      });
      await settle();

      expect(service.sessionStats?.context_window_size).toBe(1_000_000);
      expect(service.sessionStats?.context).toBeUndefined();
    });

    it('drops a stale snapshot when a later read fails, so the result stream feeds the meter', async () => {
      useKind('anthropic_oauth');
      sessionReady();
      await settle();
      expect(service.sessionStats?.context).toEqual(SNAPSHOT_1M);

      snapshot = new Error('chat session is busy');
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0, context_window_size: 1_000_000 },
      });
      await settle();

      expect(service.sessionStats?.context).toBeUndefined();
      expect(service.sessionStats?.context_window_size).toBe(1_000_000);
    });

    it('ignores an answer that arrives after a new conversation started', async () => {
      useKind('anthropic_oauth');
      await service.refreshLlmConfigCache();
      let release!: (v: unknown) => void;
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) =>
        cmd === 'get_context_usage' ? new Promise((r) => (release = r)) : base(cmd, args);

      sessionReady();
      await settle();
      service.resetForNewConversation();
      release(SNAPSHOT_1M);
      await settle();

      expect(service.sessionStats).toBeNull();
    });

    it('a proxy-routed provider never asks Claude Code for its context', async () => {
      useKind('open_router');
      await service.refreshLlmConfigCache();

      sessionReady();
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0 },
      });
      await settle();

      expect(contextCalls).toBe(0);
      expect(service.sessionStats?.context_window_size).toBe(DEFAULT_CONTEXT_TOKENS);
    });

    it('a model chip on a routed provider keeps the window it had', async () => {
      useKind('open_router');
      await service.refreshLlmConfigCache();
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0, context_window_size: 128_000 },
      });

      service.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'openrouter/x-ai/grok-4.3' },
      });

      expect(service.sessionStats?.context_window_size).toBe(128_000);
    });
  });

  describe('mapContextOverflowError', () => {
    it('maps llama.cpp context-overflow to a friendly message; passes others through', () => {
      expect(mapContextOverflowError('exceeds the available context size (8192 tokens)')).toContain(
        'larger than the selected model'
      );
      expect(mapContextOverflowError('some unrelated error')).toBeNull();
    });

    it('maps "context length exceeded" variant', () => {
      expect(mapContextOverflowError('context length exceeded')).toContain(
        'larger than the selected model'
      );
    });

    it('is case-insensitive', () => {
      expect(
        mapContextOverflowError('Exceeds The Available Context Size (8192 tokens)')
      ).not.toBeNull();
      expect(mapContextOverflowError('Context Length Exceeded')).not.toBeNull();
    });

    it('returns null for unknown errors', () => {
      expect(mapContextOverflowError('')).toBeNull();
      expect(mapContextOverflowError('out of memory')).toBeNull();
    });
  });

  describe('mapNotLoggedInError', () => {
    it('maps Claude Code\'s "not logged in" error to a Settings-pointing message', () => {
      expect(mapNotLoggedInError('Not logged in · Please run /login')).toContain('Settings');
      expect(mapNotLoggedInError('some unrelated error')).toBeNull();
    });

    it('matches "not authenticated" wording variants', () => {
      expect(mapNotLoggedInError('Not authenticated')).not.toBeNull();
    });

    it('is case-insensitive', () => {
      expect(mapNotLoggedInError('NOT LOGGED IN')).not.toBeNull();
    });

    it('returns null for unknown errors', () => {
      expect(mapNotLoggedInError('')).toBeNull();
      expect(mapNotLoggedInError('rate limit exceeded')).toBeNull();
    });
  });

  describe('isNotAuthenticatedError', () => {
    it('matches the backend "not authenticated" phrasings', () => {
      expect(
        isNotAuthenticatedError('Claude is not authenticated. Please authenticate first.')
      ).toBe(true);
      expect(isNotAuthenticatedError('not authenticated')).toBe(true);
    });

    it('is case-sensitive (exact backend phrasing) and rejects unrelated errors', () => {
      expect(isNotAuthenticatedError('NOT AUTHENTICATED')).toBe(false);
      expect(isNotAuthenticatedError('Broken pipe (os error 32)')).toBe(false);
      expect(isNotAuthenticatedError('')).toBe(false);
    });
  });

  describe('handleStreamChunk Error — context-overflow mapping', () => {
    it('replaces a known context-overflow error with the friendly message', () => {
      service.isStreaming = true;

      service.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'exceeds the available context size (8192 tokens)' },
      });

      const errBlock = service.messages[service.messages.length - 1]?.blocks.find(
        (b) => b.type === 'error'
      );
      expect(errBlock).toBeDefined();
      if (errBlock?.type === 'error') {
        expect(errBlock.content).toContain('larger than the selected model');
      }
    });

    it('keeps unknown errors verbatim', () => {
      service.isStreaming = true;

      service.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'some unrelated error' },
      });

      const errBlock = service.messages[service.messages.length - 1]?.blocks.find(
        (b) => b.type === 'error'
      );
      expect(errBlock).toBeDefined();
      if (errBlock?.type === 'error') {
        expect(errBlock.content).toBe('some unrelated error');
      }
    });
  });

  describe('handleStreamChunk Error — not-logged-in mapping', () => {
    it('replaces Claude Code\'s "not logged in" error with a Settings-pointing message', () => {
      service.isStreaming = true;

      service.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'Not logged in · Please run /login' },
      });

      const errBlock = service.messages[service.messages.length - 1]?.blocks.find(
        (b) => b.type === 'error'
      );
      expect(errBlock).toBeDefined();
      if (errBlock?.type === 'error') {
        expect(errBlock.content).toContain('Settings');
      }
    });
  });

  describe('handleStreamChunk Error — Claude Code watchdog interruption kind', () => {
    it('tags a known watchdog text with its ErrorBlockKind', () => {
      service.isStreaming = true;

      service.handleStreamChunk({
        chunk_type: 'Error',
        data: {
          content: 'API Error: Server error mid-response. The response above may be incomplete.',
        },
      });

      const errBlock = service.messages[service.messages.length - 1]?.blocks.find(
        (b) => b.type === 'error'
      );
      expect(errBlock).toStrictEqual({
        type: 'error',
        content: 'API Error: Server error mid-response. The response above may be incomplete.',
        kind: 'api_server_interrupted',
      });
    });

    it('tags each remaining known watchdog text with the right kind', () => {
      const cases: Array<[string, string]> = [
        [
          'API Error: Connection closed mid-response. The response above may be incomplete.',
          'connection_interrupted',
        ],
        [
          'API Error: Connection lost mid-response. The response above may be incomplete.',
          'connection_interrupted',
        ],
        [
          'API Error: The response stopped arriving. The response above may be incomplete.',
          'response_stalled',
        ],
        [
          'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
          'host_slept',
        ],
      ];

      for (const [content, kind] of cases) {
        service.handleStreamChunk({ chunk_type: 'Error', data: { content } });
        const errBlock = service.messages[service.messages.length - 1]?.blocks.find(
          (b) => b.type === 'error'
        );
        expect(errBlock).toStrictEqual({ type: 'error', content, kind });
      }
    });

    it('an unrelated error text produces a block with no kind property at all', () => {
      service.isStreaming = true;

      service.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'some unrelated error' },
      });

      const errBlock = service.messages[service.messages.length - 1]?.blocks.find(
        (b) => b.type === 'error'
      );
      expect(errBlock).toStrictEqual({ type: 'error', content: 'some unrelated error' });
    });
  });

  describe('resume on restart', () => {
    type RestartInternal = {
      notifyRestartBegin(): Promise<void>;
      notifyReady(): void;
    };
    type TokensInternal = {
      _lastContextTokens: number | null;
      _persistedContextTokens: number | null;
    };

    async function fireRestart(projectState: ProjectStateService): Promise<void> {
      await (projectState as unknown as RestartInternal).notifyRestartBegin();
      projectState.notifyRestartComplete();
      await new Promise((r) => setTimeout(r, 0));
    }

    let projectState: ProjectStateService;

    beforeEach(async () => {
      projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
    });

    it('resumes the durable session with NO ChatComponent mounted (key regression)', async () => {
      service.seedSessionId('sess-1');
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_conversation') {
          return {
            session_id: 'sess-1',
            messages: [{ role: 'user', blocks: [{ type: 'text', content: 'restored' }] }],
          };
        }
        return undefined;
      };

      await fireRestart(projectState);

      expect(calls).toContain('resume_conversation');
      expect(service.messagesFromState()[0]?.blocks[0]).toEqual({
        type: 'text',
        content: 'restored',
      });
    });

    it('seeds the ctx meter from the transcript last per-call usage on resume', async () => {
      service.seedSessionId('sess-seed');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') {
          return {
            session_id: 'sess-seed',
            messages: [
              { role: 'user', content: 'q' },
              {
                role: 'assistant',
                content: 'a1',
                usage: {
                  input_tokens: 5,
                  output_tokens: 9,
                  cache_read_tokens: 30_000,
                  cache_write_tokens: 100,
                },
              },
              {
                role: 'assistant',
                content: 'a2',
                usage: {
                  input_tokens: 2,
                  output_tokens: 1660,
                  cache_read_tokens: 66_844,
                  cache_write_tokens: 4920,
                },
              },
              { role: 'assistant', content: 'subagent output' },
            ],
          };
        }
        return undefined;
      };

      await fireRestart(projectState);

      expect(service.sessionStats?.context_usage?.cache_read_tokens).toBe(66_844);
      expect(service.lastContextTokens).toBe(71_766);
    });

    it('skips a trailing all-zero usage (aborted/errored call) and seeds from the prior real call', async () => {
      service.seedSessionId('sess-seed-zero');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') {
          return {
            session_id: 'sess-seed-zero',
            messages: [
              { role: 'user', content: 'q' },
              {
                role: 'assistant',
                content: 'a1',
                usage: {
                  input_tokens: 5,
                  output_tokens: 9,
                  cache_read_tokens: 30_000,
                  cache_write_tokens: 100,
                },
              },
              {
                role: 'assistant',
                content: 'a2',
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_read_tokens: 0,
                  cache_write_tokens: 0,
                },
              },
            ],
          };
        }
        return undefined;
      };

      await fireRestart(projectState);

      expect(service.sessionStats?.context_usage?.cache_read_tokens).toBe(30_000);
      expect(service.lastContextTokens).toBe(30_105);
    });

    it('does not seed context when every assistant usage in the transcript is all-zero', async () => {
      service.seedSessionId('sess-seed-all-zero');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') {
          return {
            session_id: 'sess-seed-all-zero',
            messages: [
              { role: 'user', content: 'q' },
              {
                role: 'assistant',
                content: 'a1',
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_read_tokens: 0,
                  cache_write_tokens: 0,
                },
              },
            ],
          };
        }
        return undefined;
      };

      await fireRestart(projectState);

      expect(service.sessionStats?.context_usage).toBeUndefined();
      expect(service.lastContextTokens).toBeNull();
    });

    it('auto-resumes when unmounted even if history does not fit the target window', async () => {
      service.seedSessionId('sess-2');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      (service as unknown as TokensInternal)._persistedContextTokens = 8192;
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_conversation') return { session_id: 'sess-2', messages: [] };
        return undefined;
      };

      await fireRestart(projectState);

      expect(calls).toContain('resume_conversation');
    });

    it('starts a fresh session (not resume) when a decider returns "fresh" and history does not fit', async () => {
      projectState.status.set('ready');
      service.seedSessionId('sess-3');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      (service as unknown as TokensInternal)._persistedContextTokens = 8192;
      service.setResumeDecider(() => Promise.resolve('fresh'));
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };

      await fireRestart(projectState);

      expect(calls).not.toContain('resume_conversation');
      expect(calls).toContain('start_chat');
      expect(service.lastKnownSessionId).toBeNull();
    });

    it('resumes when the decider returns "resume" and history does not fit', async () => {
      service.seedSessionId('sess-4');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      (service as unknown as TokensInternal)._persistedContextTokens = 8192;
      service.setResumeDecider(() => Promise.resolve('resume'));
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_conversation') return { session_id: 'sess-4', messages: [] };
        return undefined;
      };

      await fireRestart(projectState);

      expect(calls).toContain('resume_conversation');
    });

    it('drops a decider answer once the chat moved to another session while the dialog was open', async () => {
      service.seedSessionId('sess-asked');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      (service as unknown as TokensInternal)._persistedContextTokens = 8192;
      const answer = createDeferred<'resume' | 'fresh'>();
      service.setResumeDecider(() => answer.promise);
      const resumed: unknown[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'resume_conversation') resumed.push(args?.['sessionId']);
        return undefined;
      };

      await fireRestart(projectState);
      await service.resumeConversation('sess-chosen');
      answer.resolve('resume');
      await new Promise((r) => setTimeout(r, 0));

      expect(resumed).toEqual(['sess-chosen']);
      expect(service.lastKnownSessionId).toBe('sess-chosen');
    });

    it('re-reads the llm config so a GROWN post-restart window auto-resumes without asking', async () => {
      service.seedSessionId('sess-window');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      (service as unknown as TokensInternal)._persistedContextTokens = 8192;
      const decider = vi.fn(() => Promise.resolve('fresh' as const));
      service.setResumeDecider(decider);
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_llm_config') return { provider: 'anthropic', context_tokens: 200_000 };
        if (cmd === 'get_conversation') return { session_id: 'sess-window', messages: [] };
        return undefined;
      };

      await fireRestart(projectState);

      expect(decider).not.toHaveBeenCalled();
      expect(calls).toContain('resume_conversation');
    });

    it('re-reads the llm config so a SHRUNK post-restart window asks instead of blind-resuming', async () => {
      service.seedSessionId('sess-shrunk');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      (service as unknown as TokensInternal)._persistedContextTokens = 200_000;
      const decider = vi.fn(() => Promise.resolve('resume' as const));
      service.setResumeDecider(decider);
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_llm_config') return { provider: 'local', context_tokens: 8192 };
        if (cmd === 'get_conversation') return { session_id: 'sess-shrunk', messages: [] };
        return undefined;
      };

      await fireRestart(projectState);

      expect(decider).toHaveBeenCalledTimes(1);
      expect(calls).toContain('resume_conversation');
    });

    it('resumes without asking when the target model has no known context window', async () => {
      service.seedSessionId('sess-unknown-window');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      (service as unknown as TokensInternal)._persistedContextTokens = 200_000;
      const decider = vi.fn(() => Promise.resolve('fresh' as const));
      service.setResumeDecider(decider);
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_llm_config') return { provider: 'local', context_tokens: null };
        if (cmd === 'get_conversation') return { session_id: 'sess-unknown-window', messages: [] };
        return undefined;
      };

      await fireRestart(projectState);

      expect(decider).not.toHaveBeenCalled();
      expect(calls).toContain('resume_conversation');
      expect(calls).not.toContain('start_chat');
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[chat-state] restart resume decision: history_tokens=25229 window_tokens=unknown fits=true decider=true'
      );
    });

    it('logs the restart resume decision when a known window is too small and the decider is asked', async () => {
      service.seedSessionId('sess-log-ask');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      (service as unknown as TokensInternal)._persistedContextTokens = 8192;
      service.setResumeDecider(() => Promise.resolve('resume'));
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') return { session_id: 'sess-log-ask', messages: [] };
        return undefined;
      };

      await fireRestart(projectState);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[chat-state] restart resume decision: history_tokens=25229 window_tokens=8192 fits=false decider=true'
      );
    });

    it('does nothing on restart when no durable session id is known', async () => {
      service.clearSessionTracking();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };

      await fireRestart(projectState);

      expect(calls).not.toContain('resume_conversation');
    });

    it('does not resume on a bare ready (project switch, no restart-complete)', async () => {
      service.seedSessionId('sess-5');
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };

      (projectState as unknown as RestartInternal).notifyReady();
      await new Promise((r) => setTimeout(r, 0));

      expect(calls).not.toContain('resume_conversation');
    });

    it('clears the durable id on a project switch (switching) so it cannot resume later', async () => {
      service.seedSessionId('sess-6');
      expect(service.lastKnownSessionId).toBe('sess-6');

      mockTauri.dispatchEvent('project_switch_started', { project: 'other-project' });
      await new Promise((r) => setTimeout(r, 10));

      expect(service.lastKnownSessionId).toBeNull();
    });

    it('interrupts a streaming turn on restart-begin', async () => {
      const stopSpy = vi.spyOn(service, 'stopConversation').mockResolvedValue();
      service.isStreaming = true;
      await (projectState as unknown as RestartInternal).notifyRestartBegin();
      expect(stopSpy).toHaveBeenCalled();
    });

    it('does not interrupt on restart-begin when not streaming', async () => {
      const stopSpy = vi.spyOn(service, 'stopConversation').mockResolvedValue();
      service.isStreaming = false;
      await (projectState as unknown as RestartInternal).notifyRestartBegin();
      expect(stopSpy).not.toHaveBeenCalled();
    });

    it('adopts a changed session_id from a post-resume Result (fork guard)', () => {
      service.seedSessionId('old');
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'new', total_cost: 0 },
      });
      expect(service.lastKnownSessionId).toBe('new');
    });

    it('a remount init() mid-resume does not start a competing start_chat', async () => {
      projectState.status.set('ready');
      service.seedSessionId('sess-mid');
      const pendingResume = createDeferred();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_conversation') {
          return {
            session_id: 'sess-mid',
            messages: [{ role: 'user', blocks: [{ type: 'text', content: 'restored' }] }],
          };
        }
        if (cmd === 'resume_conversation') await pendingResume.promise;
        return undefined;
      };

      const restartDone = fireRestart(projectState);
      await vi.waitFor(() => {
        expect(calls).toContain('resume_conversation');
      });
      await service.init();
      pendingResume.resolve();
      await restartDone;

      await vi.waitFor(() => {
        expect(service.messagesFromState()[0]?.blocks[0]).toEqual({
          type: 'text',
          content: 'restored',
        });
      });
      expect(calls).not.toContain('start_chat');
    });

    it('a remount init() just after resume completes still does not start_chat', async () => {
      projectState.status.set('ready');
      service.seedSessionId('sess-done');
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_conversation') return { session_id: 'sess-done', messages: [] };
        return undefined;
      };

      await fireRestart(projectState);
      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(calls).not.toContain('start_chat');
      expect(service.lastKnownSessionId).toBe('sess-done');
    });

    it('newConversation reset then init() still starts a fresh session', async () => {
      projectState.status.set('ready');
      service.resetForNewConversation();
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };

      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(calls).toContain('start_chat');
    });
  });

  describe('resumeConversation transcript failure', () => {
    it('keeps the session live and shows a notice when get_conversation fails but resume succeeds', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_conversation') throw new Error('jsonl unreadable');
        return undefined;
      };

      await service.resumeConversation('sess-notice');

      expect(calls).toContain('resume_conversation');
      expect(service.lastKnownSessionId).toBe('sess-notice');
      expect(service.sessionStats?.session_id).toBe('sess-notice');
      expect(service.isStreaming).toBe(false);
      const blocks = service.messages.flatMap((m) => m.blocks);
      const notice = blocks.find((b) => b.type === 'error');
      expect(notice).toBeDefined();
      expect((notice as { type: 'error'; content: string }).content).toContain('history');
      expect(service.loadingTranscriptFromState()).toBe(false);
    });

    it('shows no notice when the transcript loads successfully', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_conversation') {
          return {
            session_id: 'sess-ok',
            messages: [
              {
                role: 'user',
                content: 'hi',
                timestamp: null,
                blocks: [{ type: 'text', content: 'hi' }],
              },
            ],
          };
        }
        return undefined;
      };

      await service.resumeConversation('sess-ok');

      const blocks = service.messages.flatMap((m) => m.blocks);
      expect(blocks.some((b) => b.type === 'error')).toBe(false);
      expect(service.sessionStats?.session_id).toBe('sess-ok');
    });
  });

  describe('historyFitsTarget', () => {
    it('fits below the window and does not fit at or above it', () => {
      expect(historyFitsTarget(8000, 131072)).toBe(true);
      expect(historyFitsTarget(25229, 8192)).toBe(false);
      expect(historyFitsTarget(8192, 8192)).toBe(false);
      expect(historyFitsTarget(8191, 8192)).toBe(true);
    });

    it('treats an unknown history or an unknown window as fitting', () => {
      expect(historyFitsTarget(null, 8192)).toBe(true);
      expect(historyFitsTarget(25229, null)).toBe(true);
      expect(historyFitsTarget(null, null)).toBe(true);
      expect(historyFitsTarget(0, null)).toBe(true);
    });
  });

  describe('toChatMessages per-message meta', () => {
    it('maps model + usage into ChatMessage.meta', () => {
      const transcript: ConversationTranscript = {
        session_id: '00000000-0000-0000-0000-000000000000',
        messages: [
          {
            role: 'assistant',
            content: 'hi',
            timestamp: '2025-01-01T00:00:00Z',
            blocks: [{ type: 'text', content: 'hi' }],
            model: 'haiku-4.5',
            usage: {
              input_tokens: 9430,
              output_tokens: 120,
              cache_read_tokens: 42703,
              cache_write_tokens: 0,
            },
          },
        ],
      };
      const [msg] = toChatMessages(transcript);
      expect(msg.meta?.model).toBe('haiku-4.5');
      expect(msg.meta?.usage).toEqual({
        input_tokens: 9430,
        output_tokens: 120,
        cache_read_tokens: 42703,
        cache_write_tokens: 0,
      });
    });

    it('maps model alone when usage absent', () => {
      const transcript: ConversationTranscript = {
        session_id: '00000000-0000-0000-0000-000000000000',
        messages: [
          {
            role: 'assistant',
            content: 'hi',
            timestamp: '2025-01-01T00:00:00Z',
            blocks: [{ type: 'text', content: 'hi' }],
            model: 'claude-opus-4-8',
          },
        ],
      };
      const [msg] = toChatMessages(transcript);
      expect(msg.meta?.model).toBe('claude-opus-4-8');
      expect(msg.meta?.usage).toBeUndefined();
    });

    it('leaves meta undefined when neither model nor usage present', () => {
      const transcript: ConversationTranscript = {
        session_id: '00000000-0000-0000-0000-000000000000',
        messages: [
          {
            role: 'user',
            content: 'hello',
            timestamp: '2025-01-01T00:00:00Z',
            blocks: [{ type: 'text', content: 'hello' }],
          },
        ],
      };
      const [msg] = toChatMessages(transcript);
      expect(msg.meta).toBeUndefined();
    });
  });

  describe('toChatMessages history tool-block normalization', () => {
    function transcriptWith(blocks: unknown[]): ConversationTranscript {
      return {
        session_id: '00000000-0000-0000-0000-000000000000',
        messages: [
          {
            role: 'assistant',
            content: '',
            timestamp: '2025-01-01T00:00:00Z',
            blocks: blocks as ConversationTranscript['messages'][number]['blocks'],
          },
        ],
      };
    }

    it('nests a flat history tool_use into the live-chat shape (done, empty result)', () => {
      const [msg] = toChatMessages(
        transcriptWith([{ type: 'tool_use', tool_name: 'Bash', input_json: '{"command":"ls"}' }])
      );
      expect(msg.blocks).toEqual([
        {
          type: 'tool_use',
          tool: {
            type: 'tool_use',
            tool_id: '',
            tool_name: 'Bash',
            input_json: '{"command":"ls"}',
            status: 'done',
            result: '',
            result_is_error: false,
          },
        },
      ]);
    });

    it('merges a tool_result into the preceding tool_use', () => {
      const [msg] = toChatMessages(
        transcriptWith([
          { type: 'tool_use', tool_name: 'Read', input_json: '{"file_path":"/a.ts"}' },
          { type: 'tool_result', content: 'file contents', is_error: false },
        ])
      );
      expect(msg.blocks).toHaveLength(1);
      const block = msg.blocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use') {
        expect(block.tool.status).toBe('done');
        if (block.tool.status === 'done') {
          expect(block.tool.result).toBe('file contents');
          expect(block.tool.result_is_error).toBe(false);
        }
      }
    });

    it('marks the merged tool errored when tool_result.is_error is true', () => {
      const [msg] = toChatMessages(
        transcriptWith([
          { type: 'tool_use', tool_name: 'Bash', input_json: '{"command":"boom"}' },
          { type: 'tool_result', content: 'command not found', is_error: true },
        ])
      );
      const block = msg.blocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use') {
        expect(block.tool.status).toBe('error');
        if (block.tool.status === 'error') {
          expect(block.tool.result).toBe('command not found');
          expect(block.tool.result_is_error).toBe(true);
        }
      }
    });

    it('drops an orphan tool_result with no preceding tool_use', () => {
      const [msg] = toChatMessages(
        transcriptWith([
          { type: 'tool_result', content: 'orphan', is_error: false },
          { type: 'text', content: 'after' },
        ])
      );
      expect(msg.blocks).toEqual([{ type: 'text', content: 'after' }]);
    });

    it('does not merge a tool_result into a non-tool block', () => {
      const [msg] = toChatMessages(
        transcriptWith([
          { type: 'text', content: 'prose' },
          { type: 'tool_result', content: 'dangling', is_error: false },
        ])
      );
      expect(msg.blocks).toEqual([{ type: 'text', content: 'prose' }]);
    });

    it('passes an already-nested tool_use through unchanged', () => {
      const nested = {
        type: 'tool_use',
        tool: {
          type: 'tool_use',
          tool_id: 't-live',
          tool_name: 'Glob',
          input_json: '{"pattern":"*.ts"}',
          status: 'done',
          result: 'a.ts',
          result_is_error: false,
        },
      };
      const [msg] = toChatMessages(transcriptWith([nested]));
      expect(msg.blocks).toEqual([nested]);
    });

    it('normalizes a history control_chip block into the live-path chip view-model', () => {
      const [msg] = toChatMessages(
        transcriptWith([{ type: 'control_chip', command: 'model', argument: 'claude-sonnet-5' }])
      );
      expect(msg.blocks).toEqual([{ type: 'chip', command: 'model', argument: 'claude-sonnet-5' }]);
    });
  });

  describe('applyModelSelection', () => {
    it('awaits setProviderModel BEFORE sending the wire command for a live non-anthropic selection', async () => {
      const service = TestBed.inject(ChatStateService);
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const calls: string[] = [];
      let resolveSet!: () => void;
      vi.spyOn(anthropicModels, 'setProviderModel').mockImplementation(
        () =>
          new Promise<void>((r) => {
            calls.push('setProviderModel-start');
            resolveSet = () => {
              calls.push('setProviderModel-resolved');
              r();
            };
          })
      );
      vi.spyOn(service, 'sendMessage').mockImplementation(async () => {
        calls.push('sendMessage');
      });
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'my-or/anthropic/claude-sonnet-5', session_id: 'sess-1' },
      });

      const pending = service.applyModelSelection({
        catalogId: 'anthropic/claude-haiku-4-5',
        wireId: 'my-or/anthropic/claude-haiku-4-5',
        providerId: 'my-or',
        kind: 'open_router',
        isDefault: false,
      });
      expect(calls).toEqual(['setProviderModel-start']);
      resolveSet();
      await pending;
      expect(calls).toEqual(['setProviderModel-start', 'setProviderModel-resolved', 'sendMessage']);
      expect(invokeSpy).not.toHaveBeenCalledWith('set_model_pin', expect.anything());
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
    });

    it('does not send the wire command when setProviderModel rejects', async () => {
      const service = TestBed.inject(ChatStateService);
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      vi.spyOn(anthropicModels, 'setProviderModel').mockRejectedValue(new Error('locked config'));
      const sendMessageSpy = vi.spyOn(service, 'sendMessage').mockResolvedValue(undefined);

      await service.applyModelSelection({
        catalogId: 'anthropic/claude-haiku-4-5',
        wireId: 'my-or/anthropic/claude-haiku-4-5',
        providerId: 'my-or',
        kind: 'open_router',
        isDefault: false,
      });

      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(service.modelSelectionError()).toContain('locked config');
    });

    it('persists the model pin BEFORE sending the wire command for a live anthropic selection', async () => {
      const service = TestBed.inject(ChatStateService);
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      const setProviderModelSpy = vi.spyOn(anthropicModels, 'setProviderModel');
      const calls: string[] = [];
      let resolvePin!: () => void;
      vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        if (cmd === 'set_model_pin') {
          return new Promise((r) => {
            calls.push('set_model_pin-start');
            resolvePin = () => {
              calls.push('set_model_pin-resolved');
              r(undefined);
            };
          });
        }
        return undefined;
      });
      vi.spyOn(service, 'sendMessage').mockImplementation(async () => {
        calls.push('sendMessage');
      });
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-2' },
      });

      const pending = service.applyModelSelection({
        catalogId: 'claude-opus-4-8',
        wireId: 'claude-opus-4-8',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      expect(calls).toEqual(['set_model_pin-start']);
      resolvePin();
      await pending;
      expect(calls).toEqual(['set_model_pin-start', 'set_model_pin-resolved', 'sendMessage']);
      expect(setProviderModelSpy).not.toHaveBeenCalled();
    });

    it('blocks the wire and surfaces an error when the model pin write fails on a live session', async () => {
      const service = TestBed.inject(ChatStateService);
      const sendMessageSpy = vi.spyOn(service, 'sendMessage').mockResolvedValue(undefined);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_model_pin') throw new Error('unknown Anthropic model');
        return undefined;
      };
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-3' },
      });

      await service.applyModelSelection({
        catalogId: 'claude-opus-4-8',
        wireId: 'claude-opus-4-8',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });

      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(service.modelSelectionError()).toContain('unknown Anthropic model');
    });

    it('persists the model pin and sends nothing further when no session or project is active', async () => {
      const service = TestBed.inject(ChatStateService);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const sendMessageSpy = vi.spyOn(service, 'sendMessage').mockResolvedValue(undefined);

      await service.applyModelSelection({
        catalogId: 'claude-opus-4-8',
        wireId: 'claude-opus-4-8',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });

      expect(invokeSpy).toHaveBeenCalledWith('set_model_pin', {
        projectId: '',
        model: 'claude-opus-4-8',
      });
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('an idle pre-first-turn anthropic pick persists the pin and respawns with no model argument at all', async () => {
      const service = TestBed.inject(ChatStateService);
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      await new Promise((r) => setTimeout(r, 0));

      const pinCallIndex = invokeSpy.mock.calls.findIndex(([cmd]) => cmd === 'set_model_pin');
      const startCalls = invokeSpy.mock.calls
        .map((call, i) => ({ cmd: call[0], args: call[1], i }))
        .filter(({ cmd }) => cmd === 'start_chat');
      expect(pinCallIndex).toBeGreaterThanOrEqual(0);
      expect(invokeSpy.mock.calls[pinCallIndex][1]).toEqual({
        projectId: 'test',
        model: 'claude-sonnet-5',
      });
      expect(startCalls.at(-1)?.i).toBeGreaterThan(pinCallIndex);
      expect(startCalls.at(-1)?.args).toEqual({ project: 'test' });
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('a still-session-less streaming pick persists the pin without respawning or queuing', async () => {
      const service = TestBed.inject(ChatStateService);
      TestBed.inject(ProjectStateService).activeProject.set('test');
      service.isStreaming = true;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });

      expect(invokeSpy).toHaveBeenCalledWith('set_model_pin', {
        projectId: 'test',
        model: 'claude-sonnet-5',
      });
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('blocks the respawn and surfaces an error when the model pin write fails with no live session', async () => {
      const service = TestBed.inject(ChatStateService);
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_model_pin') throw new Error('locked settings.json');
        return undefined;
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });

      expect(service.modelSelectionError()).toContain('locked settings.json');
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
    });

    it('a mid-stream pick on a live session persists the pin immediately and wires it after the turn ends', async () => {
      const service = TestBed.inject(ChatStateService);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();
      service.isStreaming = true;

      await service.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
      });
      expect(invokeSpy).toHaveBeenCalledWith('set_model_pin', {
        projectId: expect.any(String),
        model: 'claude-haiku-4-5',
      });
      let modelSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSend).toBeUndefined();
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-live' },
      } as never);
      await vi.waitFor(() => {
        modelSend = invokeSpy.mock.calls.find(
          ([cmd, args]) =>
            cmd === 'send_message' && JSON.stringify(args).includes('/model claude-haiku-4-5')
        );
        expect(modelSend).toBeDefined();
      });
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('a no-session routed pick re-renders the compose and respawns, so the next turn runs on it', async () => {
      const service = TestBed.inject(ChatStateService);
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      const sendMessageSpy = vi.spyOn(service, 'sendMessage').mockResolvedValue(undefined);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy).toHaveBeenCalledWith('set_provider_model', {
        projectId: 'test',
        providerId: 'my-ollama',
        model: 'llama4',
      });
      const commands = invokeSpy.mock.calls.map(([cmd]) => cmd);
      const writeIdx = commands.indexOf('set_provider_model');
      const restartIdx = commands.indexOf('restart_integration_containers');
      expect(restartIdx).toBeGreaterThan(writeIdx);
      expect(commands.lastIndexOf('start_chat')).toBeGreaterThan(restartIdx);
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(service.modelSelectionError()).toBe('');
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('surfaces a failed re-render for a routed pick and leaves the session unspawned', async () => {
      const service = TestBed.inject(ChatStateService);
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') throw new Error('compose render failed');
        return undefined;
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(service.modelSelectionError()).toContain('compose render failed');
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(projectState.needsRestart).toBe(true);
    });

    it('tells the user to pick again when a restart is already running', async () => {
      const service = TestBed.inject(ChatStateService);
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      projectState.restarting = true;
      projectState.restartError = 'a failure from an older restart';
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy).toHaveBeenCalledWith('set_provider_model', {
        projectId: 'test',
        providerId: 'my-ollama',
        model: 'llama4',
      });
      expect(service.modelSelectionError()).toBe(MODEL_SWITCH_NOT_APPLIED);
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(projectState.needsRestart).toBe(false);
    });

    it('keeps a routed pick without an active project from respawning on an unchanged compose', async () => {
      const service = TestBed.inject(ChatStateService);
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      projectState.activeProject.set(null);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(service.modelSelectionError()).toBe(MODEL_SWITCH_NOT_APPLIED);
    });

    it('a mid-stream routed pick on a live session queues the wire switch and leaves containers alone', async () => {
      const service = TestBed.inject(ChatStateService);
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      vi.spyOn(anthropicModels, 'setProviderModel').mockResolvedValue(undefined);
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'my-or/anthropic/claude-sonnet-5', session_id: 'sess-routed' },
      });
      await Promise.resolve();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.isStreaming = true;

      await service.applyModelSelection({
        catalogId: 'anthropic/claude-haiku-4-5',
        wireId: 'my-or/anthropic/claude-haiku-4-5',
        providerId: 'my-or',
        kind: 'open_router',
        isDefault: false,
      });

      expect(service.pendingModelOverride()).toBe('my-or/anthropic/claude-haiku-4-5');
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
    });

    it('a still-session-less streaming routed pick writes through and leaves the running turn alone', async () => {
      const service = TestBed.inject(ChatStateService);
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      service.isStreaming = true;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await service.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
      });

      expect(invokeSpy).toHaveBeenCalledWith('set_provider_model', {
        projectId: 'proj',
        providerId: 'my-ollama',
        model: 'llama4',
      });
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(service.pendingModelOverride()).toBeNull();
    });

    describe('when the chat is claimed while the routed re-render runs', () => {
      let calls: string[];
      let pendingRestart: Deferred;

      const routedPick = {
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local' as const,
        isDefault: false,
      };

      beforeEach(async () => {
        const projectState = TestBed.inject(ProjectStateService);
        await projectState.init();
        projectState.activeProject.set('test');
        await service.init();
        await new Promise((r) => setTimeout(r, 0));
        calls = [];
        pendingRestart = createDeferred();
        mockTauri.invokeHandler = (cmd: string) => {
          calls.push(cmd);
          if (cmd === 'restart_integration_containers') return pendingRestart.promise;
          return Promise.resolve(undefined);
        };
      });

      function callsAfterRestart(): string[] {
        return calls.slice(calls.indexOf('restart_integration_containers') + 1);
      }

      it('a conversation resumed meanwhile keeps the chat: no fresh respawn replaces it', async () => {
        const pick = service.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));

        const resume = service.resumeConversation('sess-resumed');
        pendingRestart.resolve();
        await pick;
        await resume;
        await new Promise((r) => setTimeout(r, 0));

        expect(callsAfterRestart()).toContain('resume_conversation');
        expect(callsAfterRestart()).not.toContain('start_chat');
        expect(service.lastKnownSessionId).toBe('sess-resumed');
      });

      it('a turn sent meanwhile keeps its messages: the respawn does not reset them', async () => {
        const pick = service.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));

        void service.sendMessage('what number did I give you?');
        await vi.waitFor(() => expect(calls).toContain('send_message'));
        pendingRestart.resolve();
        await pick;
        await new Promise((r) => setTimeout(r, 0));

        expect(service.isStreaming).toBe(true);
        expect(service.messages.map((m) => m.role)).toEqual(['user']);
        expect(callsAfterRestart()).not.toContain('start_chat');
      });
    });
  });

  describe('resumeConversation while a container restart runs', () => {
    let projectState: ProjectStateService;
    let calls: Array<{ cmd: string; sessionId?: unknown }>;
    let pendingRestart: Deferred;

    beforeEach(async () => {
      projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      calls = [];
      pendingRestart = createDeferred();
      mockTauri.invokeHandler = (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, sessionId: args?.['sessionId'] });
        if (cmd === 'restart_integration_containers') return pendingRestart.promise;
        return Promise.resolve(undefined);
      };
    });

    function commands(): string[] {
      return calls.map((c) => c.cmd);
    }

    function resumedSessions(): unknown[] {
      return calls.filter((c) => c.cmd === 'resume_conversation').map((c) => c.sessionId);
    }

    it('claims the chat at once and replaces the session only after the restart ends', async () => {
      const restart = projectState.restartContainers();
      const resume = service.resumeConversation('sess-picked');
      await new Promise((r) => setTimeout(r, 0));

      expect(commands()).toContain('restart_integration_containers');
      expect(commands()).not.toContain('resume_conversation');
      expect(commands()).not.toContain('get_conversation');
      expect(service.newConversationBlockedReason()).toBe(NEW_CONVERSATION_BUSY);

      pendingRestart.resolve();
      await restart;
      await resume;

      expect(commands().indexOf('resume_conversation')).toBeGreaterThan(
        commands().indexOf('restart_integration_containers')
      );
      expect(service.lastKnownSessionId).toBe('sess-picked');
    });

    it('the restart-complete resume of the prior session yields to the one resumed meanwhile', async () => {
      service.seedSessionId('sess-live');

      const restart = projectState.restartContainers();
      const resume = service.resumeConversation('sess-picked');
      pendingRestart.resolve();
      await restart;
      await resume;
      await new Promise((r) => setTimeout(r, 0));

      expect(resumedSessions()).toEqual(['sess-picked']);
      expect(service.lastKnownSessionId).toBe('sess-picked');
    });

    it('still resumes after the restart fails', async () => {
      const restart = projectState.restartContainers();
      const resume = service.resumeConversation('sess-picked');
      pendingRestart.reject(new Error('compose failed'));

      await expect(restart).resolves.toBe('failed');
      await resume;

      expect(resumedSessions()).toEqual(['sess-picked']);
      expect(service.lastKnownSessionId).toBe('sess-picked');
    });

    it('also waits out a restart that starts while it waits', async () => {
      const second = createDeferred();
      const restarts = [pendingRestart, second];
      mockTauri.invokeHandler = (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, sessionId: args?.['sessionId'] });
        const next = cmd === 'restart_integration_containers' ? restarts.shift() : undefined;
        return next ? next.promise : Promise.resolve(undefined);
      };
      let chained = false;
      projectState.onRestartComplete(() => {
        if (chained) return;
        chained = true;
        void projectState.restartContainers();
      });

      const first = projectState.restartContainers();
      const resume = service.resumeConversation('sess-picked');
      pendingRestart.resolve();
      await first;
      await new Promise((r) => setTimeout(r, 0));

      expect(commands().filter((c) => c === 'restart_integration_containers')).toHaveLength(2);
      expect(resumedSessions()).toEqual([]);

      second.resolve();
      await resume;

      expect(resumedSessions()).toEqual(['sess-picked']);
    });

    it('drops the resume when a project switch starts before the restart ends', async () => {
      const restart = projectState.restartContainers();
      const resume = service.resumeConversation('sess-of-test');
      await new Promise((r) => setTimeout(r, 0));
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      pendingRestart.resolve();
      await restart;
      await resume;

      expect(resumedSessions()).toEqual([]);
      expect(commands()).not.toContain('get_conversation');
      expect(service.lastKnownSessionId).toBeNull();
    });

    it('drops the resume when the project changes before the restart ends, and frees the chat', async () => {
      const restart = projectState.restartContainers();
      const resume = service.resumeConversation('sess-of-test');
      await new Promise((r) => setTimeout(r, 0));
      projectState.activeProject.set('other');
      pendingRestart.resolve();
      await restart;
      await resume;

      expect(resumedSessions()).toEqual([]);
      expect(commands()).not.toContain('get_conversation');
      expect(service.lastKnownSessionId).toBeNull();

      await service.resumeConversation('sess-of-other');

      expect(resumedSessions()).toEqual(['sess-of-other']);
    });
  });
});
