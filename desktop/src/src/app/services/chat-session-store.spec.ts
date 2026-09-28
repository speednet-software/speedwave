import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Clipboard } from '@angular/cdk/clipboard';
import {
  ChatSessionStore,
  MODEL_SWITCH_NOT_APPLIED,
  MODEL_SWITCH_UNCONFIRMED,
  modelSwitchRefused,
  NEW_CONVERSATION_AUTH,
  NEW_CONVERSATION_BUSY,
  NEW_CONVERSATION_FAILED,
  NEW_CONVERSATION_NO_PROJECT,
  NEW_CONVERSATION_PROJECT_CHANGED,
  NEW_CONVERSATION_STREAMING,
  SESSION_KEPT_MARKER,
  historyFitsTarget,
  isNotAuthenticatedError,
  mapContextOverflowError,
  mapNotLoggedInError,
  messageBlocksToState,
  stateBlocksToMessageBlocks,
  toChatMessages,
  type ChatStoreDeps,
} from './chat-session-store';
import { ProjectStateService } from './project-state.service';
import { TauriService } from './tauri.service';
import { AnthropicModelsService } from './anthropic-models.service';
import { ClaudeControlService } from './claude-control.service';
import { LoggerService } from './logger.service';
import { PlanUsageService } from './plan-usage.service';
import { MockTauriService, MOCK_BUNDLE_RECONCILE_DONE } from '../testing/mock-tauri.service';
import { createDeferred, type Deferred } from '../testing/deferred';
import { makeMockLogger } from '../testing/mock-logger';
import type { ConversationTranscript, StreamChunk, ToolUseBlock } from '../models/chat';
import type { ModelSwitchOutcome } from '../models/claude-control';
import { DEFAULT_CONTEXT_TOKENS } from '../models/llm';

describe('ChatSessionStore', () => {
  let store: ChatSessionStore;
  let mockTauri: MockTauriService;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    mockLogger = makeMockLogger();
    const invoke = mockTauri.invoke.bind(mockTauri);
    mockTauri.invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      const answer = await invoke<T>(cmd, args);
      if (cmd === 'switch_chat_model' && answer === undefined) {
        return { outcome: 'confirmed' } as T;
      }
      return answer;
    };

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
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    const deps: ChatStoreDeps = {
      tauri: mockTauri,
      projectState: TestBed.inject(ProjectStateService),
      anthropicModels: TestBed.inject(AnthropicModelsService),
      control: TestBed.inject(ClaudeControlService),
      planUsage: TestBed.inject(PlanUsageService),
      clipboard: TestBed.inject(Clipboard),
      log: mockLogger,
      ensureListeners: () => Promise.resolve(),
    };
    store = new ChatSessionStore('test-tab-id', deps);

    store._setState({ messages: [], currentBlocks: [], sessionStats: null });
    store.isStreaming = false;
  });

  describe('loadingTranscript', () => {
    it('defaults to false', () => {
      expect(store.loadingTranscriptFromState()).toBe(false);
    });

    it('beginTranscriptLoad sets it true, endTranscriptLoad sets it false', () => {
      store.beginTranscriptLoad();
      expect(store.loadingTranscriptFromState()).toBe(true);
      store.endTranscriptLoad();
      expect(store.loadingTranscriptFromState()).toBe(false);
    });
  });

  describe('sessionAwaitedFromState', () => {
    it('follows no project status on its own', () => {
      const projectState = TestBed.inject(ProjectStateService);
      for (const status of ['loading', 'starting', 'switching', 'ready', 'error'] as const) {
        projectState.status.set(status);
        expect(store.sessionAwaitedFromState()).toBe(false);
      }
    });

    it('is true from the first init until the session it starts is up', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const started = createDeferred<void>();
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) =>
        cmd === 'start_chat' ? started.promise : base(cmd, args);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      const initing = store.init();
      expect(store.sessionAwaitedFromState()).toBe(true);
      await vi.waitFor(() => {
        expect(invokeSpy.mock.calls.some(([cmd]) => cmd === 'start_chat')).toBe(true);
      });
      await initing;
      expect(store.sessionAwaitedFromState()).toBe(true);

      started.resolve();
      await vi.waitFor(() => expect(store.sessionAwaitedFromState()).toBe(false));
      await store.init();
      expect(store.sessionAwaitedFromState()).toBe(false);
    });

    it('is true while a container restart runs on a ready project', () => {
      const projectState = TestBed.inject(ProjectStateService);
      projectState.status.set('ready');

      projectState.restarting = true;
      expect(store.sessionAwaitedFromState()).toBe(true);

      projectState.restarting = false;
      expect(store.sessionAwaitedFromState()).toBe(false);
    });
  });

  describe('sessionEnded (SPEED-388 phase 2)', () => {
    it('defaults to false', () => {
      expect(store.sessionEnded()).toBe(false);
    });

    it('markSessionEnded flips it to true', () => {
      store.markSessionEnded();
      expect(store.sessionEnded()).toBe(true);
    });

    it('markSessionEnded on an idle store leaves messages and stream state untouched', () => {
      store._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'kept' }], timestamp: 1 }],
      });

      store.markSessionEnded();

      expect(store.isStreaming).toBe(false);
      expect(store.messages).toHaveLength(1);
      expect(store.currentBlocks).toEqual([]);
    });

    it('markSessionEnded on a streaming store finalizes the turn like a stop', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'partial' } });
      expect(store.isStreaming).toBe(true);
      const turnBefore = store.turnId;

      store.markSessionEnded();

      expect(store.sessionEnded()).toBe(true);
      expect(store.isStreaming).toBe(false);
      expect(store.currentBlocks).toEqual([]);
      expect(store.turnId).toBeGreaterThan(turnBefore);
      expect(store.messages.at(-1)?.role).toBe('assistant');
      expect(store.messages.at(-1)?.blocks).toEqual([{ type: 'text', content: 'partial' }]);
    });

    it('markSessionEnded marks a running tool interrupted', () => {
      store.isStreaming = true;
      store._setState({
        currentBlocks: [
          {
            type: 'tool_use',
            tool: {
              type: 'tool_use',
              tool_id: 't1',
              tool_name: 'Bash',
              input_json: '{}',
              status: 'running',
            },
          },
        ],
      });

      store.markSessionEnded();

      const lastBlocks = store.messages.at(-1)?.blocks;
      expect(lastBlocks?.[0]).toMatchObject({
        type: 'tool_use',
        tool: { status: 'error', result: 'Interrupted', result_is_error: true },
      });
    });

    it('resetForNewConversation clears a session-ended flag', () => {
      store.markSessionEnded();
      store.resetForNewConversation();
      expect(store.sessionEnded()).toBe(false);
    });
  });

  describe('dispose', () => {
    it('clears the resume decider', () => {
      store.setResumeDecider(() => Promise.resolve('resume'));

      store.dispose();

      expect((store as unknown as { _resumeDecider: unknown })._resumeDecider).toBeNull();
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

      await store.init();
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

      await store.init();
      await new Promise((r) => setTimeout(r, 0));
      store.beginStartingSession();
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

      await store.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(projectState.status()).toBe('auth_required');
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('only runs init once', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await store.init();
      const firstCallCount = spy.mock.calls.filter((c) => c[0] === 'start_chat').length;

      await store.init();
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
      store._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [],
        sessionStats: null,
      });
      const spy = vi.spyOn(mockTauri, 'invoke');

      await store.startNewConversation();

      expect(store.messages.length).toBe(0);
      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(1);
      expect(store.lastKnownSessionId).toBeNull();
      expect(store.hasConversation()).toBe(false);
    });

    it('claims the bootstrap slot so a later init does not start a second session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      const spy = vi.spyOn(mockTauri, 'invoke');

      await store.startNewConversation();
      await store.init();
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

      store.seedSessionId('sess-old');

      await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_FAILED);

      expect(store.messages.length).toBe(0);
      expect(store.lastKnownSessionId).toBe('sess-old');

      fail = false;
      projectState.status.set('ready');
      const spy = vi.spyOn(mockTauri, 'invoke');
      await store.startNewConversation();
      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(1);
    });

    it('keeps the conversation and names the cause when the project is not ready', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      store._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [],
        sessionStats: null,
      });
      projectState.status.set('starting');
      const spy = vi.spyOn(mockTauri, 'invoke');

      await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_BUSY);

      expect(store.messages.length).toBe(1);
      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(0);
    });

    it('tells the user to open a project instead of asking them to wait', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set(null);

      await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_NO_PROJECT);
    });

    it('refuses while a resume owns the session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      const resuming = store.resumeConversation('sess-1');

      await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_BUSY);
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
      store.seedSessionId('sess-stale');

      const starting = store.startNewConversation();
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      const resuming = store.resumeConversation('sess-resumed');
      pendingStart.resolve();

      await expect(starting).rejects.toThrow(NEW_CONVERSATION_BUSY);
      expect(store.lastKnownSessionId).toBe('sess-resumed');
      expect(store.newConversationBlockedReason()).toBe(NEW_CONVERSATION_BUSY);

      pendingResume.resolve();
      await resuming;
      expect(store.lastKnownSessionId).toBe('sess-resumed');
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

      const resuming = store.resumeConversation('sess-resumed');
      pendingResume.resolve();
      await resuming;

      const replies = store
        .messagesFromState()
        .filter((m) => m.role === 'assistant')
        .map((m) => m.blocks.map((b) => ('content' in b ? b.content : '')).join(''));
      expect(replies).toEqual(['Hello', 'Goodbye']);
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

      store.resetForNewConversation();
      await store.init();
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      const resuming = store.resumeConversation('sess-resumed');
      await vi.waitFor(() => {
        expect(calls).toContain('resume_conversation');
      });
      pendingStart.resolve();
      await pendingStart.promise;
      pendingResume.resolve();
      await resuming;

      const replies = store
        .messagesFromState()
        .filter((m) => m.role === 'assistant')
        .map((m) => m.blocks.map((b) => ('content' in b ? b.content : '')).join(''));
      expect(replies).toEqual(['Hello', 'Goodbye']);
      expect(store.lastKnownSessionId).toBe('sess-resumed');
    });

    it('keeps the conversation when a reply is still streaming', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      store._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [],
        sessionStats: null,
      });
      store.isStreaming = true;
      const spy = vi.spyOn(mockTauri, 'invoke');

      await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_STREAMING);

      expect(store.messages.length).toBe(1);
      expect(spy.mock.calls.filter((c) => c[0] === 'start_chat').length).toBe(0);
    });

    it('keeps the conversation when a session start is already in flight', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => undefined);
      store._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [],
        sessionStats: null,
      });
      const release = store.beginStartingSession();

      await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_BUSY);

      expect(store.messages.length).toBe(1);
      release();
    });

    it('points at Settings when the backend rejects the start as unauthenticated', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = readyHandler(() => {
        throw new Error('not authenticated');
      });

      await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_AUTH);
      expect(projectState.status()).toBe('auth_required');
    });
  });

  describe('sendMessage', () => {
    it('adds user message and invokes backend', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      await store.sendMessage('Hello');

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hello' });
      expect(store.isStreaming).toBe(true);
      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [{ type: 'text', text: 'Hello' }],
        displayText: 'Hello',
        tabId: store.tabId,
      });
    });

    it('inlines image attachments as @/workspace/... in the wire text (ADR-065)', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      await store.sendMessage({
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
        tabId: store.tabId,
      });
      expect(store.messages[0].blocks).toEqual([
        { type: 'text', content: 'Co tu widać?' },
        { type: 'image', media_type: 'image/png', alt: 'paste-1.png' },
      ]);
    });

    it('accepts image-only ChatInput and emits a wire text block containing the @path only', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      await store.sendMessage({
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
        tabId: store.tabId,
      });
    });

    it('ignores empty text', async () => {
      await store.sendMessage('');
      expect(store.messages).toHaveLength(0);
    });

    it('ignores a lone slash or whitespace-only text (skill-menu trigger)', async () => {
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      await store.sendMessage('/');
      await store.sendMessage('  /  ');
      await store.sendMessage('   ');
      expect(store.messages).toHaveLength(0);
      expect(store.isStreaming).toBe(false);
      expect(calls).not.toContain('send_message');
    });

    it('still sends a real slash command', async () => {
      await store.sendMessage('/code-review');
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].role).toBe('user');
    });

    it('ignores when already streaming', async () => {
      store.isStreaming = true;
      await store.sendMessage('Hello');
      expect(store.messages).toHaveLength(0);
    });

    it('handles invoke failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') throw new Error('fail');
        return undefined;
      };

      await store.sendMessage('Hello');

      expect(store.isStreaming).toBe(false);
      expect(store.messages).toHaveLength(2);
      const errorBlock = store.messages[1].blocks[0];
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

      await store.sendMessage('Hello');

      expect(calls.filter((cmd) => cmd === 'send_message')).toHaveLength(1);
      expect(calls).not.toContain('start_chat');
      expect(calls).not.toContain('list_projects');
      expect(store.isStreaming).toBe(false);
      const errorBlock = store.messages[1].blocks[0] as { type: string; content: string };
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

      await store.sendMessage('Hello');

      expect(sendAttempt).toBe(2);
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].role).toBe('user');
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

      await store.sendMessage('Retry me');

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Retry me' });
    });

    it('restarts a dead session for the send retry on the tab model', async () => {
      (store as unknown as { _tabModel: { set(model: string | null): void } })._tabModel.set(
        'claude-haiku-4-5'
      );
      let sendAttempt = 0;
      const starts: unknown[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        if (cmd === 'send_message') {
          sendAttempt++;
          if (sendAttempt === 1) throw new Error('no active session');
          return undefined;
        }
        if (cmd === 'start_chat') starts.push(args);
        if (cmd === 'list_projects') {
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        }
        return undefined;
      };

      await store.sendMessage('Retry me');

      expect(starts).toEqual([{ project: 'test', tabId: store.tabId, model: 'claude-haiku-4-5' }]);
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

      const resuming = store.resumeConversation('sess-resumed');
      await new Promise((r) => setTimeout(r, 0));
      expect(store.sessionStartInFlightFromState()).toBe(true);
      await store.sendMessage('typed during the restart wait');

      projectState.restartInFlight = null;
      pendingRestart.resolve();
      await vi.waitFor(() => {
        expect(calls).toContain('resume_conversation');
      });
      await store.sendMessage('typed during the resume');

      pendingResume.resolve();
      await resuming;

      expect(calls).not.toContain('send_message');
      expect(store.messages).toHaveLength(0);
      expect(store.sessionStartInFlightFromState()).toBe(false);
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

      await store.init();
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      expect(store.sessionStartInFlightFromState()).toBe(true);

      await store.sendMessage('too early');

      expect(calls).not.toContain('send_message');
      expect(store.messages).toHaveLength(0);
      expect(store.isStreaming).toBe(false);

      pendingStart.resolve();
      await vi.waitFor(() => {
        expect(store.sessionStartInFlightFromState()).toBe(false);
      });
      await store.sendMessage('on time');

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(store.messages).toHaveLength(1);
      expect(store.isStreaming).toBe(true);
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
            c.cmd === 'switch_chat_model' &&
            JSON.stringify(c.args).includes('"model":"claude-haiku-4-5"')
        );

      const resuming = store.resumeConversation('sess-resumed');
      await vi.waitFor(() => {
        expect(calls.map((c) => c.cmd)).toContain('resume_conversation');
      });
      await store.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });

      expect(modelSent()).toBe(false);
      expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');

      pendingResume.resolve();
      await resuming;
      await vi.waitFor(() => {
        expect(modelSent()).toBe(true);
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

      const sending = store.sendMessage('written before New');
      await vi.waitFor(() => {
        expect(calls.lastIndexOf('list_projects')).toBeGreaterThan(calls.indexOf('send_message'));
      });
      store.resetForNewConversation();
      await store.init();
      pendingLookup.resolve();
      await sending;

      expect(calls.filter((c) => c === 'start_chat')).toHaveLength(1);
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
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

      const sending = store.sendMessage('written before New');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      store.resetForNewConversation();
      await store.init();
      await vi.waitFor(() => {
        expect(calls.filter((c) => c === 'start_chat')).toHaveLength(2);
      });
      pendingRetryStart.resolve();
      await sending;

      expect(store.sessionStartInFlightFromState()).toBe(true);
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);

      pendingNewStart.resolve();
      await vi.waitFor(() => {
        expect(store.sessionStartInFlightFromState()).toBe(false);
      });
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

      const sending = store.sendMessage('written before New');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      store.resetForNewConversation();
      await store.init();
      await vi.waitFor(() => {
        expect(calls.filter((c) => c === 'start_chat')).toHaveLength(2);
      });
      pendingRetryStart.reject(new Error('boom'));
      await sending;

      expect(store.messages).toHaveLength(0);
      expect(store.sessionStartInFlightFromState()).toBe(true);
      expect(store.sessionAwaitedFromState()).toBe(true);

      pendingNewStart.resolve();
      await vi.waitFor(() => {
        expect(store.sessionStartInFlightFromState()).toBe(false);
      });
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

      const sending = store.sendMessage('written before New');
      await vi.waitFor(() => {
        expect(calls).toContain('send_message');
      });
      store.resetForNewConversation();
      await store.init();
      await vi.waitFor(() => {
        expect(store.sessionStartInFlightFromState()).toBe(false);
      });
      pendingSend.reject(new Error('Message too long'));
      await sending;

      expect(store.messages).toHaveLength(0);
      expect(store.isStreaming).toBe(false);
    });

    it("drops the dying session's end report during the retry's own start and resends", async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = store.sendMessage('hello');
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
      expect(store.isStreaming).toBe(true);
      expect(store.messages.map((m) => m.role)).toEqual(['user']);
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
            void store.resumeConversation('sess-resumed');
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

      await store.sendMessage('written during the restart');

      expect(calls).not.toContain('start_chat');
      expect(calls).not.toContain('resume_conversation');
      const lastMsg = store.messages[store.messages.length - 1];
      expect((lastMsg.blocks[0] as { content: string }).content).toContain(
        'Session is still starting'
      );

      projectState.restartInFlight = null;
      pendingRestart.resolve();
      await vi.waitFor(() => {
        expect(store.sessionStartInFlightFromState()).toBe(false);
      });
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

      await store.sendMessage('hello');

      expect(calls).not.toContain('start_chat');
      const lastMsg = store.messages[store.messages.length - 1];
      expect((lastMsg.blocks[0] as { content: string }).content).toContain('No active project');
    });

    it('does not start a session when the backend already moved to another project', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { calls } = installFailingSendWithPendingRetryStart('other');

      await store.sendMessage('written for test');

      expect(calls).not.toContain('start_chat');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(store.isStreaming).toBe(false);
      const lastMsg = store.messages[store.messages.length - 1];
      expect((lastMsg.blocks[0] as { content: string }).content).toContain(
        "The active project is now 'other', not 'test'"
      );
    });

    it('does not mark the project as needing sign-in after a switch failed back to it during the retry', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = store.sendMessage('written before the switch');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      mockTauri.dispatchEvent('project_switch_failed', { project: 'test', error: 'switch failed' });
      pendingRetryStart.reject(
        new Error('Claude is not authenticated. Please authenticate first.')
      );
      await sending;

      expect(projectState.isSettledOn('test')).toBe(true);
      expect(projectState.status()).toBe('error');
      expect(projectState.error).toBe('switch failed');
    });

    it('does not mark the new project as needing sign-in after a switch finished during the retry', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = store.sendMessage('written before the switch');
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

    it('does not mark a project as needing sign-in for a retry that a project switch superseded', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = store.sendMessage('written before the switch');
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

    it("marks the project as needing sign-in when the retry's own start fails after Stop", async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const { pendingRetryStart, calls } = installFailingSendWithPendingRetryStart();

      const sending = store.sendMessage('never mind');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      await store.stopConversation();
      pendingRetryStart.reject(
        new Error('Claude is not authenticated. Please authenticate first.')
      );
      await sending;

      expect(projectState.status()).toBe('auth_required');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(store.isStreaming).toBe(false);
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

      const sending = store.sendMessage('written before the switch');
      await vi.waitFor(() => {
        expect(calls.lastIndexOf('list_projects')).toBeGreaterThan(calls.indexOf('send_message'));
      });
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      pendingLookup.resolve();
      await sending;

      expect(calls).not.toContain('start_chat');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
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

      const sending = store.sendMessage('never mind');
      await vi.waitFor(() => {
        expect(calls).toContain('start_chat');
      });
      await store.stopConversation();
      pendingRetryStart.resolve();
      await sending;

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(store.isStreaming).toBe(false);
      expect(store.sessionStartInFlightFromState()).toBe(false);
    });

    it('shows the still-starting error instead of resending when a start began during the failed send', async () => {
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'send_message') {
          (store as unknown as { startingSession: boolean }).startingSession = true;
          throw new Error('no active session');
        }
        return undefined;
      };

      await store.sendMessage('hello');

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(calls).not.toContain('start_chat');
      expect(store.isStreaming).toBe(false);
      const lastMsg = store.messages[store.messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect((lastMsg.blocks[0] as { content: string }).content).toContain(
        'Session is still starting'
      );
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
            void store.resumeConversation('sess-resumed');
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

      await store.sendMessage('written before the resume');
      expect(store.messages).toHaveLength(0);

      pendingResume.resolve();
      await vi.waitFor(() => {
        expect(store.sessionStartInFlightFromState()).toBe(false);
      });

      expect(calls.filter((c) => c === 'send_message')).toHaveLength(1);
      expect(calls).not.toContain('start_chat');
      expect(store.messagesFromState().map((m) => m.role)).toEqual(['assistant']);
      expect(store.isStreaming).toBe(false);
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

      await store.sendMessage('Hello');

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].role).toBe('user');
    });

    it('shows error when retry itself fails', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') throw new Error('session exited (exit status: 1)');
        if (cmd === 'list_projects') throw new Error('backend crashed');
        return undefined;
      };

      await store.sendMessage('Hello');

      expect(store.isStreaming).toBe(false);
      expect(store.messages).toHaveLength(2);
      const errorBlock = store.messages[1].blocks[0];
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

      await store.sendMessage('Hello');

      expect(store.isStreaming).toBe(false);
      expect(store.messages).toHaveLength(2);
      const errorBlock = store.messages[1].blocks[0];
      expect(errorBlock.type).toBe('error');
    });
  });

  describe('control-shape check runs on the wire text, not displayText', () => {
    const PLAN_MODE_PREFIX = '[Plan mode] Produce a plan only.\n\n';

    it('suppresses the optimistic bubble when the wire text is control-shaped even though displayText carries a plan-mode prefix', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      await store.sendMessage(
        { text: '/model claude-sonnet-5', attachments: [] },
        '/model claude-sonnet-5'
      );

      expect(store.messages).toHaveLength(0);
      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [{ type: 'text', text: '/model claude-sonnet-5' }],
        displayText: '/model claude-sonnet-5',
        tabId: store.tabId,
      });
    });

    it('shows the optimistic bubble when displayText looks control-shaped but the wire text (plan-mode prefixed) is not', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      const wireText = `${PLAN_MODE_PREFIX}/model claude-sonnet-5`;
      await store.sendMessage({ text: wireText, attachments: [] }, '/model claude-sonnet-5');

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].role).toBe('user');
      expect(store.messages[0].blocks[0]).toEqual({
        type: 'text',
        content: '/model claude-sonnet-5',
      });
      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [{ type: 'text', text: wireText }],
        displayText: '/model claude-sonnet-5',
        tabId: store.tabId,
      });
    });
  });

  describe('ControlChip chunk handling', () => {
    it('appends a chip message when a control-shaped send is emitted', () => {
      const beforeLen = store.messages.length;

      store.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'claude-sonnet-5' },
      });

      expect(store.messages.length).toBe(beforeLen + 1);
      const last = store.messages[store.messages.length - 1];
      expect(last.role).toBe('user');
      expect(last.blocks).toEqual([
        { type: 'chip', command: 'model', argument: 'claude-sonnet-5' },
      ]);
    });

    it('appends a chip message carrying a uuid when the chunk provides one', () => {
      store.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'effort', argument: 'high', uuid: 'u_effort_1' },
      });

      const last = store.messages[store.messages.length - 1];
      expect(last.uuid).toBe('u_effort_1');
      expect(last.uuid_status).toBe('Committed');
      expect(last.blocks).toEqual([{ type: 'chip', command: 'effort', argument: 'high' }]);
    });

    it('appends a chip with no uuid when the chunk carries none (the normal live-send case)', () => {
      store.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'claude-opus-4-8' },
      });
      const last = store.messages[store.messages.length - 1];
      expect(last.uuid).toBeUndefined();
      expect(last.blocks).toEqual([
        { type: 'chip', command: 'model', argument: 'claude-opus-4-8' },
      ]);
    });

    it('ControlChip then QueueDrained for the same control text yields exactly one chip, no plain bubble', () => {
      const beforeLen = store.messages.length;

      store.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'claude-sonnet-5' },
      });
      store.handleStreamChunk({
        chunk_type: 'QueueDrained',
        data: { session_id: 's-1', text: '/model claude-sonnet-5' },
      });

      expect(store.messages.length).toBe(beforeLen + 1);
      const last = store.messages[store.messages.length - 1];
      expect(last.blocks).toEqual([
        { type: 'chip', command: 'model', argument: 'claude-sonnet-5' },
      ]);
      expect(store.messages.some((m) => m.blocks.some((b) => b.type === 'text'))).toBe(false);
    });
  });

  describe('handleStreamChunk', () => {
    it('accumulates text chunks into currentBlocks', () => {
      const chunk1: StreamChunk = { chunk_type: 'Text', data: { content: 'Hello ' } };
      const chunk2: StreamChunk = { chunk_type: 'Text', data: { content: 'world!' } };
      store.handleStreamChunk(chunk1);
      store.handleStreamChunk(chunk2);

      expect(store.currentBlocks).toHaveLength(1);
      expect(store.currentBlocks[0]).toEqual({ type: 'text', content: 'Hello world!' });
      expect(store.isStreaming).toBe(true);
    });

    it('accumulates thinking chunks', () => {
      const chunk1: StreamChunk = { chunk_type: 'Thinking', data: { content: '' } };
      const chunk2: StreamChunk = { chunk_type: 'Thinking', data: { content: 'Let me think...' } };
      store.handleStreamChunk(chunk1);
      store.handleStreamChunk(chunk2);

      expect(store.currentBlocks).toHaveLength(1);
      expect(store.currentBlocks[0]).toEqual({
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
      store.handleStreamChunk(chunk);

      expect(store.currentBlocks).toHaveLength(1);
      const block = store.currentBlocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use') {
        expect(block.tool.tool_id).toBe('t1');
        expect(block.tool.tool_name).toBe('Read');
        expect(block.tool.status).toBe('running');
      }
    });

    it('handles ToolInputDelta chunk', () => {
      store.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '{"file' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '":"a.ts"}' },
      });

      const block = store.currentBlocks[0];
      if (block.type === 'tool_use') {
        expect(block.tool.input_json).toBe('{"file":"a.ts"}');
      }
    });

    it('assembles complete tool input_json from multiple ToolInputDelta chunks', () => {
      store.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Bash' },
      });

      store.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '{"com' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: 'mand' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '":"ls' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: ' -la"}' },
      });

      expect(store.currentBlocks).toHaveLength(1);
      const block = store.currentBlocks[0];
      expect(block.type).toBe('tool_use');
      if (block.type === 'tool_use') {
        expect(block.tool.input_json).toBe('{"command":"ls -la"}');
        const parsed = JSON.parse(block.tool.input_json);
        expect(parsed).toEqual({ command: 'ls -la' });
      }
    });

    it('handles ToolResult chunk', () => {
      store.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolResult',
        data: { tool_id: 't1', content: 'file contents', is_error: false },
      });

      const block = store.currentBlocks[0];
      if (block.type === 'tool_use' && block.tool.status === 'done') {
        expect(block.tool.result).toBe('file contents');
        expect(block.tool.status).toBe('done');
      }
    });

    it('handles ToolResult with error', () => {
      store.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Bash' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolResult',
        data: { tool_id: 't1', content: 'command not found', is_error: true },
      });

      const block = store.currentBlocks[0];
      if (block.type === 'tool_use' && block.tool.status === 'error') {
        expect(block.tool.result_is_error).toBe(true);
        expect(block.tool.status).toBe('error');
      }
    });

    describe('tool input completion and parse warnings', () => {
      const TRUNCATED = '{"to": "ab97ec49c3f64e4c0"';
      const COMPLETE = '{"to":"ab97ec49c3f64e4c0","message":"Any progress?"}';

      function toolBlock(index = 0): ToolUseBlock {
        const block = store.currentBlocks[index];
        if (block.type !== 'tool_use') throw new Error(`block ${index} is ${block.type}`);
        return block.tool;
      }

      function startTool(inputDelta: string, toolName = 'SendMessage'): void {
        store.handleStreamChunk({
          chunk_type: 'ToolStart',
          data: { tool_id: 't1', tool_name: toolName },
        });
        if (inputDelta) {
          store.handleStreamChunk({
            chunk_type: 'ToolInputDelta',
            data: { tool_id: 't1', partial_json: inputDelta },
          });
        }
      }

      function complete(inputJson: string, toolId = 't1'): void {
        store.handleStreamChunk({
          chunk_type: 'ToolInputComplete',
          data: { tool_id: toolId, input_json: inputJson },
        });
      }

      function result(isError = false, toolId = 't1'): void {
        store.handleStreamChunk({
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
        const before = store.currentBlocks;
        complete('{}', 'toolu_subagent');
        expect(store.currentBlocks).toEqual(before);
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
          store.handleStreamChunk({ chunk_type: 'Text', data: { content: `delta ${i} ` } });
        }
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: 'sid' } });
        store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'next turn' } });
        expect(store.messages[0].blocks[0].type).toBe('tool_use');
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
        expect(store.currentBlocks).toEqual([]);
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
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: 'sid' } });
        const block = store.messages[0].blocks[0];
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
        store.handleStreamChunk({ chunk_type: 'Error', data: { content: 'Error: rate limit' } });
        const [tool, error] = store.messages[0].blocks;
        expect(tool.type === 'tool_use' && tool.tool.status).toBe('error');
        expect(error.type).toBe('error');
      });

      it('stopConversation marks a streaming tool Interrupted without a parse warning', async () => {
        startTool(TRUNCATED);
        store.isStreaming = true;
        await store.stopConversation();
        const block = store.messages[0].blocks[0];
        expect(block.type).toBe('tool_use');
        if (block.type === 'tool_use') expect(block.tool.status).toBe('error');
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });
    });

    it('Result finalizes currentBlocks into messages', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Response' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.05,
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Response' });
      expect(store.isStreaming).toBe(false);
      expect(store.currentBlocks).toHaveLength(0);
      expect(store.sessionStats).toEqual({
        session_id: 'abc',
        total_cost: 0.05,
        usage: { input_tokens: 100, output_tokens: 50 },
        total_output_tokens: 50,
        context_window_size: null,
        model: undefined,
      });
    });

    it('Result stores context_usage and the fit-gate tokens from the last API call', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'x' } });
      store.handleStreamChunk({
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

      expect(store.sessionStats?.context_usage).toEqual({
        input_tokens: 2,
        output_tokens: 1660,
        cache_read_tokens: 66_844,
        cache_write_tokens: 4920,
      });
      expect(store.lastContextTokens).toBe(71_766);
    });

    it('a Result without context_usage keeps the previous meter value', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'x' } });
      store.handleStreamChunk({
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
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'y' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(store.sessionStats?.context_usage?.cache_read_tokens).toBe(30);
      expect(store.lastContextTokens).toBe(80);
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

      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.99 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(store.sessionStats?.total_cost).toBeCloseTo(0.2, 6);

      aggregatorTotal = 0.5;
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'b' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_2', total_cost: 1.5 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(store.sessionStats?.total_cost).toBeCloseTo(0.5, 6);
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
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.1 },
      });
      await new Promise((r) => setTimeout(r, 0));
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'b' } });
      store.handleStreamChunk({
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
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.42 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(store.sessionStats?.total_cost).toBe(0.42);
      expect(spy).not.toHaveBeenCalledWith('get_conversation_cost', expect.anything());
    });

    it('reconcile hides the per-message cost when the proxy SSOT is free/null', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        if (cmd === 'get_usage_for_response') return { cost_usd: null, cost_source: 'free' };
        return undefined;
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', turn_cost: 0.046 },
      });
      await new Promise((r) => setTimeout(r, 0));
      const entry = store.messages.find((m) => m.uuid === 'msg_1');
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
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.42 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(store.sessionStats?.total_cost).toBeNull();
    });

    it('local provider suppresses the live CC cost preview (no $0.00x flicker)', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      (store as unknown as { _currentProvider: string | null })._currentProvider = 'local';
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.002, turn_cost: 0.002 },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(store.sessionStats?.total_cost).toBeNull();
      const entry = store.messages.find((m) => m.uuid === 'msg_1');
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

        store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        store.handleStreamChunk({
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
        expect(store.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeUndefined();
        expect(store.sessionStats?.total_cost).toBe(0.99);

        priced = true;
        await vi.advanceTimersByTimeAsync(5000);

        expect(store.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeCloseTo(0.0046, 6);
        expect(store.sessionStats?.total_cost).toBeCloseTo(0.0046, 6);
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

        store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        store.handleStreamChunk({
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
        expect(store.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBe(0.5);
        expect(store.sessionStats?.total_cost).toBe(0.5);

        priced = true;
        await vi.advanceTimersByTimeAsync(5000);
        expect(store.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeCloseTo(0.0046, 6);
        expect(store.sessionStats?.total_cost).toBeCloseTo(0.0046, 6);
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

        store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        store.handleStreamChunk({
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
        expect(store.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBe(0.13);

        for (let t = 0; t < 35_000; t += 5000) {
          elapsed += 5000;
          await vi.advanceTimersByTimeAsync(5000);
        }

        expect(store.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeCloseTo(0.0858, 6);
        expect(store.sessionStats?.total_cost).toBeCloseTo(0.0858, 6);
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

        store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        store.handleStreamChunk({
          chunk_type: 'Result',
          data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.1 },
        });
        await vi.advanceTimersByTimeAsync(0);
        const callsAfterFirst = calls;

        await store.sendMessage('next question');
        await vi.advanceTimersByTimeAsync(10_000);

        expect(calls).toBeLessThanOrEqual(callsAfterFirst + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('Result with empty currentBlocks does not add message', () => {
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });

      expect(store.messages).toHaveLength(0);
      expect(store.isStreaming).toBe(false);
    });

    it('Result with result_text creates text block and finalizes', () => {
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          result_text: 'Session cost: $0.003\nTotal cost: $0.015',
        },
      });

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks).toHaveLength(1);
      expect(store.messages[0].blocks[0]).toEqual({
        type: 'text',
        content: 'Session cost: $0.003\nTotal cost: $0.015',
      });
      expect(store.isStreaming).toBe(false);
    });

    it('Result without result_text finalizes normally', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks).toHaveLength(1);
      expect(store.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Hello' });
    });

    it('Result with result_text appends after tool blocks', () => {
      store.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolResult',
        data: { tool_id: 't1', content: 'file contents', is_error: false },
      });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', result_text: 'Review complete.' },
      });

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks).toHaveLength(2);
      expect(store.messages[0].blocks[0].type).toBe('tool_use');
      expect(store.messages[0].blocks[1]).toEqual({
        type: 'text',
        content: 'Review complete.',
      });
    });

    it('Text deltas followed by Result with result_text skips duplicate', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Streamed text.' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', result_text: 'Result text.' },
      });

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks).toHaveLength(1);
      expect(store.messages[0].blocks[0]).toEqual({ type: 'text', content: 'Streamed text.' });
    });

    it('Error chunk finalizes as error message', () => {
      store.isStreaming = true;
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'partial' } });
      store.handleStreamChunk({ chunk_type: 'Error', data: { content: 'Something went wrong' } });

      expect(store.isStreaming).toBe(false);
      expect(store.currentBlocks).toHaveLength(0);
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks).toHaveLength(2);
      expect(store.messages[0].blocks[1]).toEqual({
        type: 'error',
        content: 'Something went wrong',
      });
    });

    it('does not notify on unknown chunk type', () => {
      const before = store.state();

      store.handleStreamChunk({
        chunk_type: 'UnknownFutureType' as StreamChunk['chunk_type'],
        data: {},
      } as StreamChunk);

      expect(store.state()).toBe(before);
      expect(store.currentBlocks).toHaveLength(0);
      expect(store.isStreaming).toBe(false);
    });

    it('SystemInit stores model name and Result includes it in sessionStats', () => {
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6' },
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(store.sessionStats?.model).toBe('claude-opus-4-6');
    });

    it('Result without prior SystemInit has no model in sessionStats', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(store.sessionStats?.model).toBeUndefined();
    });

    it('full streaming sequence produces correct state', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Let me ' } });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'read that.' } });
      store.handleStreamChunk({ chunk_type: 'Thinking', data: { content: '' } });
      store.handleStreamChunk({
        chunk_type: 'Thinking',
        data: { content: 'I should check the file' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolInputDelta',
        data: { tool_id: 't1', partial_json: '{"file_path":"/a.ts"}' },
      });
      store.handleStreamChunk({
        chunk_type: 'ToolResult',
        data: { tool_id: 't1', content: 'contents', is_error: false },
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'The file looks good.' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sid', total_cost: 0.01 },
      });

      expect(store.messages).toHaveLength(1);
      const blocks = store.messages[0].blocks;
      expect(blocks).toHaveLength(4);
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('thinking');
      expect(blocks[2].type).toBe('tool_use');
      expect(blocks[3].type).toBe('text');
      expect(store.isStreaming).toBe(false);
    });
  });

  describe('sessionStatsFromState signal (reactive footer)', () => {
    it('defaults to null and mirrors the getter', () => {
      expect(store.sessionStatsFromState()).toBeNull();
      expect(store.sessionStatsFromState()).toBe(store.sessionStats);
    });

    it('updates reactively on Result without needing another change-detection trigger', () => {
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.5, usage: { input_tokens: 2, output_tokens: 9 } },
      });
      const sig = store.sessionStatsFromState();
      expect(sig?.session_id).toBe('abc');
      expect(sig?.total_cost).toBe(0.5);
      expect(store.sessionStatsFromState()).toBe(store.sessionStats);
    });

    it('updates reactively on seedSessionId', () => {
      store.seedSessionId('11111111-1111-1111-1111-111111111111');
      expect(store.sessionStatsFromState()?.session_id).toBe(
        '11111111-1111-1111-1111-111111111111'
      );
    });

    it('clears reactively on resetForNewConversation', () => {
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.5 },
      });
      expect(store.sessionStatsFromState()).not.toBeNull();
      store.resetForNewConversation();
      expect(store.sessionStatsFromState()).toBeNull();
    });
  });

  describe('SystemInit model lifecycle', () => {
    it('resetForNewConversation clears model so subsequent Result has no model', () => {
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6' },
      });
      store.resetForNewConversation();
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(store.sessionStats?.model).toBeUndefined();
    });
  });

  describe('pendingModelOverride', () => {
    it('pendingModelOverride is null when nothing was set', () => {
      expect(store.pendingModelOverride()).toBeNull();
    });

    it('a no-session Anthropic pick respawns this tab with the picked model without ever queuing (SPEED-544)', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(store.pendingModelOverride()).toBeNull();
      expect(invokeSpy.mock.calls.map(([cmd]) => cmd)).not.toContain('set_model_pin');
      const startCall = invokeSpy.mock.calls.find(([cmd]) => cmd === 'start_chat');
      expect(startCall?.[1]).toEqual({
        project: 'test',
        tabId: store.tabId,
        model: 'claude-haiku-4-5',
      });
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

      const resume = store.resumeConversation('old-sess');
      await new Promise((r) => setTimeout(r, 0));
      store.resetForNewConversation();
      resolveTranscript!({
        session_id: 'old-sess',
        messages: [{ role: 'assistant', content: 'old reply', timestamp: null }],
      });
      await resume;
      await new Promise((r) => setTimeout(r, 0));

      expect(store.messagesFromState()).toHaveLength(0);
      expect(store.lastKnownSessionId).toBeNull();
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

      await store.resumeConversation('old-sess');

      expect(store.messagesFromState()).toHaveLength(1);
      expect(store.lastKnownSessionId).toBe('old-sess');
    });

    it('SystemInit never flushes a queued mid-stream pick; only Result (turn end) does', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      store.isStreaming = true;
      invokeSpy.mockClear();

      await store.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');

      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-restart' },
      });
      await Promise.resolve();
      let modelSend = invokeSpy.mock.calls.find(([cmd]) => cmd === 'switch_chat_model');
      expect(modelSend).toBeUndefined();
      expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');

      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-restart' },
      } as never);
      await vi.waitFor(() => {
        modelSend = invokeSpy.mock.calls.find(([cmd]) => cmd === 'switch_chat_model');
        expect(modelSend).toBeDefined();
      });
      expect(JSON.stringify(modelSend?.[1])).toContain('"model":"claude-haiku-4-5"');
      expect(store.pendingModelOverride()).toBeNull();
    });

    it('applyEffortSelection applies nothing and sets an error when the pin write fails', async () => {
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        if (cmd === 'set_effort_pin') throw new Error('locked config');
        return undefined;
      });

      await store.applyEffortSelection('low');

      expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
      expect(indexOfCall(invokeSpy.mock.calls, wiredEffortInput)).toBe(-1);
      expect(store.modelSelectionError()).toContain('locked config');
    });

    it('applyEffortSelection mid-stream queues the pick and applies it after the turn', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();
      store.isStreaming = true;

      await store.applyEffortSelection('xhigh');
      expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);

      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-live' },
      } as never);
      await vi.waitFor(() => {
        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('xhigh'))).toBeGreaterThan(-1);
      });
      expect(indexOfCall(invokeSpy.mock.calls, wiredEffortInput)).toBe(-1);
    });

    it('applyEffortSelection in a conversation writes the pin, then applies it as a control request with no /effort input', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-live' },
      } as never);
      await Promise.resolve();
      expect(store.hasConversation()).toBe(true);
      const messagesBefore = store.messagesFromState().length;
      invokeSpy.mockClear();

      await store.applyEffortSelection('low');

      const calls = invokeSpy.mock.calls;
      const pinCallIdx = indexOfCall(calls, (cmd) => cmd === 'set_effort_pin');
      expect(pinCallIdx).toBeGreaterThanOrEqual(0);
      expect(indexOfCall(calls, appliedEffort('low'))).toBeGreaterThan(pinCallIdx);
      expect(indexOfCall(calls, wiredEffortInput)).toBe(-1);
      expect(indexOfCall(calls, (cmd) => cmd === 'resume_conversation')).toBe(-1);
      expect(indexOfCall(calls, (cmd) => cmd === 'get_conversation')).toBe(-1);
      expect(store.messagesFromState()).toHaveLength(messagesBefore);
      expect(store.isStreaming).toBe(false);
      expect(store.deferredEffort()).toBeNull();
    });

    function indexOfCall(calls: unknown[][], match: (cmd: string, args: unknown) => boolean) {
      return calls.findIndex(([cmd, args]) => match(cmd as string, args));
    }
    const wiredEffortInput = (cmd: string, args: unknown) =>
      cmd === 'send_message' && JSON.stringify(args).includes('/effort');

    const appliedEffort = (level: string) => (cmd: string, args: unknown) =>
      cmd === 'apply_chat_effort' &&
      JSON.stringify(args) === JSON.stringify({ project: 'test', tabId: store.tabId, level });

    it('applyEffortSelection without a live session respawns the idle pre-first-turn process', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await store.init();
      await new Promise((r) => setTimeout(r, 0));
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyEffortSelection('low');
      await new Promise((r) => setTimeout(r, 0));

      expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'set_effort_pin')).toBeGreaterThan(
        -1
      );
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat').length).toBeGreaterThan(
        0
      );
      expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
      expect(indexOfCall(invokeSpy.mock.calls, wiredEffortInput)).toBe(-1);
    });

    it('applyEffortSelection in a chat with neither a session id nor a conversation respawns it', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      expect(store.hasConversation()).toBe(false);
      expect(store.lastKnownSessionId).toBeNull();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyEffortSelection('low');
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
      expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
    });

    it('applyEffortSelection on a session with an id but no conversation yet applies it without a respawn', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-fable-5', session_id: 'sess-idle' },
      });
      await Promise.resolve();
      expect(store.hasConversation()).toBe(false);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyEffortSelection('low');
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(
        indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')
      ).toBeGreaterThan(-1);
    });

    it('applyEffortSelection while the first turn streams before any session id queues it for the turn end', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.isStreaming = true;

      await store.applyEffortSelection('max');
      expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);

      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-5', session_id: 'sess-first' },
      });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-first' },
      } as never);
      await vi.waitFor(() => {
        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
      });
    });

    describe('an effort pick on a live conversation (SPEED-707)', () => {
      const LIVE = 'sess-live';

      function liveConversation(apply: () => Promise<unknown> = async () => undefined): void {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        TestBed.inject(ProjectStateService).status.set('ready');
        mockTauri.invokeHandler = async (cmd: string) =>
          cmd === 'apply_chat_effort' ? apply() : undefined;
        store.handleStreamChunk({
          chunk_type: 'SystemInit',
          data: { model: 'claude-fable-5', session_id: LIVE },
        });
        store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
      }

      function overrideInvoke(cmd: string, answer: () => Promise<unknown>): void {
        const base = mockTauri.invokeHandler;
        mockTauri.invokeHandler = async (c, args) => (c === cmd ? answer() : base(c, args));
      }

      const rejected = (message: string) => async () => {
        throw new Error(message);
      };
      const switchedModel = (cmd: string) => cmd === 'switch_chat_model';
      const restarted = (cmd: string) => cmd === 'resume_conversation';

      it('takes the pick live: no notice, no chip, no turn and no restart', async () => {
        liveConversation();
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.applyEffortSelection('low');

        const calls = invokeSpy.mock.calls;
        expect(indexOfCall(calls, appliedEffort('low'))).toBeGreaterThan(-1);
        expect(indexOfCall(calls, restarted)).toBe(-1);
        expect(store.deferredEffort()).toBeNull();
        expect(store.messagesFromState()).toHaveLength(1);
        expect(store.isStreaming).toBe(false);
      });

      it('keeps the pin and shows the notice when Claude Code rejects the pick', async () => {
        liveConversation(rejected('Claude Code rejected the control request: nope'));
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.applyEffortSelection('low');

        const calls = invokeSpy.mock.calls;
        expect(indexOfCall(calls, (cmd) => cmd === 'set_effort_pin')).toBeGreaterThan(-1);
        expect(indexOfCall(calls, appliedEffort('low'))).toBeGreaterThan(-1);
        expect(indexOfCall(calls, restarted)).toBe(-1);
        expect(store.deferredEffort()).toBe('low');
        expect(store.messagesFromState()).toHaveLength(1);
      });

      it('shows the notice when the pick times out', async () => {
        liveConversation(
          rejected("control request 'apply_flag_settings' got no response within 10000 ms")
        );
        await Promise.resolve();

        await store.applyEffortSelection('medium');

        expect(store.deferredEffort()).toBe('medium');
      });

      it('shows the notice when no live process takes the pick', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();

        await store.applyEffortSelection('high');

        expect(store.deferredEffort()).toBe('high');
      });

      it('warns when the pick fails, naming the command', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();

        await store.applyEffortSelection('medium');

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('apply_chat_effort failed')
        );
      });

      it('a later pick the session takes clears the notice', async () => {
        let applies = 0;
        liveConversation(async () => {
          applies += 1;
          if (applies === 1) throw new Error('no active session');
          return undefined;
        });
        await Promise.resolve();

        await store.applyEffortSelection('low');
        expect(store.deferredEffort()).toBe('low');
        await store.applyEffortSelection('max');

        expect(store.deferredEffort()).toBeNull();
      });

      it('a later failed pick replaces the deferred level', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();

        await store.applyEffortSelection('low');
        await store.applyEffortSelection('max');

        expect(store.deferredEffort()).toBe('max');
      });

      it('Restart now resumes the conversation, which launches with the pin, and clears the notice', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();
        await store.applyEffortSelection('max');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.restartForDeferredEffort();

        expect(invokeSpy).toHaveBeenCalledWith('resume_conversation', {
          project: 'test',
          sessionId: LIVE,
          tabId: store.tabId,
          model: null,
        });
        expect(store.deferredEffort()).toBeNull();
        expect(store.lastKnownSessionId).toBe(LIVE);
      });

      it('Restart now does nothing while the project is not ready', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();
        await store.applyEffortSelection('max');
        TestBed.inject(ProjectStateService).status.set('switching');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.restartForDeferredEffort();

        expect(indexOfCall(invokeSpy.mock.calls, restarted)).toBe(-1);
      });

      it('Restart now does nothing while a turn streams', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();
        await store.applyEffortSelection('max');
        store.isStreaming = true;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.restartForDeferredEffort();

        expect(indexOfCall(invokeSpy.mock.calls, restarted)).toBe(-1);
        expect(store.deferredEffort()).toBe('max');
      });

      it('a start of a new process clears the notice, since that spawn carries the pin', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();
        await store.applyEffortSelection('max');
        expect(store.deferredEffort()).toBe('max');
        store.clearSessionTracking();
        TestBed.inject(ProjectStateService).status.set('ready');

        await store.init();
        await new Promise((r) => setTimeout(r, 0));

        expect(store.deferredEffort()).toBeNull();
      });

      it('a send that restarts a dead process clears the notice', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();
        await store.applyEffortSelection('max');
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

        await store.sendMessage('next question');

        expect(sends).toBe(2);
        expect(store.deferredEffort()).toBeNull();
      });

      it('a new conversation clears the notice', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();
        await store.applyEffortSelection('max');

        store.resetForNewConversation();

        expect(store.deferredEffort()).toBeNull();
      });

      it('a pick made mid-stream is applied when the turn ends, and a failure then shows the notice', async () => {
        liveConversation(rejected('no active session'));
        await Promise.resolve();
        store.isStreaming = true;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.applyEffortSelection('xhigh');
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        expect(store.deferredEffort()).toBeNull();

        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await vi.waitFor(() => {
          expect(store.deferredEffort()).toBe('xhigh');
        });
        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('xhigh'))).toBeGreaterThan(-1);
      });

      it('applies a pick while a queued message is about to drain, since nothing is restarted', async () => {
        liveConversation();
        store._setState({ pendingQueue: { text: 'next question', queued_at: 1 } });
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.applyEffortSelection('medium');

        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('medium'))).toBeGreaterThan(-1);
      });

      it('never ends the turn of a queued message that drains while the pick is applied', async () => {
        const answer = createDeferred<void>();
        liveConversation(() => answer.promise);
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('low');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('low'))).toBeGreaterThan(-1);
        });
        store.handleStreamChunk({
          chunk_type: 'QueueDrained',
          data: { text: 'next question' },
        } as never);
        answer.resolve();
        await new Promise((r) => setTimeout(r, 0));

        expect(store.isStreaming).toBe(true);
        expect(store.isStreamingFromState()).toBe(true);
        const texts = store.messagesFromState().map((m) => JSON.stringify(m.blocks));
        expect(texts.some((t) => t.includes('next question'))).toBe(true);
        expect(store.deferredEffort()).toBeNull();
      });

      it('applies only the latest of two quick picks', async () => {
        liveConversation();
        const firstPin = createDeferred<void>();
        let pinWrites = 0;
        overrideInvoke('set_effort_pin', async () => {
          pinWrites += 1;
          if (pinWrites === 1) await firstPin.promise;
        });
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const first = store.applyEffortSelection('low');
        const second = store.applyEffortSelection('max');
        firstPin.resolve();
        await Promise.all([first, second]);

        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('low'))).toBe(-1);
      });

      it('writes the pins in pick order, so the latest pick is the pin a new session gets', async () => {
        liveConversation();
        const firstPin = createDeferred<void>();
        const written: string[] = [];
        overrideInvoke('set_effort_pin', async () => undefined);
        const base = mockTauri.invokeHandler;
        mockTauri.invokeHandler = async (cmd, args) => {
          if (cmd !== 'set_effort_pin') return base(cmd, args);
          const level = (args as { level: string }).level;
          if (level === 'low') await firstPin.promise;
          written.push(level);
          return undefined;
        };
        await Promise.resolve();

        const first = store.applyEffortSelection('low');
        const second = store.applyEffortSelection('max');
        await new Promise((r) => setTimeout(r, 0));
        expect(written).toEqual([]);
        firstPin.resolve();
        await Promise.all([first, second]);

        expect(written).toEqual(['low', 'max']);
      });

      it('a queued pick superseded by a newer one that is still saving is never sent', async () => {
        liveConversation();
        const maxPin = createDeferred<void>();
        const base = mockTauri.invokeHandler;
        mockTauri.invokeHandler = async (cmd, args) => {
          if (cmd === 'set_effort_pin' && (args as { level: string }).level === 'max') {
            await maxPin.promise;
            return undefined;
          }
          return base(cmd, args);
        };
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('low');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const newer = store.applyEffortSelection('max');
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await new Promise((r) => setTimeout(r, 0));
        maxPin.resolve();
        await newer;
        await new Promise((r) => setTimeout(r, 0));

        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('low'))).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
      });

      it('when the newest pick cannot be saved, the session gets the level the pin holds', async () => {
        liveConversation();
        const lowPin = createDeferred<void>();
        const base = mockTauri.invokeHandler;
        mockTauri.invokeHandler = async (cmd, args) => {
          if (cmd === 'set_effort_pin') {
            const level = (args as { level: string }).level;
            if (level === 'low') {
              await lowPin.promise;
              return undefined;
            }
            throw new Error('config is locked');
          }
          if (cmd === 'get_effort_pin') return 'low';
          return base(cmd, args);
        };
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const first = store.applyEffortSelection('low');
        const second = store.applyEffortSelection('max');
        lowPin.resolve();
        await Promise.all([first, second]);

        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBe(-1);
        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'apply_chat_effort')).toEqual([
          ['apply_chat_effort', { project: 'test', tabId: store.tabId, level: 'low' }],
        ]);
        expect(store.modelSelectionError()).toContain('config is locked');
      });

      it('a pick answered after the project changed shows no notice on the new project', async () => {
        const answer = createDeferred<void>();
        liveConversation(() => answer.promise);
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyEffortSelection('low');
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('low'))).toBeGreaterThan(-1);
        });
        TestBed.inject(ProjectStateService).activeProject.set('other');
        answer.reject(new Error("control request 'apply_flag_settings' got no response"));
        await pick;

        expect(store.deferredEffort()).toBeNull();
      });

      it('a pick waiting behind another is never sent once the project changed', async () => {
        const answer = createDeferred<void>();
        let applies = 0;
        liveConversation(async () => {
          applies += 1;
          if (applies === 1) await answer.promise;
        });
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const first = store.applyEffortSelection('low');
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('low'))).toBeGreaterThan(-1);
        });
        const second = store.applyEffortSelection('max');
        await vi.waitFor(() => {
          expect(
            indexOfCall(
              invokeSpy.mock.calls,
              (cmd, args) => cmd === 'set_effort_pin' && (args as { level: string }).level === 'max'
            )
          ).toBeGreaterThan(-1);
        });
        await new Promise((r) => setTimeout(r, 0));
        TestBed.inject(ProjectStateService).activeProject.set('other');
        answer.resolve();
        await Promise.all([first, second]);

        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'apply_chat_effort')).toEqual([
          ['apply_chat_effort', { project: 'test', tabId: store.tabId, level: 'low' }],
        ]);
        expect(store.deferredEffort()).toBeNull();
      });

      it('a pick made before a project change is saved for its own project and never queued for the new one', async () => {
        liveConversation();
        const pin = createDeferred<void>();
        overrideInvoke('set_effort_pin', () => pin.promise);
        await Promise.resolve();
        store.isStreaming = true;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyEffortSelection('max');
        TestBed.inject(ProjectStateService).activeProject.set('other');
        pin.resolve();
        await pick;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await new Promise((r) => setTimeout(r, 0));

        expect(invokeSpy).toHaveBeenCalledWith('set_effort_pin', {
          projectId: 'test',
          level: 'max',
        });
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
      });

      it('Stop sends the effort and model picks made during the stopped turn at once', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('xhigh');
        await store.applyModelSelection({
          catalogId: 'claude-haiku-4-5',
          wireId: 'claude-haiku-4-5',
          providerId: 'anthropic',
          kind: 'anthropic_oauth',
          isDefault: false,
          contextTokens: null,
        });
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);

        await store.stopConversation();

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('xhigh'))).toBeGreaterThan(-1);
        });
        const calls = invokeSpy.mock.calls;
        const stopped = indexOfCall(calls, (cmd) => cmd === 'stop_chat');
        expect(stopped).toBeGreaterThan(-1);
        expect(indexOfCall(calls, appliedEffort('xhigh'))).toBeGreaterThan(stopped);
        expect(indexOfCall(calls, switchedModel)).toBeGreaterThan(stopped);
        expect(store.pendingModelOverride()).toBeNull();
      });

      it('a Stop that fails keeps the picks for the end of the still running turn', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('xhigh');
        overrideInvoke('stop_chat', rejected('failed to write interrupt control_request'));
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.stopConversation();
        await new Promise((r) => setTimeout(r, 0));

        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
      });

      const haikuPick = {
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      };

      it('a pick answered while a project switch runs raises no notice', async () => {
        const answer = createDeferred<void>();
        liveConversation(() => answer.promise);
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyEffortSelection('max');
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
        TestBed.inject(ProjectStateService).status.set('switching');
        answer.reject(new Error('chat session ended before the control response'));
        await pick;

        expect(store.deferredEffort()).toBeNull();
      });

      it('a pick saved while a project switch runs is neither sent nor starts a session', async () => {
        liveConversation();
        const pin = createDeferred<void>();
        overrideInvoke('set_effort_pin', () => pin.promise);
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyEffortSelection('low');
        TestBed.inject(ProjectStateService).status.set('switching');
        pin.resolve();
        await pick;

        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBe(-1);
      });

      it('a pick made before a project switch that failed back is neither sent nor starts a session', async () => {
        const projectState = TestBed.inject(ProjectStateService);
        await projectState.init();
        liveConversation();
        const pin = createDeferred<void>();
        overrideInvoke('set_effort_pin', () => pin.promise);
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyEffortSelection('low');
        mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
        mockTauri.dispatchEvent('project_switch_failed', {
          project: 'test',
          error: 'switch failed',
        });
        expect(projectState.isSettledOn('test')).toBe(true);
        pin.resolve();
        await pick;
        await new Promise((r) => setTimeout(r, 0));

        const calls = invokeSpy.mock.calls;
        expect(indexOfCall(calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        expect(indexOfCall(calls, (cmd) => cmd === 'start_chat')).toBe(-1);
        expect(store.modelSelectionError()).toBe('');
        expect(projectState.error).toBe('switch failed');
      });

      it('a model switch confirmed across a project switch that failed back is saved, with no chip and no error', async () => {
        const projectState = TestBed.inject(ProjectStateService);
        await projectState.init();
        liveConversation();
        const answer = createDeferred<ModelSwitchOutcome>();
        overrideInvoke('switch_chat_model', () => answer.promise);
        await Promise.resolve();
        const messagesBefore = store.messagesFromState().length;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyModelSelection(haikuPick);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
        });
        mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
        mockTauri.dispatchEvent('project_switch_failed', {
          project: 'test',
          error: 'switch failed',
        });
        answer.resolve({ outcome: 'confirmed' });
        await pick;

        expect(store.tabModel()).toBe('claude-haiku-4-5');
        expect(store.messagesFromState()).toHaveLength(messagesBefore);
        expect(store.modelSelectionError()).toBe('');
      });

      it('a model switch answered while a project switch runs adds no chip and no error', async () => {
        liveConversation();
        const answer = createDeferred<void>();
        overrideInvoke('switch_chat_model', () => answer.promise);
        await Promise.resolve();
        const messagesBefore = store.messagesFromState().length;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyModelSelection(haikuPick);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
        });
        TestBed.inject(ProjectStateService).status.set('switching');
        answer.reject(new Error('chat session ended before the control response'));
        await pick;

        expect(store.messagesFromState()).toHaveLength(messagesBefore);
        expect(store.modelSelectionError()).toBe('');
      });

      it('a superseded pick whose pin cannot be saved reports nothing', async () => {
        liveConversation();
        const lowPin = createDeferred<void>();
        const base = mockTauri.invokeHandler;
        mockTauri.invokeHandler = async (cmd, args) => {
          if (cmd === 'set_effort_pin' && (args as { level: string }).level === 'low') {
            await lowPin.promise;
            throw new Error('config is locked');
          }
          return base(cmd, args);
        };
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const first = store.applyEffortSelection('low');
        const second = store.applyEffortSelection('max');
        lowPin.resolve();
        await Promise.all([first, second]);

        expect(store.modelSelectionError()).toBe('');
        expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
      });

      function freshStart(): {
        started: ReturnType<typeof createDeferred<void>>;
        starting: Promise<void>;
      } {
        const projectState = TestBed.inject(ProjectStateService);
        projectState.activeProject.set('test');
        projectState.status.set('ready');
        const started = createDeferred<void>();
        mockTauri.invokeHandler = async (cmd: string) =>
          cmd === 'start_chat' ? started.promise : undefined;
        return { started, starting: store.startNewConversation() };
      }

      it('an effort pick made while a fresh session starts is sent to it once the start completes, before any turn', async () => {
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const { started, starting } = freshStart();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyEffortSelection('low');
        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        started.resolve();
        await starting;

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('low'))).toBeGreaterThan(-1);
        });
        expect(store.lastKnownSessionId).toBeNull();
        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'send_message')).toHaveLength(0);
      });

      it('Restart now on the notice of a fresh session without an id respawns that session', async () => {
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const { started, starting } = freshStart();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });
        await store.applyEffortSelection('low');
        overrideInvoke('apply_chat_effort', rejected('chat session ended before the response'));
        started.resolve();
        await starting;
        await vi.waitFor(() => expect(store.deferredEffort()).toBe('low'));
        expect(store.lastKnownSessionId).toBeNull();

        await store.restartForDeferredEffort();

        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(2);
        expect(indexOfCall(invokeSpy.mock.calls, restarted)).toBe(-1);
        expect(store.deferredEffort()).toBeNull();
      });

      it('a model pick made while a fresh session starts is switched once the start completes', async () => {
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const { started, starting } = freshStart();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyModelSelection(haikuPick);
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
        expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBe(-1);
        started.resolve();
        await starting;

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
        });
        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
        expect(store.pendingModelOverride()).toBeNull();
      });

      it('a routed model pick made while a fresh session starts re-renders the containers and respawns once the start completes', async () => {
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const { started, starting } = freshStart();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyModelSelection({
          catalogId: 'llama4',
          wireId: 'my-ollama/llama4',
          providerId: 'my-ollama',
          kind: 'local',
          isDefault: false,
          contextTokens: null,
        });
        expect(store.pendingModelOverride()).toBe('my-ollama/llama4');
        started.resolve();
        await starting;

        await vi.waitFor(() => {
          expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(2);
        });
        const calls = invokeSpy.mock.calls;
        const rerender = indexOfCall(calls, (cmd) => cmd === 'restart_integration_containers');
        const starts = calls.flatMap(([cmd], i) => (cmd === 'start_chat' ? [i] : []));
        expect(rerender).toBeGreaterThan(starts[0]);
        expect(starts[1]).toBeGreaterThan(rerender);
        expect(indexOfCall(calls, switchedModel)).toBe(-1);
        expect(store.pendingModelOverride()).toBeNull();
      });

      it('a model pick queued while sign-in refuses a new conversation never undoes a later pick', async () => {
        liveConversation();
        await Promise.resolve();
        const start = createDeferred<void>();
        overrideInvoke('start_chat', () => start.promise);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const starting = store.startNewConversation();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyModelSelection(haikuPick);
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
        start.reject(new Error(`${SESSION_KEPT_MARKER}: Claude is not authenticated.`));
        await expect(starting).rejects.toThrow();
        expect(store.lastKnownSessionId).toBe(LIVE);
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');

        await store.applyModelSelection({
          ...haikuPick,
          catalogId: 'claude-sonnet-5',
          wireId: 'claude-sonnet-5',
        });
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await new Promise((r) => setTimeout(r, 0));

        const switched = invokeSpy.mock.calls
          .filter(([cmd]) => cmd === 'switch_chat_model')
          .map(([, args]) => (args as { model: string }).model);
        expect(switched).toEqual(['claude-sonnet-5']);
      });

      it('an effort pick queued while sign-in refuses a new conversation reaches the earlier session at its next turn end', async () => {
        liveConversation();
        await Promise.resolve();
        const start = createDeferred<void>();
        overrideInvoke('start_chat', () => start.promise);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const starting = store.startNewConversation();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyEffortSelection('max');
        start.reject(new Error(`${SESSION_KEPT_MARKER}: Claude is not authenticated.`));
        await expect(starting).rejects.toThrow();
        expect(store.lastKnownSessionId).toBe(LIVE);
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
      });

      it('a pick queued while a new conversation fails to spawn is dropped: the earlier process is already stopped', async () => {
        liveConversation();
        await Promise.resolve();
        const start = createDeferred<void>();
        overrideInvoke('start_chat', () => start.promise);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const starting = store.startNewConversation();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyEffortSelection('max');
        await store.applyModelSelection(haikuPick);
        start.reject(new Error('failed to spawn claude'));
        await expect(starting).rejects.toThrow(NEW_CONVERSATION_FAILED);

        expect(store.lastKnownSessionId).toBe(LIVE);
        expect(store.pendingModelOverride()).toBeNull();
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await new Promise((r) => setTimeout(r, 0));
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBe(-1);
      });

      it('the fresh start after a container restart drops the picks when sign-in refuses it: the restart ended the earlier session', async () => {
        liveConversation();
        await Promise.resolve();
        const start = createDeferred<void>();
        overrideInvoke('start_chat', () => start.promise);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const fresh = (
          store as unknown as { startFreshSession(): Promise<void> }
        ).startFreshSession();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyModelSelection(haikuPick);
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
        start.reject(new Error(`${SESSION_KEPT_MARKER}: Claude is not authenticated.`));
        await fresh;

        expect(store.pendingModelOverride()).toBeNull();
      });

      it('a pick queued while a new conversation waits for images the backend kept the session for reaches it at its next turn end', async () => {
        liveConversation();
        await Promise.resolve();
        const start = createDeferred<void>();
        overrideInvoke('start_chat', () => start.promise);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const starting = store.startNewConversation();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyEffortSelection('max');
        start.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await expect(starting).rejects.toThrow(NEW_CONVERSATION_FAILED);
        expect(store.lastKnownSessionId).toBe(LIVE);
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
      });

      function resumeStarting(): {
        resumed: ReturnType<typeof createDeferred<void>>;
        resuming: Promise<void>;
        invokeSpy: ReturnType<typeof vi.spyOn>;
      } {
        const resumed = createDeferred<void>();
        overrideInvoke('resume_conversation', () => resumed.promise);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        return { resumed, resuming: store.resumeConversation('sess-older'), invokeSpy };
      }

      it('a resume the backend refused before it stopped the running session returns to it and keeps the queued picks', async () => {
        liveConversation();
        await Promise.resolve();
        const { resumed, resuming, invokeSpy } = resumeStarting();
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'resume_conversation')
          ).toBeGreaterThan(-1);
        });

        await store.applyEffortSelection('max');
        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await resuming;

        expect(store.lastKnownSessionId).toBe(LIVE);
        const shown = store.messagesFromState().flatMap((m) => m.blocks);
        expect(JSON.stringify(shown)).toContain('container images are still building');
        expect(JSON.stringify(shown)).not.toContain(SESSION_KEPT_MARKER);
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
      });

      function queueWhileStreaming(): Promise<void> {
        store.isStreaming = true;
        return store.applyModelSelection(haikuPick).then(() => store.applyEffortSelection('max'));
      }

      function switchedModels(calls: unknown[][]): string[] {
        return calls
          .filter(([cmd]) => cmd === 'switch_chat_model')
          .map(([, args]) => (args as { model: string }).model);
      }

      function pinStore(initial: string | null): () => string | null {
        (store as unknown as { _tabModel: { set(model: string | null): void } })._tabModel.set(
          initial
        );
        return () => store.tabModel();
      }

      const touchesProjectPin = (cmd: string) => cmd.endsWith('_model_pin');

      function launchModelOf(calls: unknown[][], command: string): unknown {
        const call = calls.find(([cmd]) => cmd === command);
        return (call?.[1] as { model?: unknown } | undefined)?.model;
      }

      it('a pick queued while a turn streamed survives a resume the backend kept and reaches that session at its next turn end', async () => {
        liveConversation();
        await Promise.resolve();
        await queueWhileStreaming();
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
        const { resumed, resuming, invokeSpy } = resumeStarting();
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'resume_conversation')
          ).toBeGreaterThan(-1);
        });

        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await resuming;

        expect(store.lastKnownSessionId).toBe(LIVE);
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
        expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
        expect(switchedModels(invokeSpy.mock.calls)).toEqual(['claude-haiku-4-5']);
        expect(store.pendingModelOverride()).toBeNull();
      });

      it('a model pick made during a kept resume wins over the one queued while the turn streamed', async () => {
        liveConversation();
        await Promise.resolve();
        await queueWhileStreaming();
        const { resumed, resuming, invokeSpy } = resumeStarting();
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'resume_conversation')
          ).toBeGreaterThan(-1);
        });
        await store.applyModelSelection({
          ...haikuPick,
          catalogId: 'claude-sonnet-5',
          wireId: 'claude-sonnet-5',
        });

        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await resuming;
        expect(store.pendingModelOverride()).toBe('claude-sonnet-5');
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });

        expect(switchedModels(invokeSpy.mock.calls)).toEqual(['claude-sonnet-5']);
      });

      it('a resume the backend carried out drops the picks queued while a turn streamed: the resumed process launches with their pins', async () => {
        liveConversation();
        await Promise.resolve();
        const pin = pinStore('claude-fable-5');
        await queueWhileStreaming();
        const { resumed, resuming, invokeSpy } = resumeStarting();
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'resume_conversation')
          ).toBeGreaterThan(-1);
        });
        const calls = invokeSpy.mock.calls;
        expect(launchModelOf(calls, 'resume_conversation')).toBe('claude-haiku-4-5');
        expect(indexOfCall(calls, touchesProjectPin)).toBe(-1);

        resumed.resolve();
        await resuming;

        expect(store.lastKnownSessionId).toBe('sess-older');
        expect(store.pendingModelOverride()).toBeNull();
        store.isStreaming = true;
        store.handleStreamChunk({
          chunk_type: 'Result',
          data: { session_id: 'sess-older' },
        } as never);
        await new Promise((r) => setTimeout(r, 0));
        expect(indexOfCall(calls, switchedModel)).toBe(-1);
        expect(indexOfCall(calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        expect(indexOfCall(calls, touchesProjectPin)).toBe(-1);
        expect(pin()).toBe('claude-haiku-4-5');
      });

      const sonnetPick = { ...haikuPick, catalogId: 'claude-sonnet-5', wireId: 'claude-sonnet-5' };

      async function keptResumeOfAQueuedHaikuPick(): Promise<{
        pin: () => string | null;
        invokeSpy: ReturnType<typeof vi.spyOn>;
      }> {
        liveConversation();
        await Promise.resolve();
        const pin = pinStore(null);
        await store.applyModelSelection(sonnetPick);
        expect(pin()).toBe('claude-sonnet-5');
        await queueWhileStreaming();
        const { resumed, resuming, invokeSpy } = resumeStarting();
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'resume_conversation')
          ).toBeGreaterThan(-1);
        });
        expect(pin()).toBe('claude-haiku-4-5');
        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await resuming;
        await vi.waitFor(() => expect(pin()).toBe('claude-sonnet-5'));
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
        return { pin, invokeSpy };
      }

      function turnEnds(): void {
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
      }

      it('a restored pick Claude Code refuses after a kept resume leaves the pin and the badge on the model the session runs', async () => {
        const { pin, invokeSpy } = await keptResumeOfAQueuedHaikuPick();
        overrideInvoke('switch_chat_model', async () => ({
          outcome: 'refused',
          reason: 'model not available',
        }));

        turnEnds();

        await vi.waitFor(() => {
          expect(store.pickedModel()).toBe('claude-sonnet-5');
        });
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
        expect(pin()).toBe('claude-sonnet-5');
        expect(store.modelSelectionError()).toBe(modelSwitchRefused('model not available'));
      });

      it('a restored pick Claude Code confirms after a kept resume saves its pin again', async () => {
        const { pin, invokeSpy } = await keptResumeOfAQueuedHaikuPick();

        turnEnds();

        await vi.waitFor(() => expect(pin()).toBe('claude-haiku-4-5'));
        expect(switchedModels(invokeSpy.mock.calls)).toEqual(['claude-haiku-4-5']);
        expect(store.pickedModel()).toBe('claude-haiku-4-5');
      });

      it('the write-back after a kept resume never undoes a switch the session confirmed after the resume began', async () => {
        liveConversation();
        await Promise.resolve();
        const pin = pinStore(null);
        const sonnetAnswer = createDeferred<ModelSwitchOutcome>();
        let asked = false;
        overrideInvoke('switch_chat_model', () => {
          asked = true;
          return sonnetAnswer.promise;
        });
        const switching = store.applyModelSelection(sonnetPick);
        await vi.waitFor(() => expect(asked).toBe(true));
        await queueWhileStreaming();
        const { resumed, resuming, invokeSpy } = resumeStarting();
        await vi.waitFor(() => expect(pin()).toBe('claude-haiku-4-5'));

        sonnetAnswer.resolve({ outcome: 'confirmed' });
        await switching;
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'resume_conversation')
          ).toBeGreaterThan(-1);
        });
        expect(pin()).toBe('claude-sonnet-5');
        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await resuming;
        await new Promise((r) => setTimeout(r, 0));

        expect(indexOfCall(invokeSpy.mock.calls, touchesProjectPin)).toBe(-1);
        expect(pin()).toBe('claude-sonnet-5');
      });

      it('a routed pick refused after a kept resume leaves the provider on the model the session runs', async () => {
        liveConversation();
        await Promise.resolve();
        const provider: { model: string; contextTokens: number | null } = {
          model: 'qwen3',
          contextTokens: 8192,
        };
        const base = mockTauri.invokeHandler;
        mockTauri.invokeHandler = async (cmd, args) => {
          if (cmd === 'get_llm_config') {
            return {
              provider: 'my-ollama',
              model: provider.model,
              base_url: null,
              default_base_url: null,
              providers: [
                {
                  id: 'my-ollama',
                  kind: 'local',
                  model: provider.model,
                  context_tokens: provider.contextTokens,
                },
              ],
            };
          }
          if (cmd === 'set_provider_model') {
            const written = args as { model: string; contextTokens: number | null };
            provider.model = written.model;
            provider.contextTokens = written.contextTokens;
            return undefined;
          }
          return base(cmd, args);
        };
        store.isStreaming = true;
        await store.applyModelSelection({
          catalogId: 'llama4',
          wireId: 'my-ollama/llama4',
          providerId: 'my-ollama',
          kind: 'local',
          isDefault: false,
          contextTokens: 262_144,
        });
        const { resumed, resuming } = resumeStarting();
        await vi.waitFor(() => expect(provider.model).toBe('llama4'));

        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await resuming;
        await vi.waitFor(() => expect(provider).toEqual({ model: 'qwen3', contextTokens: 8192 }));
        overrideInvoke('switch_chat_model', async () => ({
          outcome: 'refused',
          reason: 'model is still loading',
        }));
        turnEnds();

        await vi.waitFor(() => {
          expect(store.modelSelectionError()).toBe(modelSwitchRefused('model is still loading'));
        });
        expect(provider).toEqual({ model: 'qwen3', contextTokens: 8192 });
      });

      it('a New chat the backend kept writes back the pin its reset saved for a queued pick', async () => {
        liveConversation();
        await Promise.resolve();
        const pin = pinStore('opus');
        store.isStreaming = true;
        await store.applyModelSelection(haikuPick);
        store.handleStreamChunk({ chunk_type: 'Error', data: { content: 'upstream hiccup' } });
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
        overrideInvoke(
          'start_chat',
          rejected(`${SESSION_KEPT_MARKER}: container images are still building`)
        );
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_FAILED);

        await vi.waitFor(() => expect(pin()).toBe('opus'));
        const calls = invokeSpy.mock.calls;
        expect(launchModelOf(calls, 'start_chat')).toBe('claude-haiku-4-5');
        expect(indexOfCall(calls, touchesProjectPin)).toBe(-1);
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
      });

      it('a resume that fails after the running session stopped drops the queued picks', async () => {
        liveConversation();
        await Promise.resolve();
        const { resumed, resuming, invokeSpy } = resumeStarting();
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'resume_conversation')
          ).toBeGreaterThan(-1);
        });

        await store.applyEffortSelection('max');
        resumed.reject(new Error('failed to spawn claude'));
        await resuming;

        expect(store.lastKnownSessionId).toBe('sess-older');
        store.isStreaming = true;
        store.handleStreamChunk({
          chunk_type: 'Result',
          data: { session_id: 'sess-older' },
        } as never);
        await new Promise((r) => setTimeout(r, 0));
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
      });

      it('a resume the backend refused before it stopped the running session shows that conversation again', async () => {
        liveConversation();
        await Promise.resolve();
        const { resumed, resuming } = resumeStarting();
        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await resuming;

        const shown = JSON.stringify(store.messagesFromState().flatMap((m) => m.blocks));
        expect(shown).toContain('Hello');
        expect(shown).toContain('container images are still building');
        expect(store.sessionStatsFromState()?.session_id).toBe(LIVE);
      });

      it('a sign-in refusal of a resume the backend kept leaves the running conversation on screen', async () => {
        liveConversation();
        await Promise.resolve();
        const { resumed, resuming } = resumeStarting();
        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: Claude is not authenticated.`));
        await resuming;

        expect(store.lastKnownSessionId).toBe(LIVE);
        expect(JSON.stringify(store.messagesFromState())).toContain('Hello');
        expect(store.sessionStatsFromState()?.session_id).toBe(LIVE);
      });

      it('a resume begun while a turn streams stops that turn first and shows it stopped when the backend kept the session', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Half an answer' } });
        const { resumed, resuming, invokeSpy } = resumeStarting();
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'resume_conversation')
          ).toBeGreaterThan(-1);
        });
        const calls = invokeSpy.mock.calls;
        expect(indexOfCall(calls, (cmd) => cmd === 'stop_chat')).toBeGreaterThan(-1);
        expect(indexOfCall(calls, (cmd) => cmd === 'stop_chat')).toBeLessThan(
          indexOfCall(calls, (cmd) => cmd === 'resume_conversation')
        );

        resumed.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));
        await resuming;

        expect(store.isStreaming).toBe(false);
        expect(JSON.stringify(store.messagesFromState())).toContain('Half an answer');
        expect(store.lastKnownSessionId).toBe(LIVE);
      });

      it('a Stop that a container restart overtakes releases no queued pick into the stack being recreated', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('max');
        const stopped = createDeferred<void>();
        const restart = createDeferred<void>();
        overrideInvoke('stop_chat', () => stopped.promise);
        overrideInvoke('restart_integration_containers', () => restart.promise);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const projectState = TestBed.inject(ProjectStateService);

        const stopping = store.stopConversation();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'stop_chat')).toBeGreaterThan(
            -1
          );
        });
        const restarting = projectState.restartContainers('test');
        stopped.resolve();
        await stopping;
        await new Promise((r) => setTimeout(r, 0));

        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        restart.resolve();
        await restarting;
      });

      it('a Stop with no restart running releases the queued pick at once', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('max');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.stopConversation();

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
      });

      it('a resume that stops a streaming turn also waits out a container restart begun during the stop', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        const stopped = createDeferred<void>();
        const restart = createDeferred<void>();
        overrideInvoke('stop_chat', () => stopped.promise);
        overrideInvoke('restart_integration_containers', () => restart.promise);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const projectState = TestBed.inject(ProjectStateService);
        const called = (name: string): number =>
          indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === name);

        const resuming = store.resumeConversation('sess-older');
        await vi.waitFor(() => expect(called('stop_chat')).toBeGreaterThan(-1));
        const restarting = projectState.restartContainers('test');
        stopped.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(called('resume_conversation')).toBe(-1);

        restart.resolve();
        await restarting;
        await resuming;

        expect(called('resume_conversation')).toBeGreaterThan(
          called('restart_integration_containers')
        );
      });

      it('a restored conversation view brings back every field, and a reset clears every one', () => {
        const internals = store as unknown as {
          captureConversationView(): Record<string, unknown>;
          restoreConversationView(view: Record<string, unknown>): void;
        };
        const view: Record<string, unknown> = {
          messages: [{ role: 'user', blocks: [{ type: 'text', content: 'kept' }], timestamp: 1 }],
          currentBlocks: [{ type: 'text', content: 'partial' }],
          isStreaming: true,
          pendingQueue: { text: 'queued', queued_at: 2 },
          sessionStats: {
            session_id: LIVE,
            total_cost: 0.5,
            total_output_tokens: 3,
            context_window_size: 1000,
          },
          model: 'claude-fable-5',
          totalOutputTokens: 3,
          contextWindowSize: 1000,
          contextSnapshot: {
            model: 'claude-fable-5',
            total_tokens: 10,
            max_tokens: 1000,
            percentage: 1,
            categories: [],
          },
          queueAwaitingSession: true,
          initialized: true,
          lastKnownSessionId: LIVE,
          optimisticSessionId: 'sess-optimistic',
          deferredEffort: 'high',
          pendingModelPick: {
            wireId: haikuPick.wireId,
            routed: false,
            project: 'test',
            mark: 0,
            request: 1,
            sel: haikuPick,
            clearsPin: false,
          },
          pendingEffort: { level: 'max', project: 'test', mark: 0, request: 1 },
          confirmedModel: 'claude-sonnet-5',
        };

        internals.restoreConversationView(view);
        expect(internals.captureConversationView()).toEqual(view);

        store.resetForNewConversation();
        const cleared = internals.captureConversationView();
        expect(Object.keys(cleared).sort()).toEqual(Object.keys(view).sort());
        for (const [field, value] of Object.entries(view)) {
          expect(cleared[field], field).not.toEqual(value);
        }
      });

      it('a new conversation the backend refused before it stopped the running session shows that conversation again', async () => {
        liveConversation();
        await Promise.resolve();
        overrideInvoke(
          'start_chat',
          rejected(`${SESSION_KEPT_MARKER}: container images are still building`)
        );

        await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_FAILED);

        expect(JSON.stringify(store.messagesFromState())).toContain('Hello');
        expect(store.sessionStatsFromState()?.session_id).toBe(LIVE);
        expect(store.lastKnownSessionId).toBe(LIVE);
      });

      it('the kept-session prefix never reaches the start error the user reads', async () => {
        liveConversation();
        await Promise.resolve();
        overrideInvoke(
          'start_chat',
          rejected(`${SESSION_KEPT_MARKER}: container images are still building`)
        );

        await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_FAILED);

        const projectState = TestBed.inject(ProjectStateService);
        expect(projectState.error).toContain('container images are still building');
        expect(projectState.error).not.toContain(SESSION_KEPT_MARKER);
      });

      it('a new conversation that fails keeps the effort notice of the session it returns to', async () => {
        liveConversation(rejected('chat session ended before the response'));
        await Promise.resolve();
        await store.applyEffortSelection('low');
        expect(store.deferredEffort()).toBe('low');
        overrideInvoke('start_chat', rejected('failed to spawn claude'));

        await expect(store.startNewConversation()).rejects.toThrow(NEW_CONVERSATION_FAILED);

        expect(store.lastKnownSessionId).toBe(LIVE);
        expect(store.deferredEffort()).toBe('low');
      });

      it("an older model pick's failed switch is not reported, the newer pick's failed save is", async () => {
        liveConversation();
        await Promise.resolve();
        const olderSwitch = createDeferred<ModelSwitchOutcome>();
        let switches = 0;
        overrideInvoke('switch_chat_model', () =>
          ++switches === 1 ? olderSwitch.promise : Promise.resolve({ outcome: 'confirmed' })
        );
        overrideInvoke('set_provider_model', rejected('config.json is locked'));
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const routed = {
          ...haikuPick,
          providerId: 'my-ollama',
          kind: 'local',
        };

        const older = store.applyModelSelection({
          ...routed,
          catalogId: 'llama4',
          wireId: 'my-ollama/llama4',
        });
        await vi.waitFor(() => expect(switches).toBe(1));
        const newer = store.applyModelSelection({
          ...routed,
          catalogId: 'qwen3',
          wireId: 'my-ollama/qwen3',
        });
        olderSwitch.reject(new Error('chat session is busy'));
        await older;
        await newer;

        const saved = invokeSpy.mock.calls
          .filter(([cmd]) => cmd === 'set_provider_model')
          .map(([, args]) => (args as { model: string }).model);
        expect(saved).toEqual(['qwen3']);
        expect(store.modelSelectionError()).toContain('config.json is locked');
      });

      it("an older model pick's failed switch shows no error once a newer pick waits behind it", async () => {
        liveConversation();
        await Promise.resolve();
        const olderSwitch = createDeferred<ModelSwitchOutcome>();
        let switches = 0;
        overrideInvoke('switch_chat_model', () =>
          ++switches === 1 ? olderSwitch.promise : Promise.resolve({ outcome: 'confirmed' })
        );

        const older = store.applyModelSelection(haikuPick);
        await vi.waitFor(() => expect(switches).toBe(1));
        const newer = store.applyModelSelection({
          ...haikuPick,
          catalogId: 'claude-sonnet-5',
          wireId: 'claude-sonnet-5',
        });
        expect(switches).toBe(1);
        olderSwitch.reject(new Error('claude-haiku-4-5 is not available on this plan'));
        await older;
        await newer;

        expect(switches).toBe(2);
        expect(store.modelSelectionError()).toBe('');
      });

      it('a pick queued while a first session fails to start is dropped: the next spawn launches with the pin', async () => {
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const { started, starting } = freshStart();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });

        await store.applyEffortSelection('max');
        await store.applyModelSelection(haikuPick);
        started.reject(new Error('failed to spawn claude'));
        await expect(starting).rejects.toThrow();

        expect(store.lastKnownSessionId).toBeNull();
        expect(store.pendingModelOverride()).toBeNull();
        store.isStreaming = true;
        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);
        await new Promise((r) => setTimeout(r, 0));
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBe(-1);
      });

      it('a model pick superseded before its switch starts is neither switched nor saved', async () => {
        liveConversation();
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const older = store.applyModelSelection(haikuPick);
        const newer = store.applyModelSelection({
          ...haikuPick,
          catalogId: 'claude-sonnet-5',
          wireId: 'claude-sonnet-5',
        });
        await older;
        await newer;

        const models = (command: string): string[] =>
          invokeSpy.mock.calls
            .filter(([cmd]) => cmd === command)
            .map(([, args]) => (args as { model: string }).model);
        expect(models('switch_chat_model')).toEqual(['claude-sonnet-5']);
        expect(store.tabModel()).toBe('claude-sonnet-5');
        expect(indexOfCall(invokeSpy.mock.calls, touchesProjectPin)).toBe(-1);
        expect(store.modelSelectionError()).toBe('');
      });

      it('a fresh chat whose effort request fails offers a Restart now that respawns it', async () => {
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const { started, starting } = freshStart();
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(
            -1
          );
        });
        await store.applyModelSelection(haikuPick);
        await store.applyEffortSelection('low');
        overrideInvoke('apply_chat_effort', rejected('chat session ended before the response'));
        started.resolve();
        await starting;
        await vi.waitFor(() => expect(store.deferredEffort()).toBe('low'));
        expect(store.hasConversation()).toBe(true);
        expect(store.lastKnownSessionId).toBeNull();

        await store.restartForDeferredEffort();

        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(2);
        expect(store.deferredEffort()).toBeNull();
      });

      function failedFirstSend(): void {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        TestBed.inject(ProjectStateService).status.set('ready');
        store._setState({
          messages: [
            { role: 'user', blocks: [{ type: 'text', content: 'hello' }], timestamp: 1 },
            {
              role: 'assistant',
              blocks: [{ type: 'error', content: 'Failed to restart session: boom' }],
              timestamp: 2,
            },
          ],
        });
        (store as unknown as { notifyChange(): void }).notifyChange();
      }

      it('an effort pick in a chat with messages but no session id respawns it', async () => {
        failedFirstSend();
        expect(store.hasConversation()).toBe(true);
        expect(store.lastKnownSessionId).toBeNull();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.applyEffortSelection('low');
        await new Promise((r) => setTimeout(r, 0));

        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
      });

      it('a routed pick in a chat with messages but no session id re-renders and respawns it', async () => {
        failedFirstSend();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.applyModelSelection({
          catalogId: 'llama4',
          wireId: 'my-ollama/llama4',
          providerId: 'my-ollama',
          kind: 'local',
          isDefault: false,
          contextTokens: null,
        });
        await new Promise((r) => setTimeout(r, 0));

        const calls = invokeSpy.mock.calls;
        const rerender = indexOfCall(calls, (cmd) => cmd === 'restart_integration_containers');
        expect(rerender).toBeGreaterThan(-1);
        expect(indexOfCall(calls, (cmd) => cmd === 'start_chat')).toBeGreaterThan(rerender);
        expect(indexOfCall(calls, switchedModel)).toBe(-1);
      });

      it('a routed model save error that arrives after the project changed is not shown', async () => {
        liveConversation();
        const pin = createDeferred<void>();
        overrideInvoke('set_provider_model', () => pin.promise);
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyModelSelection({
          ...haikuPick,
          catalogId: 'llama4',
          wireId: 'my-ollama/llama4',
          providerId: 'my-ollama',
          kind: 'local',
        });
        await vi.waitFor(() => {
          expect(
            indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'set_provider_model')
          ).toBeGreaterThan(-1);
        });
        TestBed.inject(ProjectStateService).activeProject.set('other');
        pin.reject(new Error('config is locked'));
        await pick;

        expect(store.modelSelectionError()).toBe('');
      });

      it('a model pick whose project changed while its switch ran is saved for its own project and adds no chip', async () => {
        liveConversation();
        const answer = createDeferred<ModelSwitchOutcome>();
        overrideInvoke('switch_chat_model', () => answer.promise);
        await Promise.resolve();
        const messagesBefore = store.messagesFromState().length;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyModelSelection(haikuPick);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
        });
        TestBed.inject(ProjectStateService).activeProject.set('other');
        answer.resolve({ outcome: 'confirmed' });
        await pick;

        expect(store.tabModel()).toBe('claude-haiku-4-5');
        expect(store.messagesFromState()).toHaveLength(messagesBefore);
        expect(store.pendingModelOverride()).toBeNull();
      });

      it('a model pick made after the project changed is neither switched nor saved', async () => {
        liveConversation();
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        TestBed.inject(ProjectStateService).status.set('switching');

        await store.applyModelSelection(haikuPick);

        expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'set_model_pin')).toBe(-1);
        expect(store.tabModel()).toBeNull();
      });

      describe('a live model pick Claude Code does not accept (SPEED-709)', () => {
        const sonnetPick = {
          ...haikuPick,
          catalogId: 'claude-sonnet-5',
          wireId: 'claude-sonnet-5',
        };
        const answered = (outcome: ModelSwitchOutcome) => async () => outcome;
        let tabModelWrites: () => (string | null)[] = () => [];
        beforeEach(() => {
          const internals = store as unknown as { _tabModel: { set(model: string | null): void } };
          const set = vi.spyOn(internals._tabModel, 'set');
          tabModelWrites = () => set.mock.calls.map(([model]) => model);
        });

        it('a refused pick is not saved, shows the reason and gives the badge back to the launch model', async () => {
          liveConversation();
          await Promise.resolve();
          overrideInvoke(
            'switch_chat_model',
            answered({ outcome: 'refused', reason: 'API Error: 429 Usage credits are required' })
          );
          const invokeSpy = vi.spyOn(mockTauri, 'invoke');
          const messagesBefore = store.messagesFromState().length;

          await store.applyModelSelection(haikuPick);

          expect(tabModelWrites()).toEqual([]);
          expect(indexOfCall(invokeSpy.mock.calls, touchesProjectPin)).toBe(-1);
          expect(store.modelSelectionError()).toBe(
            modelSwitchRefused('API Error: 429 Usage credits are required')
          );
          expect(store.pickedModel()).toBe('');
          expect(store.messagesFromState()).toHaveLength(messagesBefore);
        });

        it('a refusal of an older pick leaves the badge on the newer pick', async () => {
          liveConversation();
          await Promise.resolve();
          const olderAnswer = createDeferred<ModelSwitchOutcome>();
          let switches = 0;
          overrideInvoke('switch_chat_model', () =>
            ++switches === 1 ? olderAnswer.promise : Promise.resolve({ outcome: 'confirmed' })
          );

          const older = store.applyModelSelection(haikuPick);
          await vi.waitFor(() => expect(switches).toBe(1));
          const newer = store.applyModelSelection(sonnetPick);
          olderAnswer.resolve({ outcome: 'refused', reason: 'model not changed' });
          await older;
          await newer;

          expect(store.pickedModel()).toBe('claude-sonnet-5');
          expect(store.tabModel()).toBe('claude-sonnet-5');
        });

        it('a refused pick gives the badge back to the pick the session confirmed last', async () => {
          liveConversation();
          await Promise.resolve();
          let switches = 0;
          overrideInvoke('switch_chat_model', async () =>
            ++switches === 1
              ? { outcome: 'confirmed' }
              : { outcome: 'refused', reason: 'model not changed' }
          );

          await store.applyModelSelection(sonnetPick);
          await store.applyModelSelection(haikuPick);

          expect(store.pickedModel()).toBe('claude-sonnet-5');
        });

        it('a pick confirmed in an earlier session is not what a refusal gives back', async () => {
          liveConversation();
          await Promise.resolve();
          let switches = 0;
          overrideInvoke('switch_chat_model', async () =>
            ++switches === 1
              ? { outcome: 'confirmed' }
              : { outcome: 'refused', reason: 'model not changed' }
          );
          await store.applyModelSelection(sonnetPick);
          store.resetForNewConversation();
          store.seedSessionId('sess-next');

          await store.applyModelSelection(haikuPick);

          expect(store.pickedModel()).toBe('');
        });

        it('a refusal answered after the chat moved to another conversation of the project leaves that conversation alone', async () => {
          liveConversation();
          await Promise.resolve();
          const answer = createDeferred<ModelSwitchOutcome>();
          overrideInvoke('switch_chat_model', () => answer.promise);
          const invokeSpy = vi.spyOn(mockTauri, 'invoke');
          const pick = store.applyModelSelection(haikuPick);
          await vi.waitFor(() => {
            expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
          });

          store.resetForNewConversation();
          store.seedSessionId('sess-next');
          answer.resolve({ outcome: 'refused', reason: 'model not changed' });
          await pick;

          expect(store.modelSelectionError()).toBe('');
          expect(store.pickedModel()).toBe('claude-haiku-4-5');
          expect(tabModelWrites()).toEqual([]);
        });

        it('a pick whose session was replaced while it waited is saved and shows no error in the new conversation', async () => {
          liveConversation();
          await Promise.resolve();
          const answer = createDeferred<ModelSwitchOutcome>();
          overrideInvoke('switch_chat_model', () => answer.promise);
          const invokeSpy = vi.spyOn(mockTauri, 'invoke');
          const pick = store.applyModelSelection(haikuPick);
          await vi.waitFor(() => {
            expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
          });

          store.resetForNewConversation();
          store.seedSessionId('sess-next');
          answer.reject(new Error('the chat session was replaced before this input was written'));
          await pick;

          expect(store.modelSelectionError()).toBe('');
          expect(store.pickedModel()).toBe('claude-haiku-4-5');
          expect(tabModelWrites()).toEqual(['claude-haiku-4-5']);
        });

        it('a refusal after the session reported another model gives the badge back to what it reported', async () => {
          liveConversation();
          await Promise.resolve();
          let switches = 0;
          overrideInvoke('switch_chat_model', async () =>
            ++switches === 1
              ? { outcome: 'confirmed' }
              : { outcome: 'refused', reason: 'model not changed' }
          );
          await store.applyModelSelection(sonnetPick);
          store.handleStreamChunk({
            chunk_type: 'SystemInit',
            data: { model: 'claude-fable-5', session_id: LIVE },
          });

          await store.applyModelSelection(haikuPick);

          expect(store.pickedModel()).toBe('');
        });

        it('a spawn waits for every model pick in flight, whichever chain it is on', async () => {
          const work = createDeferred<void>();
          const internals = store as unknown as {
            trackModelWork<T>(promise: Promise<T>): Promise<T>;
            modelPicksSettled(): Promise<void>;
          };
          void internals.trackModelWork(work.promise);
          let settled = false;
          const waiting = internals.modelPicksSettled().then(() => {
            settled = true;
          });
          await new Promise((r) => setTimeout(r, 0));

          expect(settled).toBe(false);
          work.resolve();
          await waiting;
          expect(settled).toBe(true);
        });

        it('a refused routed pick leaves the provider config alone', async () => {
          liveConversation();
          await Promise.resolve();
          overrideInvoke(
            'switch_chat_model',
            answered({ outcome: 'refused', reason: 'model not found' })
          );
          const setProviderModel = vi.spyOn(
            TestBed.inject(AnthropicModelsService),
            'setProviderModel'
          );

          await store.applyModelSelection({
            catalogId: 'llama4',
            wireId: 'my-ollama/llama4',
            providerId: 'my-ollama',
            kind: 'local',
            isDefault: false,
            contextTokens: null,
          });

          expect(setProviderModel).not.toHaveBeenCalled();
          expect(store.modelSelectionError()).toBe(modelSwitchRefused('model not found'));
        });

        it('an unconfirmed pick is saved, adds no chip and says the session did not confirm it', async () => {
          liveConversation();
          await Promise.resolve();
          overrideInvoke('switch_chat_model', answered({ outcome: 'unconfirmed' }));
          const invokeSpy = vi.spyOn(mockTauri, 'invoke');
          const messagesBefore = store.messagesFromState().length;

          await store.applyModelSelection(haikuPick);

          expect(tabModelWrites()).toEqual(['claude-haiku-4-5']);
          expect(indexOfCall(invokeSpy.mock.calls, touchesProjectPin)).toBe(-1);
          expect(store.modelSelectionError()).toBe(MODEL_SWITCH_UNCONFIRMED);
          expect(store.messagesFromState()).toHaveLength(messagesBefore);
          expect(store.pickedModel()).toBe('claude-haiku-4-5');
        });

        it('a pick the session could not take is saved for the next spawn and says why', async () => {
          liveConversation();
          await Promise.resolve();
          overrideInvoke(
            'switch_chat_model',
            rejected('chat session ended before the control response')
          );
          const invokeSpy = vi.spyOn(mockTauri, 'invoke');

          await store.applyModelSelection(haikuPick);

          expect(tabModelWrites()).toEqual(['claude-haiku-4-5']);
          expect(indexOfCall(invokeSpy.mock.calls, touchesProjectPin)).toBe(-1);
          expect(store.modelSelectionError()).toContain('chat session ended');
          expect(store.pickedModel()).toBe('claude-haiku-4-5');
        });

        it('a pick released at the turn end and refused there is not saved', async () => {
          liveConversation();
          await Promise.resolve();
          overrideInvoke(
            'switch_chat_model',
            answered({ outcome: 'refused', reason: 'model not changed' })
          );
          const invokeSpy = vi.spyOn(mockTauri, 'invoke');
          store.isStreaming = true;
          await store.applyModelSelection(haikuPick);
          expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');

          store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);

          await vi.waitFor(() => {
            expect(store.modelSelectionError()).toBe(modelSwitchRefused('model not changed'));
          });
          expect(tabModelWrites()).toEqual([]);
          expect(indexOfCall(invokeSpy.mock.calls, touchesProjectPin)).toBe(-1);
        });

        it('a pick a New chat drops is saved before the new session starts, which launches with it', async () => {
          liveConversation();
          await Promise.resolve();
          const invokeSpy = vi.spyOn(mockTauri, 'invoke');
          store.isStreaming = true;
          await store.applyModelSelection(haikuPick);
          expect(tabModelWrites()).toEqual([]);

          store.resetForNewConversation();
          await store.init();

          expect(tabModelWrites()).toEqual(['claude-haiku-4-5']);
          await vi.waitFor(() => {
            expect(launchModelOf(invokeSpy.mock.calls, 'start_chat')).toBe('claude-haiku-4-5');
          });
          expect(indexOfCall(invokeSpy.mock.calls, touchesProjectPin)).toBe(-1);
        });

        it('a New chat made while a live switch waits for Claude Code starts once the switch is saved', async () => {
          liveConversation();
          await Promise.resolve();
          const answer = createDeferred<ModelSwitchOutcome>();
          overrideInvoke('switch_chat_model', () => answer.promise);
          const invokeSpy = vi.spyOn(mockTauri, 'invoke');
          const pick = store.applyModelSelection(haikuPick);
          await vi.waitFor(() => {
            expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
          });

          store.resetForNewConversation();
          await store.init();
          expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'start_chat')).toBe(-1);
          answer.resolve({ outcome: 'confirmed' });
          await pick;

          await vi.waitFor(() => {
            expect(launchModelOf(invokeSpy.mock.calls, 'start_chat')).toBe('claude-haiku-4-5');
          });
          expect(store.messagesFromState().some((m) => m.blocks[0]?.type === 'chip')).toBe(false);
        });
      });

      it('a model switch answered after the project changed adds no chip and no error there', async () => {
        liveConversation();
        const answer = createDeferred<void>();
        overrideInvoke('switch_chat_model', () => answer.promise);
        await Promise.resolve();
        const messagesBefore = store.messagesFromState().length;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const pick = store.applyModelSelection(haikuPick);
        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
        });
        TestBed.inject(ProjectStateService).activeProject.set('other');
        answer.reject(new Error('no chat session for this project'));
        await pick;

        expect(store.messagesFromState()).toHaveLength(messagesBefore);
        expect(store.modelSelectionError()).toBe('');
      });

      it('sends picks one at a time, in pick order, and drops one superseded while it waits', async () => {
        const firstAnswer = createDeferred<void>();
        let applies = 0;
        liveConversation(async () => {
          applies += 1;
          if (applies === 1) await firstAnswer.promise;
        });
        await Promise.resolve();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const first = store.applyEffortSelection('low');
        await vi.waitFor(() => {
          expect(applies).toBe(1);
        });
        const second = store.applyEffortSelection('medium');
        const third = store.applyEffortSelection('max');
        await new Promise((r) => setTimeout(r, 10));
        expect(applies).toBe(1);

        firstAnswer.resolve();
        await Promise.all([first, second, third]);

        const applied = invokeSpy.mock.calls
          .filter(([cmd]) => cmd === 'apply_chat_effort')
          .map(([, args]) => (args as { level: string }).level);
        expect(applied).toEqual(['low', 'max']);
        expect(store.deferredEffort()).toBeNull();
      });

      it('drops the outcome when the conversation is replaced while the pick is applied', async () => {
        const answer = createDeferred<void>();
        let applies = 0;
        liveConversation(() => {
          applies += 1;
          return answer.promise;
        });
        await Promise.resolve();

        const applying = store.applyEffortSelection('low');
        await vi.waitFor(() => {
          expect(applies).toBe(1);
        });
        store.resetForNewConversation();
        answer.reject(new Error('no active session'));
        await applying;

        expect(store.deferredEffort()).toBeNull();
      });

      it('sends a pick released at a turn end even before the session reported its id', async () => {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        store.isStreaming = true;
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.applyEffortSelection('low');
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        store.handleStreamChunk({ chunk_type: 'Result', data: {} } as never);

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('low'))).toBeGreaterThan(-1);
        });
        expect(store.lastKnownSessionId).toBeNull();
        expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      });

      it('applies a pick made during a resume as soon as the resume completes', async () => {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        const resumed = createDeferred<void>();
        mockTauri.invokeHandler = async (cmd: string) => {
          if (cmd === 'resume_conversation') return resumed.promise;
          if (cmd === 'get_conversation') {
            return {
              session_id: LIVE,
              messages: [{ role: 'assistant', content: 'Hello', timestamp: null }],
            };
          }
          return undefined;
        };
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        const resuming = store.resumeConversation(LIVE);
        await store.applyEffortSelection('high');
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        resumed.resolve();
        await resuming;

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('high'))).toBeGreaterThan(-1);
        });
      });

      it('a turn end applies a pending model pick and a pending effort pick together', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('max');
        await store.applyModelSelection({
          catalogId: 'claude-haiku-4-5',
          wireId: 'claude-haiku-4-5',
          providerId: 'anthropic',
          kind: 'anthropic_oauth',
          isDefault: false,
          contextTokens: null,
        });
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        store.handleStreamChunk({ chunk_type: 'Result', data: { session_id: LIVE } } as never);

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
        expect(store.pendingModelOverride()).toBeNull();
      });

      it('an error that ends the turn applies a pending effort pick', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('max');
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        store.handleStreamChunk({
          chunk_type: 'Error',
          data: { content: 'Overloaded', turn_ended: true },
        });

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, appliedEffort('max'))).toBeGreaterThan(-1);
        });
      });

      it('an error that ends the turn applies a pending model pick', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyModelSelection({
          catalogId: 'claude-haiku-4-5',
          wireId: 'claude-haiku-4-5',
          providerId: 'anthropic',
          kind: 'anthropic_oauth',
          isDefault: false,
          contextTokens: null,
        });
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        store.handleStreamChunk({
          chunk_type: 'Error',
          data: { content: 'Overloaded', turn_ended: true },
        });

        await vi.waitFor(() => {
          expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBeGreaterThan(-1);
        });
        expect(store.pendingModelOverride()).toBeNull();
      });

      it('an error that may arrive mid-turn leaves the pending picks queued', async () => {
        liveConversation();
        await Promise.resolve();
        store.isStreaming = true;
        await store.applyEffortSelection('max');
        await store.applyModelSelection({
          catalogId: 'claude-haiku-4-5',
          wireId: 'claude-haiku-4-5',
          providerId: 'anthropic',
          kind: 'anthropic_oauth',
          isDefault: false,
          contextTokens: null,
        });
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        store.handleStreamChunk({ chunk_type: 'Error', data: { content: 'rate limit' } });
        await new Promise((r) => setTimeout(r, 0));

        expect(indexOfCall(invokeSpy.mock.calls, switchedModel)).toBe(-1);
        expect(indexOfCall(invokeSpy.mock.calls, (cmd) => cmd === 'apply_chat_effort')).toBe(-1);
        expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
      });
    });

    it('an idle model-pick respawn claims init() so a remount starts no second session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      await store.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
    });

    it('an idle effort-pick respawn claims init() so a remount starts no second session', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyEffortSelection('high');
      await store.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(1);
    });

    it('picking the Default row switches only this tab and never touches the project pin', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();

      await store.applyModelSelection({
        catalogId: 'claude-opus-5',
        wireId: 'claude-opus-5[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: true,
        contextTokens: null,
      });

      const commands = invokeSpy.mock.calls.map(([cmd]) => cmd);
      expect(commands).not.toContain('clear_model_pin');
      expect(commands).not.toContain('set_model_pin');
      expect(commands).not.toContain('send_message');
      const sent = invokeSpy.mock.calls.find(([cmd]) => cmd === 'switch_chat_model');
      expect((sent?.[1] as { model?: string } | undefined)?.model).toBe('claude-opus-5[1m]');
      expect(store.tabModel()).toBe('claude-opus-5[1m]');
    });

    it('picking the Default row mid-stream queues its wire id for this tab', async () => {
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5', session_id: 'sess-live' },
      });
      await Promise.resolve();
      store.isStreaming = true;

      await store.applyModelSelection({
        catalogId: 'claude-opus-5',
        wireId: 'claude-opus-5[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: true,
        contextTokens: null,
      });

      expect(store.pendingModelOverride()).toBe('claude-opus-5[1m]');
    });

    it('a Default flag on a proxy-routed pick is ignored: the provider model is still written', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'qwen3',
        wireId: 'local/qwen3',
        providerId: 'local',
        kind: 'local',
        isDefault: true,
        contextTokens: null,
      });

      const commands = invokeSpy.mock.calls.map(([cmd]) => cmd);
      expect(commands).toContain('set_provider_model');
      expect(commands).not.toContain('clear_model_pin');
    });

    it('applyDefaultModelSelection persists the pin for new tabs and never touches the live session', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();

      await store.applyDefaultModelSelection({
        catalogId: 'claude-opus-5',
        wireId: 'claude-opus-5[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });

      expect(invokeSpy).toHaveBeenCalledWith('set_model_pin', {
        projectId: 'test',
        model: 'claude-opus-5[1m]',
      });
      expect(invokeSpy.mock.calls.some(([cmd]) => cmd === 'send_message')).toBe(false);
      expect(invokeSpy.mock.calls.some(([cmd]) => cmd === 'switch_chat_model')).toBe(false);
      expect(invokeSpy.mock.calls.some(([cmd]) => cmd === 'start_chat')).toBe(false);
      expect(store.tabModel()).toBeNull();
    });

    it('applyDefaultModelSelection with the account-default row clears the pin instead', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyDefaultModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: true,
        contextTokens: null,
      });

      expect(invokeSpy).toHaveBeenCalledWith('clear_model_pin', { projectId: 'test' });
      expect(invokeSpy.mock.calls.map(([cmd]) => cmd)).not.toContain('set_model_pin');
    });

    it('a failed default-pin write surfaces the error and never touches the live session', async () => {
      const original = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) => {
        if (cmd === 'set_model_pin') throw new Error('unknown Anthropic model');
        return original(cmd, args);
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();

      await store.applyDefaultModelSelection({
        catalogId: 'claude-opus-5',
        wireId: 'claude-opus-5[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });

      expect(store.modelSelectionError()).toBe('unknown Anthropic model');
      expect(invokeSpy.mock.calls.some(([cmd]) => cmd === 'send_message')).toBe(false);
      expect(invokeSpy.mock.calls.some(([cmd]) => cmd === 'switch_chat_model')).toBe(false);
    });

    it('applyModelSelection during a streaming turn queues the switch instead of silently dropping it', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();
      store.isStreaming = true;

      await store.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      const modelSend = invokeSpy.mock.calls.find(([cmd]) => cmd === 'switch_chat_model');
      expect(modelSend).toBeUndefined();
      expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
    });

    it('resetForNewConversation clears a queued mid-stream pick so it cannot leak into the fresh session', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-old' },
      });
      await Promise.resolve();
      store.isStreaming = true;
      await store.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');

      store.isStreaming = false;
      store.resetForNewConversation();
      expect(store.pendingModelOverride()).toBeNull();

      invokeSpy.mockClear();
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-new' },
      });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-new' },
      } as never);
      await new Promise((r) => setTimeout(r, 0));

      const modelSendCall = invokeSpy.mock.calls.find(([cmd]) => cmd === 'switch_chat_model');
      expect(modelSendCall).toBeUndefined();
    });

    it('resumeConversation clears a queued mid-stream pick so a later SystemInit/Result sends no /model', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      mockTauri.invokeHandler = async () => undefined;
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'old-sess' },
      });
      await Promise.resolve();
      store.isStreaming = true;
      await store.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');
      store.isStreaming = false;

      await store.resumeConversation('old-sess');
      expect(store.pendingModelOverride()).toBeNull();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'old-sess' },
      });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'old-sess' },
      } as never);
      await new Promise((r) => setTimeout(r, 0));

      const modelSendCall = invokeSpy.mock.calls.find(([cmd]) => cmd === 'switch_chat_model');
      expect(modelSendCall).toBeUndefined();
      expect(store.pendingModelOverride()).toBeNull();
    });
  });
  describe('resetForNewConversation', () => {
    it('clears messages, blocks, and streaming state', () => {
      store._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [{ type: 'text', content: 'partial' }],
        sessionStats: {
          session_id: 'x',
          total_cost: 0,
          total_output_tokens: 0,
          context_window_size: 200000,
        },
      });
      store.isStreaming = true;

      store.resetForNewConversation();

      expect(store.messages).toEqual([]);
      expect(store.currentBlocks).toEqual([]);
      expect(store.isStreaming).toBe(false);
      expect(store.sessionStats).toBeNull();
    });

    it('rebuilds the state-tree signal', () => {
      store._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'x' } });
      expect(store.state().entries.length).toBeGreaterThan(0);

      store.resetForNewConversation();

      expect(store.state().entries).toEqual([]);
      expect(store.state().is_streaming).toBe(false);
    });
  });

  describe('loadMessages', () => {
    it('sets messages array', () => {
      store.loadMessages([
        { role: 'user', blocks: [{ type: 'text', content: 'loaded' }], timestamp: 1 },
      ]);

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].blocks[0]).toEqual({ type: 'text', content: 'loaded' });
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

      store.loadMessages([
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
        expect(store.messages.find((m) => m.uuid === 'gen-1')?.meta?.cost).toBeCloseTo(0.0858, 6);
      });
    });
  });

  describe('state-tree signal rebuild on mutation', () => {
    it('rebuilds the signal on a stream chunk so projections refresh', () => {
      const before = store.state();
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });

      expect(store.state()).not.toBe(before);
      expect(store.currentBlocksFromState()).toEqual([{ type: 'text', content: 'hi' }]);
      expect(store.isStreamingFromState()).toBe(true);
    });

    it('leaves the signal untouched when a chunk produces no state change', () => {
      const before = store.state();
      store.handleStreamChunk({
        chunk_type: 'UnknownFutureType' as StreamChunk['chunk_type'],
        data: {},
      } as StreamChunk);
      expect(store.state()).toBe(before);
    });
  });

  describe('immutable updates', () => {
    it('creates new array references on text chunk', () => {
      const originalBlocks = store.currentBlocks;
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      expect(store.currentBlocks).not.toBe(originalBlocks);
    });

    it('creates new array references on ToolStart', () => {
      const originalBlocks = store.currentBlocks;
      store.handleStreamChunk({
        chunk_type: 'ToolStart',
        data: { tool_id: 't1', tool_name: 'Read' },
      });
      expect(store.currentBlocks).not.toBe(originalBlocks);
    });

    it('creates new messages array on Result', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'test' } });
      const originalMessages = store.messages;
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });
      expect(store.messages).not.toBe(originalMessages);
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
      store.handleStreamChunk(askChunk('toolu_ask1', 1));

      expect(store.currentBlocks).toHaveLength(1);
      const block = store.currentBlocks[0];
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
      store.handleStreamChunk(askChunk('toolu_ask4', 4));
      const block = store.currentBlocks[0];
      if (block.type === 'ask_user') {
        expect(block.question.questions).toHaveLength(4);
        expect(block.question.answers).toEqual([null, null, null, null]);
      }
    });

    it('submitAnswer optimistically advances current_index to next null slot', async () => {
      store.handleStreamChunk(askChunk('toolu_ask3', 3));

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await store.submitAnswer('toolu_ask3', 0, 'A');

      const block = store.currentBlocks[0];
      if (block.type === 'ask_user') {
        expect(block.question.answers).toEqual(['A', null, null]);
        expect(block.question.current_index).toBe(1);
      }
      expect(invokeSpy).toHaveBeenCalledWith('submit_question_answer', {
        toolUseId: 'toolu_ask3',
        questionIdx: 0,
        answer: 'A',
        tabId: store.tabId,
      });
    });

    it('submitAnswer for final slot fills the last answers slot and points current_index past the end', async () => {
      store.handleStreamChunk(askChunk('toolu_ask2', 2));
      await store.submitAnswer('toolu_ask2', 0, 'first');
      await store.submitAnswer('toolu_ask2', 1, 'second');

      const block = store.currentBlocks[0];
      if (block.type === 'ask_user') {
        expect(block.question.answers).toEqual(['first', 'second']);
        expect(block.question.current_index).toBe(2);
      }
    });

    it('submitAnswer reverts the slot and appends an error block on backend failure', async () => {
      store.isStreaming = true;
      store.handleStreamChunk(askChunk('toolu_ask1', 1));

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'submit_question_answer') throw new Error('pipe broken');
        return undefined;
      };

      await store.submitAnswer('toolu_ask1', 0, 'A');

      expect(store.isStreaming).toBe(false);

      const askBlock = store.currentBlocks.find(
        (b) => b.type === 'ask_user' && b.question.tool_id === 'toolu_ask1'
      );
      expect(askBlock).toBeDefined();
      if (askBlock && askBlock.type === 'ask_user') {
        expect(askBlock.question.answers).toEqual([null]);
        expect(askBlock.question.current_index).toBe(0);
      }

      const lastBlock = store.currentBlocks[store.currentBlocks.length - 1];
      expect(lastBlock.type).toBe('error');
      if (lastBlock.type === 'error') {
        expect(lastBlock.content).toContain('Failed to send answer');
      }
    });

    it('submitAnswer with stale tool_use_id calls backend (host validates)', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await store.submitAnswer('toolu_nonexistent', 0, 'yes');

      expect(store.currentBlocks).toHaveLength(0);
      expect(invokeSpy).toHaveBeenCalledWith('submit_question_answer', {
        toolUseId: 'toolu_nonexistent',
        questionIdx: 0,
        answer: 'yes',
        tabId: store.tabId,
      });
    });

    it('submitAnswer forwards multi-select joined value verbatim', async () => {
      store.handleStreamChunk({
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
      await store.submitAnswer('toolu_ask1', 0, 'A, B');

      expect(invokeSpy).toHaveBeenCalledWith('submit_question_answer', {
        toolUseId: 'toolu_ask1',
        questionIdx: 0,
        answer: 'A, B',
        tabId: store.tabId,
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
      store._setState({
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
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: '' } });

      const projectedEntry = store.state().entries[0];
      expect(projectedEntry.blocks).toEqual([
        { kind: 'chip', command: 'effort', argument: 'high' },
      ]);

      const projectedMessage = store.messagesFromState()[0];
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

      await store.init();
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

      await store.init();
      await vi.waitFor(() => {
        expect(store.sessionStartInFlightFromState()).toBe(false);
      });
      await store.sendMessage('hello');
      expect(projectState.status()).toBe('auth_required');
    });
  });

  describe('UserMessageCommit chunk', () => {
    it('commits the UUID onto the most recent user entry that is missing one', () => {
      store._setState({
        messages: [
          { role: 'user', blocks: [{ type: 'text', content: 'first' }], timestamp: 1, uuid: 'u-1' },
          { role: 'user', blocks: [{ type: 'text', content: 'second' }], timestamp: 2 },
        ],
      });
      store.handleStreamChunk({
        chunk_type: 'UserMessageCommit',
        data: { uuid: 'u-2' },
      });
      expect(store.messages[1].uuid).toBe('u-2');
      expect(store.messages[1].uuid_status).toBe('Committed');
      expect(store.messages[0].uuid).toBe('u-1');
    });

    it('is a no-op when no user entry is missing a UUID', () => {
      store._setState({
        messages: [
          { role: 'user', blocks: [{ type: 'text', content: 'first' }], timestamp: 1, uuid: 'u-1' },
        ],
      });
      const before = store.messages;
      store.handleStreamChunk({
        chunk_type: 'UserMessageCommit',
        data: { uuid: 'u-2' },
      });
      expect(store.messages).toBe(before);
    });

    it('is a no-op when the message list is empty', () => {
      const before = store.messages;
      store.handleStreamChunk({
        chunk_type: 'UserMessageCommit',
        data: { uuid: 'u-1' },
      });
      expect(store.messages).toBe(before);
    });
  });

  describe('Result chunk with assistant_uuid', () => {
    it('stamps the committed UUID onto the finalized assistant entry', () => {
      store.isStreaming = true;
      store._setState({ currentBlocks: [{ type: 'text', content: 'reply' }] });
      store.handleStreamChunk({
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
      const last = store.messages[store.messages.length - 1];
      expect(last.role).toBe('assistant');
      expect(last.uuid).toBe('a-1');
      expect(last.uuid_status).toBe('Committed');
    });

    it('omits uuid_status when assistant_uuid is missing', () => {
      store.isStreaming = true;
      store._setState({ currentBlocks: [{ type: 'text', content: 'reply' }] });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 's-1',
          total_cost: 0,
          usage: undefined,
          result_text: undefined,
          context_window_size: 200_000,
        },
      });
      const last = store.messages[store.messages.length - 1];
      expect(last.uuid).toBeUndefined();
      expect(last.uuid_status).toBeUndefined();
    });
  });

  describe('lastContextTokens', () => {
    it('exposes the last call context total from Result and survives reset', () => {
      store.handleStreamChunk({
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
      expect(store.lastContextTokens).toBe(24771);
      store.resetForNewConversation();
      expect(store.lastContextTokens).toBe(24771);
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
      store._setState({
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
      const ok = store.copyMessage(0);
      expect(ok).toBe(true);
      expect(copySpy).toHaveBeenCalledWith('Hello\n\nWorld');
    });

    it('returns false for an out-of-range index', () => {
      const ok = store.copyMessage(99);
      expect(ok).toBe(false);
      expect(copySpy).not.toHaveBeenCalled();
    });

    it('returns false when there is no copyable text (only tool_use/thinking)', () => {
      store._setState({
        messages: [
          {
            role: 'assistant',
            blocks: [{ type: 'thinking', content: 'hmm', collapsed: true }],
            timestamp: 1,
          },
        ],
      });
      const ok = store.copyMessage(0);
      expect(ok).toBe(false);
      expect(copySpy).not.toHaveBeenCalled();
    });

    it('returns false and warns when CDK Clipboard.copy returns false', () => {
      copySpy.mockReturnValueOnce(false);
      store._setState({
        messages: [{ role: 'assistant', blocks: [{ type: 'text', content: 'x' }], timestamp: 1 }],
      });
      const ok = store.copyMessage(0);
      expect(ok).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('canRetryLastAssistant / retryLastAssistant', () => {
    function seedRetryableSession(): void {
      store._setState({
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
      store.isStreaming = false;
    }

    it('canRetryLastAssistant returns true when last assistant is committed and a session id is known', () => {
      seedRetryableSession();
      expect(store.canRetryLastAssistant()).toBe(true);
    });

    it('canRetryLastAssistant returns false while streaming', () => {
      seedRetryableSession();
      store.isStreaming = true;
      expect(store.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant returns false when no assistant entry exists', () => {
      store._setState({
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
      expect(store.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant returns false when the user UUID is missing', () => {
      store._setState({
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
      expect(store.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant returns false when assistant uuid_status is Pending', () => {
      seedRetryableSession();
      store._setState({
        messages: [
          ...store.messages.slice(0, -1),
          { ...store.messages[store.messages.length - 1], uuid_status: 'Pending' },
        ],
      });
      expect(store.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant returns false without a session id', () => {
      seedRetryableSession();
      store._setState({ sessionStats: null });
      expect(store.canRetryLastAssistant()).toBe(false);
    });

    it('retryLastAssistant invokes the backend, trims the assistant entry, and starts streaming', async () => {
      seedRetryableSession();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const before = store.turnId;
      await store.retryLastAssistant();
      expect(invokeSpy).toHaveBeenCalledWith('retry_last_turn', {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        userUuid: 'msg_user_1',
        tabId: store.tabId,
        model: null,
      });
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].role).toBe('user');
      expect(store.messages[0].edited_at).toBeDefined();
      expect(store.isStreaming).toBe(true);
      expect(store.turnId).toBeGreaterThan(before);
    });

    it('retryLastAssistant is a no-op when canRetry is false', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await store.retryLastAssistant();
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(store.isStreaming).toBe(false);
    });

    it('retryLastAssistant restores state and surfaces an error block on backend failure', async () => {
      seedRetryableSession();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'retry_last_turn') throw new Error('resume failed');
        return undefined;
      };
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await store.retryLastAssistant();
      expect(store.isStreaming).toBe(false);
      expect(store.messages).toHaveLength(3);
      const last = store.messages[2];
      expect(last.role).toBe('assistant');
      expect(last.blocks[0].type).toBe('error');
      expect((last.blocks[0] as { type: 'error'; content: string }).content).toContain(
        'Retry failed'
      );
      errSpy.mockRestore();
    });

    it('canRetryLastAssistant returns false when the anchor candidate is a control-chip message', () => {
      store._setState({
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
      store.isStreaming = false;

      expect(store.canRetryLastAssistant()).toBe(false);
    });

    it('canRetryLastAssistant keeps the real anchor when a chip trails the last assistant', () => {
      store._setState({
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
      store.isStreaming = false;

      expect(store.canRetryLastAssistant()).toBe(true);
    });

    it('canRetryLastAssistant returns false when a chip sits directly before the last assistant', () => {
      store._setState({
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
      store.isStreaming = false;

      expect(store.canRetryLastAssistant()).toBe(false);
    });

    it('retryEnabled signal (state-tree path) stays false when a chip sits directly before the last assistant', () => {
      store._setState({
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
      store.isStreaming = false;
      store.handleStreamChunk({
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

      expect(store.retryEnabled()).toBe(false);
    });

    it('retryEnabled signal (state-tree path) stays true when the anchor is a real question, chip trailing', () => {
      store._setState({
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
      store.isStreaming = false;
      store.handleStreamChunk({
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

      expect(store.retryEnabled()).toBe(true);
    });
  });

  describe('per-turn meta on assistant entries', () => {
    it('attaches meta with model, usage, and cost from Result chunk', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      store.handleStreamChunk({
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

      expect(store.messages).toHaveLength(1);
      const meta = store.messages[0].meta;
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
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      store.handleStreamChunk({
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

      const meta = store.messages[0].meta;
      expect(meta?.model).toBe('claude-sonnet-4-6');
      expect(meta?.cost).toBeUndefined();
    });

    it('uses SystemInit model when the Result chunk omits `model`', () => {
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-haiku-4-5' },
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      store.handleStreamChunk({
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

      expect(store.messages[0].meta?.model).toBe('claude-haiku-4-5');
    });

    it('leaves meta undefined when chunk has no usage/model/cost', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc' },
      });

      expect(store.messages[0].meta).toBeUndefined();
    });

    it('simulates patch sequence: Add → Replace meta provisional → Replace meta final', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hi.' } });

      store.handleStreamChunk({
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

      const provisional = store.messages[0].meta;
      expect(provisional?.model).toBe('claude-haiku-4-5');
      expect(provisional?.cost).toBeUndefined();

      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Final.' } });
      store.handleStreamChunk({
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

      expect(store.messages).toHaveLength(2);
      const finalMeta = store.messages[1].meta;
      expect(finalMeta?.cost).toBe(0.007);
    });
  });

  describe('queueMessage / cancelQueuedMessage / QueueDrained', () => {
    function setSession(id: string): void {
      store._setState({
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

      const prior = await store.queueMessage('next');
      expect(prior).toBeNull();
      expect(calls).toEqual([{ cmd: 'queue_message', args: { sessionId: 's-1', text: 'next' } }]);
      expect(store.pendingQueue?.text).toBe('next');
    });

    it('queueMessage returns previous text when slot was already occupied', async () => {
      setSession('s-1');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'queue_message') return { text: 'older', queued_at: 1 };
        return undefined;
      };
      const prior = await store.queueMessage('newer');
      expect(prior).toBe('older');
      expect(store.pendingQueue?.text).toBe('newer');
    });

    it('SystemInit session_id enables queueMessage during the first turn (ADR-045)', async () => {
      store._setState({ sessionStats: null });
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6', session_id: 'init-1' },
      });
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'queue_message') return null;
        return undefined;
      };

      const prior = await store.queueMessage('follow-up');
      expect(prior).toBeNull();
      expect(calls).toEqual([
        { cmd: 'queue_message', args: { sessionId: 'init-1', text: 'follow-up' } },
      ]);
      expect(store.pendingQueue?.text).toBe('follow-up');
    });

    it('SystemInit with empty model seeds the session id without clobbering the model', () => {
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6' },
      });
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: '', session_id: 'init-2' },
      });
      expect(store.sessionStats?.session_id).toBe('init-2');
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });
      expect(store.sessionStats?.model).toBe('claude-opus-4-6');
    });

    it('queueMessage before any session id fills the local slot and defers the backend', async () => {
      store._setState({ sessionStats: null });
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      const prior = await store.queueMessage('next');
      expect(prior).toBeNull();
      expect(calls).not.toContain('queue_message');
      expect(store.pendingQueue?.text).toBe('next');
    });

    it('deferred queue flushes to the backend when SystemInit delivers the session id', async () => {
      store._setState({ sessionStats: null });
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'queue_message') return null;
        return undefined;
      };
      await store.queueMessage('early bird');
      expect(calls).toEqual([]);

      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-6', session_id: 'late-1' },
      });
      await vi.waitFor(() =>
        expect(calls).toEqual([
          { cmd: 'queue_message', args: { sessionId: 'late-1', text: 'early bird' } },
        ])
      );
      expect(store.pendingQueue?.text).toBe('early bird');
    });

    it('deferred queue flushes when the first Result delivers the session id', async () => {
      store._setState({ sessionStats: null });
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'queue_message') return null;
        return undefined;
      };
      await store.queueMessage('early bird');

      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      store.handleStreamChunk({
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
      store._setState({ sessionStats: null });
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      await store.queueMessage('doomed');
      await store.cancelQueuedMessage();
      expect(store.pendingQueue).toBeNull();

      store.handleStreamChunk({
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
      const prior = await store.queueMessage('');
      expect(prior).toBeNull();
      expect(calls).not.toContain('queue_message');
    });

    it('cancelQueuedMessage invokes backend and clears pendingQueue', async () => {
      setSession('s-1');
      store._setState({ pendingQueue: { text: 'q', queued_at: 1 } });
      const calls: Array<{ cmd: string; args: unknown }> = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        return undefined;
      };
      await store.cancelQueuedMessage();
      expect(calls).toContainEqual({
        cmd: 'cancel_queued_message',
        args: { sessionId: 's-1' },
      });
      expect(store.pendingQueue).toBeNull();
    });

    it('cancelQueuedMessage clears local slot when no session id is set', async () => {
      store._setState({
        sessionStats: null,
        pendingQueue: { text: 'orphan', queued_at: 1 },
      });
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      await store.cancelQueuedMessage();
      expect(store.pendingQueue).toBeNull();
      expect(calls).not.toContain('cancel_queued_message');
    });

    it('handleStreamChunk("QueueDrained") clears pendingQueue, appends user entry, flips streaming=true', () => {
      store._setState({
        messages: [],
        pendingQueue: { text: 'next', queued_at: 5 },
      });
      store.isStreaming = false;
      store.handleStreamChunk({
        chunk_type: 'QueueDrained',
        data: { session_id: 's-1', text: 'next' },
      });
      expect(store.pendingQueue).toBeNull();
      expect(store.isStreaming).toBe(true);
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].role).toBe('user');
      expect(store.messages[0].blocks).toEqual([{ type: 'text', content: 'next' }]);
    });

    it('queueMessage swallows backend errors and keeps the visible slot', async () => {
      setSession('s-1');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'queue_message') throw new Error('backend down');
        return undefined;
      };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const prior = await store.queueMessage('next');
      warnSpy.mockRestore();
      expect(prior).toBeNull();
      expect(store.pendingQueue?.text).toBe('next');
    });

    it('resetForNewConversation clears pendingQueue', () => {
      store._setState({ pendingQueue: { text: 'leftover', queued_at: 1 } });
      store.resetForNewConversation();
      expect(store.pendingQueue).toBeNull();
    });
  });

  describe('state-tree signal projections', () => {
    it('initial state matches DEFAULT_STATE_TREE', () => {
      const s = store.state();
      expect(s.session_id).toBeNull();
      expect(s.entries).toEqual([]);
      expect(s.is_streaming).toBe(false);
      expect(s.pending_queue).toBeNull();
      expect(s.session_totals.cost).toBe(0);
    });

    it('messagesFromState mirrors messages getter after streaming a turn', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: ' world' } });
      store.handleStreamChunk({
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
      const legacy = store.messages;
      const projected = store.messagesFromState();
      expect(projected.length).toBe(legacy.length);
      expect(projected[0].role).toBe(legacy[0].role);
      expect(projected[0].blocks.length).toBe(legacy[0].blocks.length);
      expect(store.isStreamingFromState()).toBe(store.isStreaming);
      expect(store.currentBlocksFromState().length).toBe(0);
    });

    it('currentBlocksFromState exposes trailing live-streaming entry', () => {
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'streaming...' } });
      expect(store.currentBlocksFromState().length).toBeGreaterThan(0);
      expect(store.isStreamingFromState()).toBe(true);
      expect(store.messagesFromState().length).toBe(0);
    });

    it('pendingQueueFromState mirrors pending_queue field after notifyChange', () => {
      store._setState({ pendingQueue: { text: 'next', queued_at: 1 } });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'tick' } });
      expect(store.pendingQueueFromState()?.text).toBe('next');
    });
  });

  describe('seedSessionId', () => {
    it('stamps the session id when none is set so retry/queue work pre-Result', () => {
      store._setState({ messages: [], currentBlocks: [], sessionStats: null });
      store.seedSessionId('resumed-sess-1');
      expect(store.sessionStats?.session_id).toBe('resumed-sess-1');
      expect(store.sessionStats?.total_cost).toBeNull();
      expect(store.sessionStats?.total_output_tokens).toBe(0);
    });

    it('is a no-op when the session id already matches', () => {
      store._setState({
        messages: [],
        currentBlocks: [],
        sessionStats: {
          session_id: 'sess-x',
          total_cost: 0.123,
          context_window_size: 200_000,
          total_output_tokens: 42,
        },
      });
      const before = store.sessionStats;
      store.seedSessionId('sess-x');
      expect(store.sessionStats).toBe(before);
      expect(store.sessionStats?.total_cost).toBe(0.123);
    });

    it('refuses an empty session id', () => {
      store._setState({ messages: [], currentBlocks: [], sessionStats: null });
      store.seedSessionId('');
      expect(store.sessionStats).toBeNull();
    });
  });

  describe('refreshLlmConfigCache', () => {
    it('updates the persisted context_tokens cache from the backend', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') return { context_tokens: 32_768 };
        return undefined;
      };
      await store.refreshLlmConfigCache();
      const internal = store as unknown as { _persistedContextTokens: number | null };
      expect(internal._persistedContextTokens).toBe(32_768);
    });

    it('clears the cache when the backend reports null context_tokens', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') return { context_tokens: null };
        return undefined;
      };
      const internal = store as unknown as { _persistedContextTokens: number | null };
      internal._persistedContextTokens = 99;
      await store.refreshLlmConfigCache();
      expect(internal._persistedContextTokens).toBeNull();
    });

    it('logs at debug level on backend failure without throwing', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_llm_config') throw new Error('backend gone');
        return undefined;
      };
      await expect(store.refreshLlmConfigCache()).resolves.toBeUndefined();
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
      await store.refreshLlmConfigCache();
      await store.refreshLlmConfigCache();
      await store.refreshLlmConfigCache();
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

    it('an Anthropic kind keeps the Claude Code path and invents no default', () => {
      const internal = store as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'anthropic_oauth';
      internal._persistedContextTokens = null;
      internal._contextWindowSize = null;
      expect(internal.resolveContextWindow(undefined)).toBeNull();
      internal._contextSnapshot = { max_tokens: 200_000 };
      expect(internal.resolveContextWindow(1_000_000)).toBe(200_000);
    });

    it('OpenRouter keeps the DEFAULT_CONTEXT_TOKENS fallback although its legacy provider reads "anthropic"', () => {
      const internal = store as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'open_router';
      internal._persistedContextTokens = null;
      internal._contextWindowSize = null;
      expect(internal.resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_TOKENS);
      expect(internal.resolveContextWindow(128_000)).toBe(128_000);
    });

    it('prefers the live stream value over every fallback for a routed provider', () => {
      const internal = store as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'open_router';
      internal._persistedContextTokens = 16_384;
      internal._contextWindowSize = 8_192;
      expect(internal.resolveContextWindow(500_000)).toBe(500_000);
    });

    it('falls back to persisted context_tokens when the live value is absent', () => {
      const internal = store as unknown as Internal;
      internal._currentProvider = 'local';
      internal._activeKind = 'local';
      internal._persistedContextTokens = 32_768;
      internal._contextWindowSize = 8_192;
      expect(internal.resolveContextWindow(undefined)).toBe(32_768);
    });

    it('falls back to previous _contextWindowSize when persisted is also absent', () => {
      const internal = store as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'open_router';
      internal._persistedContextTokens = null;
      internal._contextWindowSize = 65_536;
      expect(internal.resolveContextWindow(undefined)).toBe(65_536);
    });

    it('falls back to DEFAULT_CONTEXT_TOKENS as the last resort for OpenRouter only', () => {
      const internal = store as unknown as Internal;
      internal._currentProvider = 'anthropic';
      internal._activeKind = 'open_router';
      internal._persistedContextTokens = null;
      internal._contextWindowSize = 0;
      expect(internal.resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_TOKENS);
    });

    it('never invents a window for a local model or before the provider is known', () => {
      const internal = store as unknown as Internal;
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
      const internal = store as unknown as Internal;
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
      await store.refreshLlmConfigCache();

      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-or', usage: { input_tokens: 2_835, output_tokens: 2 } },
      });

      expect(store.sessionStats?.context_window_size).toBe(DEFAULT_CONTEXT_TOKENS);
    });

    it('keeps the window across a /model control chip', async () => {
      await store.refreshLlmConfigCache();
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-or', usage: { input_tokens: 2_835, output_tokens: 2 } },
      });

      store.handleStreamChunk({
        chunk_type: 'ControlChip',
        data: { command: 'model', argument: 'openrouter/openai/gpt-4o', uuid: 'chip-1' },
      });

      expect(store.sessionStats?.context_window_size).toBe(DEFAULT_CONTEXT_TOKENS);
    });
  });

  describe('context meter uses the conversation model, not a subagent model', () => {
    it('reports the conversation model and its window despite a subagent-heavy usage', () => {
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-fable-5' },
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      store.handleStreamChunk({
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

      expect(store.sessionStats?.context_window_size).toBe(1_000_000);
      expect(store.sessionStats?.model).toBe('claude-fable-5');
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
      await store.refreshLlmConfigCache();

      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-fable-5' },
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.5, model: 'claude-fable-5' },
      });

      expect(store.sessionStats?.context_window_size).toBeNull();
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
      store.isStreaming = true;

      store.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'exceeds the available context size (8192 tokens)' },
      });

      const errBlock = store.messages[store.messages.length - 1]?.blocks.find(
        (b) => b.type === 'error'
      );
      expect(errBlock).toBeDefined();
      if (errBlock?.type === 'error') {
        expect(errBlock.content).toContain('larger than the selected model');
      }
    });

    it('keeps unknown errors verbatim', () => {
      store.isStreaming = true;

      store.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'some unrelated error' },
      });

      const errBlock = store.messages[store.messages.length - 1]?.blocks.find(
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
      store.isStreaming = true;

      store.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'Not logged in · Please run /login' },
      });

      const errBlock = store.messages[store.messages.length - 1]?.blocks.find(
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
      store.isStreaming = true;

      store.handleStreamChunk({
        chunk_type: 'Error',
        data: {
          content: 'API Error: Server error mid-response. The response above may be incomplete.',
        },
      });

      const errBlock = store.messages[store.messages.length - 1]?.blocks.find(
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
        store.handleStreamChunk({ chunk_type: 'Error', data: { content } });
        const errBlock = store.messages[store.messages.length - 1]?.blocks.find(
          (b) => b.type === 'error'
        );
        expect(errBlock).toStrictEqual({ type: 'error', content, kind });
      }
    });

    it('an unrelated error text produces a block with no kind property at all', () => {
      store.isStreaming = true;

      store.handleStreamChunk({
        chunk_type: 'Error',
        data: { content: 'some unrelated error' },
      });

      const errBlock = store.messages[store.messages.length - 1]?.blocks.find(
        (b) => b.type === 'error'
      );
      expect(errBlock).toStrictEqual({ type: 'error', content: 'some unrelated error' });
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

      await store.resumeConversation('sess-notice');

      expect(calls).toContain('resume_conversation');
      expect(store.lastKnownSessionId).toBe('sess-notice');
      expect(store.sessionStats?.session_id).toBe('sess-notice');
      expect(store.isStreaming).toBe(false);
      const blocks = store.messages.flatMap((m) => m.blocks);
      const notice = blocks.find((b) => b.type === 'error');
      expect(notice).toBeDefined();
      expect((notice as { type: 'error'; content: string }).content).toContain('history');
      expect(store.loadingTranscriptFromState()).toBe(false);
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

      await store.resumeConversation('sess-ok');

      const blocks = store.messages.flatMap((m) => m.blocks);
      expect(blocks.some((b) => b.type === 'error')).toBe(false);
      expect(store.sessionStats?.session_id).toBe('sess-ok');
    });
  });

  describe('startNewConversation across a project switch', () => {
    let projectState: ProjectStateService;
    let calls: string[];
    let started: Deferred;

    beforeEach(async () => {
      projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      projectState.status.set('ready');
      await store.init();
      await new Promise((r) => setTimeout(r, 0));
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-fable-5', session_id: 'sess-live' },
      });
      store.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hello' } });
      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-live' },
      } as never);
      calls = [];
      started = createDeferred();
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'start_chat') return started.promise;
        return undefined;
      };
    });

    async function startAcrossSwitch(): Promise<{ starting: Promise<void> }> {
      const starting = store.startNewConversation();
      await vi.waitFor(() => expect(calls).toContain('start_chat'));
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other' });
      return { starting };
    }

    it('a new chat the backend refused before the switch landed leaves the project switched to alone', async () => {
      const { starting } = await startAcrossSwitch();
      started.reject(new Error(`${SESSION_KEPT_MARKER}: container images are still building`));

      await expect(starting).rejects.toThrow(NEW_CONVERSATION_PROJECT_CHANGED);
      expect(store.messagesFromState()).toEqual([]);
      expect(store.lastKnownSessionId).toBeNull();
      expect(store.sessionStatsFromState()).toBeNull();
      expect(projectState.error).not.toContain('container images are still building');
    });

    it('a fresh start after a restart that a switch overtakes leaves no error in the project switched to', async () => {
      const fresh = (
        store as unknown as { startFreshSession(): Promise<void> }
      ).startFreshSession();
      await vi.waitFor(() => expect(calls).toContain('start_chat'));
      mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other' });
      started.reject(new Error('failed to spawn claude'));
      await fresh;

      expect(JSON.stringify(store.messagesFromState())).not.toContain(
        'Could not start a new conversation'
      );
    });

    it('a new chat that started after the switch began fails, so nothing is staged for the other project', async () => {
      const { starting } = await startAcrossSwitch();
      started.resolve();

      await expect(starting).rejects.toThrow(NEW_CONVERSATION_PROJECT_CHANGED);
    });

    it('a sign-in refusal of the old project never marks the project switched to', async () => {
      const { starting } = await startAcrossSwitch();
      await new Promise((r) => setTimeout(r, 0));
      const statusOfTheOtherProject = projectState.status();
      started.reject(new Error('Claude is not authenticated. Please authenticate first.'));

      await expect(starting).rejects.toThrow(NEW_CONVERSATION_PROJECT_CHANGED);
      expect(projectState.status()).toBe(statusOfTheOtherProject);
      expect(projectState.status()).not.toBe('auth_required');
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
    it('writes a live routed pick through only after Claude Code accepted the switch', async () => {
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
      const handler = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'switch_chat_model') calls.push('switch_chat_model');
        return handler(cmd, args);
      };
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'my-or/anthropic/claude-sonnet-5', session_id: 'sess-1' },
      });

      const pending = store.applyModelSelection({
        catalogId: 'anthropic/claude-haiku-4-5',
        wireId: 'my-or/anthropic/claude-haiku-4-5',
        providerId: 'my-or',
        kind: 'open_router',
        isDefault: false,
        contextTokens: null,
      });
      await vi.waitFor(() =>
        expect(calls).toEqual(['switch_chat_model', 'setProviderModel-start'])
      );
      resolveSet();
      await pending;
      expect(calls).toEqual([
        'switch_chat_model',
        'setProviderModel-start',
        'setProviderModel-resolved',
      ]);
      expect(invokeSpy).not.toHaveBeenCalledWith('set_model_pin', expect.anything());
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
    });

    it('a switch that answers after a new conversation started adds no chip to it', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const base = mockTauri.invokeHandler;
      let answer: (() => void) | null = null;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'switch_chat_model') {
          return new Promise((resolve) => (answer = () => resolve(undefined)));
        }
        return base(cmd, args);
      };
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-pick' },
      });

      const picking = pickHaiku(store);
      await vi.waitFor(() => expect(answer).not.toBeNull());
      store.resetForNewConversation();
      answer!();
      await picking;

      expect(modelChips(store)).toBe(0);
      expect(store.modelSelectionError()).toBe('');
    });

    it('a switch the session refuses shows the error and adds no chip', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'switch_chat_model') {
          throw new Error("control request 'set_model' got no response within 10000 ms");
        }
        return base(cmd, args);
      };
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-pick' },
      });

      await pickHaiku(store);

      expect(store.modelSelectionError()).toContain('got no response');
      expect(modelChips(store)).toBe(0);
    });

    it('switches a live session with set_model: the chip shows at once and no turn starts', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-pick' },
      });

      await pickHaiku(store);

      expect(invokeSpy).toHaveBeenCalledWith('switch_chat_model', {
        project: 'proj',
        tabId: store.tabId,
        model: 'claude-haiku-4-5',
      });
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'send_message')).toHaveLength(0);
      expect(store.isStreaming).toBe(false);
      const last = store.messages[store.messages.length - 1];
      expect(last.blocks).toEqual([
        { type: 'chip', command: 'model', argument: 'claude-haiku-4-5' },
      ]);
    });

    function modelChips(target: ChatSessionStore): number {
      return target.messages.filter((m) =>
        m.blocks?.some((b) => b.type === 'chip' && b.command === 'model')
      ).length;
    }
    function pickHaiku(target: ChatSessionStore): Promise<void> {
      return target.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
    }

    it('does not send the wire command when setProviderModel rejects', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      vi.spyOn(anthropicModels, 'setProviderModel').mockRejectedValue(new Error('locked config'));
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'anthropic/claude-haiku-4-5',
        wireId: 'my-or/anthropic/claude-haiku-4-5',
        providerId: 'my-or',
        kind: 'open_router',
        isDefault: false,
        contextTokens: null,
      });

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'switch_chat_model')).toHaveLength(0);
      expect(store.modelSelectionError()).toContain('locked config');
    });

    it('a mid-stream pick on a live session waits unsaved for the turn end, then switches and saves the pin', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();
      store.isStreaming = true;

      await store.applyModelSelection({
        catalogId: 'claude-haiku-4-5',
        wireId: 'claude-haiku-4-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'set_model_pin')).toHaveLength(0);
      let modelSend = invokeSpy.mock.calls.find(([cmd]) => cmd === 'switch_chat_model');
      expect(modelSend).toBeUndefined();
      expect(store.pendingModelOverride()).toBe('claude-haiku-4-5');

      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-live' },
      } as never);
      await vi.waitFor(() => {
        modelSend = invokeSpy.mock.calls.find(
          ([cmd, args]) =>
            cmd === 'switch_chat_model' &&
            JSON.stringify(args).includes('"model":"claude-haiku-4-5"')
        );
        expect(modelSend).toBeDefined();
      });
      await vi.waitFor(() => {
        expect(store.tabModel()).toBe('claude-haiku-4-5');
      });
      expect(store.pendingModelOverride()).toBeNull();
    });

    it('a still-session-less streaming pick waits unsaved, respawns nothing, and at the turn end switches, then saves the pin', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      store.isStreaming = true;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });

      const commands = (): string[] => invokeSpy.mock.calls.map(([cmd]) => cmd as string);
      expect(store.tabModel()).toBeNull();
      expect(commands()).not.toContain('start_chat');
      expect(store.pendingModelOverride()).toBe('claude-sonnet-5');

      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-first' },
      } as never);
      await vi.waitFor(() => {
        expect(store.tabModel()).toBe('claude-sonnet-5');
      });
      expect(invokeSpy).toHaveBeenCalledWith('switch_chat_model', {
        project: 'test',
        tabId: store.tabId,
        model: 'claude-sonnet-5',
      });
      expect(commands().some((cmd) => cmd.endsWith('_model_pin'))).toBe(false);
      expect(commands()).not.toContain('start_chat');
      expect(store.pendingModelOverride()).toBeNull();
    });

    it('reports a routed model write that fails after the live session switched', async () => {
      const switched: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_provider_model') throw new Error('unknown provider model');
        if (cmd === 'switch_chat_model') switched.push(cmd);
        return undefined;
      };
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'my-ollama/qwen3', session_id: 'sess-3' },
      });

      await store.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
        contextTokens: null,
      });

      expect(switched).toEqual(['switch_chat_model']);
      expect(store.modelSelectionError()).toContain('unknown provider model');
    });

    it('records the tab model only after Claude Code accepted the live switch', async () => {
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      const setProviderModelSpy = vi.spyOn(anthropicModels, 'setProviderModel');
      const calls: string[] = [];
      let answer!: () => void;
      vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'switch_chat_model') {
          return new Promise((r) => {
            answer = () => r({ outcome: 'confirmed' });
          });
        }
        return undefined;
      });
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-2' },
      });

      const pending = store.applyModelSelection({
        catalogId: 'claude-opus-4-8',
        wireId: 'claude-opus-4-8',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      await vi.waitFor(() => expect(calls).toEqual(['switch_chat_model']));
      expect(store.tabModel()).toBeNull();
      answer();
      await pending;
      expect(store.tabModel()).toBe('claude-opus-4-8');
      expect(calls).toEqual(['switch_chat_model']);
      expect(setProviderModelSpy).not.toHaveBeenCalled();
    });

    it('a live anthropic selection switches with set_model, writes no pin and records the tab model', async () => {
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      const setProviderModelSpy = vi.spyOn(anthropicModels, 'setProviderModel');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const sent: string[] = [];
      vi.spyOn(store, 'sendMessage').mockImplementation(async (input) => {
        sent.push(String(input));
      });
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-2' },
      });

      await store.applyModelSelection({
        catalogId: 'claude-opus-4-8',
        wireId: 'claude-opus-4-8',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });

      expect(sent).toEqual([]);
      expect(invokeSpy.mock.calls.find(([cmd]) => cmd === 'switch_chat_model')?.[1]).toMatchObject({
        tabId: store.tabId,
        model: 'claude-opus-4-8',
      });
      expect(store.tabModel()).toBe('claude-opus-4-8');
      expect(store.pickedModel()).toBe('claude-opus-4-8');
      expect(invokeSpy.mock.calls.map(([cmd]) => cmd)).not.toContain('set_model_pin');
      expect(setProviderModelSpy).not.toHaveBeenCalled();
    });

    it('records the tab model and sends nothing further when no session or project is active', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'claude-opus-4-8',
        wireId: 'claude-opus-4-8',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });

      expect(store.tabModel()).toBe('claude-opus-4-8');
      expect(invokeSpy.mock.calls.map(([cmd]) => cmd)).not.toContain('set_model_pin');
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'switch_chat_model')).toHaveLength(0);
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(store.pendingModelOverride()).toBeNull();
    });

    it('an idle pre-first-turn anthropic pick respawns this tab with the picked model', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await store.init();
      await new Promise((r) => setTimeout(r, 0));
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      await new Promise((r) => setTimeout(r, 0));

      const startCalls = invokeSpy.mock.calls
        .map((call, i) => ({ cmd: call[0], args: call[1], i }))
        .filter(({ cmd }) => cmd === 'start_chat');
      expect(invokeSpy.mock.calls.map(([cmd]) => cmd)).not.toContain('set_model_pin');
      expect(startCalls.at(-1)?.args).toEqual({
        project: 'test',
        tabId: store.tabId,
        model: 'claude-sonnet-5',
      });
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
      expect(store.pendingModelOverride()).toBeNull();
    });

    it('a later resume in this tab still carries the tab model override', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('test');
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: null,
      });
      await store.resumeConversation('old-sess');

      const resumeCall = invokeSpy.mock.calls.find(([cmd]) => cmd === 'resume_conversation');
      expect(resumeCall?.[1]).toEqual({
        project: 'test',
        sessionId: 'old-sess',
        tabId: store.tabId,
        model: 'claude-sonnet-5',
      });
    });

    it('a no-session routed pick re-renders the compose and respawns, so the next turn runs on it', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await store.init();
      await new Promise((r) => setTimeout(r, 0));
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
        contextTokens: 262_144,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy).toHaveBeenCalledWith('set_provider_model', {
        projectId: 'test',
        providerId: 'my-ollama',
        model: 'llama4',
        contextTokens: 262_144,
      });
      const commands = invokeSpy.mock.calls.map(([cmd]) => cmd);
      const writeIdx = commands.indexOf('set_provider_model');
      const restartIdx = commands.indexOf('restart_integration_containers');
      expect(restartIdx).toBeGreaterThan(writeIdx);
      expect(commands.lastIndexOf('start_chat')).toBeGreaterThan(restartIdx);
      expect(commands).not.toContain('switch_chat_model');
      expect(store.modelSelectionError()).toBe('');
      expect(store.pendingModelOverride()).toBeNull();
    });

    it('surfaces a failed re-render for a routed pick and leaves the session unspawned', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await store.init();
      await new Promise((r) => setTimeout(r, 0));
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'restart_integration_containers') throw new Error('compose render failed');
        return undefined;
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
        contextTokens: null,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(store.modelSelectionError()).toContain('compose render failed');
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(projectState.needsRestart).toBe(true);
    });

    it('tells the user to pick again when a restart is already running', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await store.init();
      await new Promise((r) => setTimeout(r, 0));
      projectState.restarting = true;
      projectState.restartError = 'a failure from an older restart';
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
        contextTokens: null,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(invokeSpy).toHaveBeenCalledWith('set_provider_model', {
        projectId: 'test',
        providerId: 'my-ollama',
        model: 'llama4',
        contextTokens: null,
      });
      expect(store.modelSelectionError()).toBe(MODEL_SWITCH_NOT_APPLIED);
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(projectState.needsRestart).toBe(false);
    });

    it('keeps a routed pick without an active project from respawning on an unchanged compose', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await store.init();
      await new Promise((r) => setTimeout(r, 0));
      projectState.activeProject.set(null);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
        contextTokens: null,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(store.modelSelectionError()).toBe(MODEL_SWITCH_NOT_APPLIED);
    });

    it('a mid-stream routed pick on a live session queues the wire switch and leaves containers alone', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      vi.spyOn(anthropicModels, 'setProviderModel').mockResolvedValue(undefined);
      store.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'my-or/anthropic/claude-sonnet-5', session_id: 'sess-routed' },
      });
      await Promise.resolve();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      store.isStreaming = true;

      await store.applyModelSelection({
        catalogId: 'anthropic/claude-haiku-4-5',
        wireId: 'my-or/anthropic/claude-haiku-4-5',
        providerId: 'my-or',
        kind: 'open_router',
        isDefault: false,
        contextTokens: null,
      });

      expect(store.pendingModelOverride()).toBe('my-or/anthropic/claude-haiku-4-5');
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
    });

    it('a still-session-less streaming routed pick leaves the running turn alone, and at its end switches, then writes through', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      store.isStreaming = true;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await store.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
        isDefault: false,
        contextTokens: null,
      });

      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'set_provider_model')).toHaveLength(0);
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
      expect(invokeSpy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
      expect(store.pendingModelOverride()).toBe('my-ollama/llama4');

      store.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-first' },
      } as never);
      await vi.waitFor(() => {
        expect(invokeSpy).toHaveBeenCalledWith('set_provider_model', {
          projectId: 'proj',
          providerId: 'my-ollama',
          model: 'llama4',
          contextTokens: null,
        });
      });
      expect(invokeSpy).toHaveBeenCalledWith('switch_chat_model', {
        project: 'proj',
        tabId: store.tabId,
        model: 'my-ollama/llama4',
      });
      expect(
        invokeSpy.mock.calls.filter(([cmd]) => cmd === 'restart_integration_containers')
      ).toHaveLength(0);
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
        contextTokens: null,
      };

      beforeEach(async () => {
        const projectState = TestBed.inject(ProjectStateService);
        await projectState.init();
        projectState.activeProject.set('test');
        await store.init();
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
        const pick = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));

        const resume = store.resumeConversation('sess-resumed');
        pendingRestart.resolve();
        await pick;
        await resume;
        await new Promise((r) => setTimeout(r, 0));

        expect(callsAfterRestart()).toContain('resume_conversation');
        expect(callsAfterRestart()).not.toContain('start_chat');
        expect(store.lastKnownSessionId).toBe('sess-resumed');
      });

      it('a turn sent meanwhile keeps its messages: the respawn does not reset them', async () => {
        const pick = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));

        void store.sendMessage('what number did I give you?');
        await vi.waitFor(() => expect(calls).toContain('send_message'));
        pendingRestart.resolve();
        await pick;
        await new Promise((r) => setTimeout(r, 0));

        expect(store.isStreaming).toBe(true);
        expect(store.messages.map((m) => m.role)).toEqual(['user']);
        expect(callsAfterRestart()).not.toContain('start_chat');
      });

      it('an idle routed pick restarts the containers of its own project, then respawns', async () => {
        everyCommandAnswers();
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(count('start_chat')).toBe(1));

        expect(invokeSpy).toHaveBeenCalledWith('restart_integration_containers', {
          project: 'test',
          justEnabled: null,
        });
        expect(calls.indexOf('start_chat')).toBeGreaterThan(
          calls.indexOf('restart_integration_containers')
        );
      });

      it('a project switch that lands while the pick is saving leaves the new project alone', async () => {
        const saved = saveHeldOpen();
        const projectState = TestBed.inject(ProjectStateService);
        const pick = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('set_provider_model'));

        mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
        mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other' });
        await vi.waitFor(() => expect(projectState.status()).toBe('ready'));
        saved.resolve();
        await pick;
        await new Promise((r) => setTimeout(r, 0));

        expect(projectState.activeProject()).toBe('other');
        expect(calls).not.toContain('restart_integration_containers');
        expect(calls).not.toContain('start_chat');
        expect(store.modelSelectionError()).toBe('');
      });

      it('a project switch that starts while the pick is saving restarts nothing', async () => {
        const saved = saveHeldOpen();
        const pick = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('set_provider_model'));

        mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
        saved.resolve();
        await pick;
        await new Promise((r) => setTimeout(r, 0));

        expect(calls).not.toContain('restart_integration_containers');
        expect(calls).not.toContain('start_chat');
        expect(store.modelSelectionError()).toBe('');
      });

      function saveHeldOpen(): Deferred {
        const saved = createDeferred();
        mockTauri.invokeHandler = (cmd: string) => {
          calls.push(cmd);
          if (cmd === 'set_provider_model') return saved.promise;
          if (cmd === 'get_auth_status') {
            return Promise.resolve({
              status: 'ready',
              api_key_configured: false,
              oauth_authenticated: false,
              needs_anthropic_auth: false,
              provider_configured: true,
            });
          }
          return Promise.resolve(undefined);
        };
        return saved;
      }

      it('a re-render that succeeds after a project switch started respawns nothing', async () => {
        const pick = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));
        mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
        mockTauri.dispatchEvent('project_switch_failed', {
          project: 'test',
          error: 'switch failed',
        });
        pendingRestart.resolve();
        await pick;
        await new Promise((r) => setTimeout(r, 0));

        expect(callsAfterRestart()).not.toContain('start_chat');
      });

      it('a routed pick that respawns after a newer pick leaves no record: its repeat re-renders', async () => {
        const first = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));
        await store.applyModelSelection(otherRoutedPick);
        expect(store.modelSelectionError()).toBe(MODEL_SWITCH_NOT_APPLIED);
        pendingRestart.resolve();
        await first;
        await vi.waitFor(() => expect(count('start_chat')).toBe(1));
        everyCommandAnswers();

        await store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(count('start_chat')).toBe(2));

        expect(count('restart_integration_containers')).toBe(2);
      });

      it('a re-render that ends after a project switch started leaves no record: back on the project the same pick re-renders', async () => {
        const pick = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));
        mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
        mockTauri.dispatchEvent('project_switch_failed', {
          project: 'test',
          error: 'switch failed',
        });
        pendingRestart.resolve();
        await pick;
        expect(callsAfterRestart()).not.toContain('start_chat');
        TestBed.inject(ProjectStateService).status.set('ready');
        everyCommandAnswers();

        await store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(count('start_chat')).toBe(1));

        expect(count('restart_integration_containers')).toBe(2);
      });

      it('a routed pick after a live switch and a New chat re-renders again: the new process launched with another model', async () => {
        everyCommandAnswers();
        await store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(count('start_chat')).toBe(1));
        store.seedSessionId('sess-routed');
        await store.applyModelSelection(otherRoutedPick);
        expect(count('switch_chat_model')).toBe(1);

        store.resetForNewConversation();
        await store.init();
        await vi.waitFor(() => expect(count('start_chat')).toBe(2));
        await store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(count('start_chat')).toBe(3));

        expect(count('restart_integration_containers')).toBe(2);
        expect(calls.lastIndexOf('start_chat')).toBeGreaterThan(
          calls.lastIndexOf('restart_integration_containers')
        );
      });

      it('a direct repeat of a routed pick right after its respawn restarts nothing again', async () => {
        everyCommandAnswers();
        await store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(count('start_chat')).toBe(1));

        await store.applyModelSelection(routedPick);
        await new Promise((r) => setTimeout(r, 0));

        expect(count('restart_integration_containers')).toBe(1);
        expect(count('start_chat')).toBe(1);
        expect(calls).not.toContain('switch_chat_model');
      });

      it("an older routed pick's failed re-render is reported when the newest pick could not be saved", async () => {
        let saves = 0;
        vi.spyOn(TestBed.inject(AnthropicModelsService), 'setProviderModel').mockImplementation(
          async () => {
            if (++saves === 2) throw new Error('config is locked');
          }
        );
        const first = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));
        await store.applyModelSelection(otherRoutedPick);
        expect(store.modelSelectionError()).toContain('config is locked');

        pendingRestart.reject(new Error('compose failed'));
        await first;

        expect(store.modelSelectionError()).toContain('compose failed');
      });

      it('a routed pick whose respawn fails to start is re-rendered when it is picked again', async () => {
        let starts = 0;
        mockTauri.invokeHandler = (cmd: string) => {
          calls.push(cmd);
          if (cmd === 'start_chat' && ++starts === 1) {
            return Promise.reject(new Error('failed to spawn claude'));
          }
          return Promise.resolve(undefined);
        };
        await store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(count('start_chat')).toBe(1));
        await new Promise((r) => setTimeout(r, 0));

        await store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(count('start_chat')).toBe(2));

        expect(count('restart_integration_containers')).toBe(2);
      });

      const otherRoutedPick = {
        ...routedPick,
        catalogId: 'qwen3',
        wireId: 'my-ollama/qwen3',
      };

      function count(cmd: string): number {
        return calls.filter((c) => c === cmd).length;
      }

      function everyCommandAnswers(): void {
        mockTauri.invokeHandler = (cmd: string) => {
          calls.push(cmd);
          return Promise.resolve(undefined);
        };
      }

      it('a repeat of the pick whose re-render the fresh start follows restarts nothing again', async () => {
        const pendingStart = createDeferred();
        mockTauri.invokeHandler = (cmd: string) => {
          calls.push(cmd);
          if (cmd === 'restart_integration_containers') return pendingRestart.promise;
          if (cmd === 'start_chat') return pendingStart.promise;
          return Promise.resolve(undefined);
        };

        const first = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));
        pendingRestart.resolve();
        await vi.waitFor(() => expect(callsAfterRestart()).toContain('start_chat'));
        const repeat = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(store.pendingModelOverride()).toBe(routedPick.wireId));
        pendingStart.resolve();
        await first;
        await repeat;
        await new Promise((r) => setTimeout(r, 0));

        expect(calls.filter((c) => c === 'restart_integration_containers')).toHaveLength(1);
        expect(callsAfterRestart().filter((c) => c === 'start_chat')).toHaveLength(1);
        expect(calls).not.toContain('switch_chat_model');
        expect(store.pendingModelOverride()).toBeNull();
      });

      it('a re-render that ends after a project switch started respawns nothing and reports nothing', async () => {
        const pick = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));
        mockTauri.dispatchEvent('project_switch_started', { project: 'other' });
        mockTauri.dispatchEvent('project_switch_failed', {
          project: 'test',
          error: 'switch failed',
        });
        pendingRestart.reject(new Error('compose failed'));
        await pick;
        await new Promise((r) => setTimeout(r, 0));

        expect(callsAfterRestart()).not.toContain('start_chat');
        expect(store.modelSelectionError()).toBe('');
      });

      it('a start that begins when the re-render ends keeps the chat: no second start', async () => {
        const pendingStart = createDeferred();
        mockTauri.invokeHandler = (cmd: string) => {
          calls.push(cmd);
          if (cmd === 'restart_integration_containers') return pendingRestart.promise;
          if (cmd === 'start_chat') return pendingStart.promise;
          return Promise.resolve(undefined);
        };
        const projectState = TestBed.inject(ProjectStateService);
        const unsubscribe = projectState.onProjectReady(() => {
          unsubscribe();
          void (store as unknown as { startChatSession(): Promise<unknown> }).startChatSession();
        });

        const pick = store.applyModelSelection(routedPick);
        await vi.waitFor(() => expect(calls).toContain('restart_integration_containers'));
        pendingRestart.resolve();
        await pick;
        pendingStart.resolve();
        await new Promise((r) => setTimeout(r, 0));

        expect(callsAfterRestart().filter((c) => c === 'start_chat')).toHaveLength(1);
      });
    });
  });
});
