import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  ChatStateService,
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
import { MockTauriService, MOCK_BUNDLE_RECONCILE_DONE } from '../testing/mock-tauri.service';
import type { ConversationTranscript, StreamChunk } from '../models/chat';
import { DEFAULT_CONTEXT_TOKENS } from '../models/llm';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

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

    // Reset state between tests
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
      // startChatSession is fire-and-forget — flush microtask queue
      await new Promise((r) => setTimeout(r, 0));

      // A non-auth start_chat failure surfaces in the UI.
      expect(projectState.status()).toBe('error');
      expect(projectState.error).toContain('chat backend crashed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to start chat session: Error: chat backend crashed')
      );
    });

    it('ignores a stale start_chat failure once a resume has superseded it', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();

      let failStartChat: (() => void) | null = null;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat') {
          await new Promise<void>((_resolve, reject) => {
            failStartChat = () => reject(new Error('chat backend crashed'));
          });
        }
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
        if (cmd === 'check_containers_running') return true;
        return undefined;
      };

      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      // A resume supersedes the in-flight start, then the stale start_chat fails.
      service.beginStartingSession();
      failStartChat!();
      await new Promise((r) => setTimeout(r, 0));

      // The superseded failure must NOT clobber the resumed session's state.
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
      // First init — projectState is not ready so chat may wait
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

      // Should not throw
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
      // String input is wrapped via `chatInputFromText` into a text-only
      // `ChatInput` and serialized to `WireContentBlock[]` for transport.
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

      // Wire format: pure text with the `@…` reference, no `image` block on stdin.
      expect(spy).toHaveBeenCalledWith('send_message', {
        blocks: [
          {
            type: 'text',
            text: 'Co tu widać?\n\n@/workspace/.speedwave/pastes/paste-1.png',
          },
        ],
        displayText: 'Co tu widać?',
      });
      // History entry holds a metadata-only image placeholder (no bytes).
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
      // Never streamed, never reached the backend.
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

      // First send_message fails → list_projects → start_chat → retry send_message
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

    it('waits (no competing start_chat) when a resume start is in progress', async () => {
      // A racing "no active session" send must wait for the in-flight resume,
      // not fire a competing start_chat that tears down the resumed session.
      let sendAttempt = 0;
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'send_message') {
          sendAttempt++;
          if (sendAttempt === 1) throw new Error('no active session');
          return undefined;
        }
        return undefined;
      };

      const endStartingSession = service.beginStartingSession();
      // Release the start shortly after, mimicking resume_conversation finishing.
      setTimeout(() => endStartingSession(), 20);

      await service.sendMessage('Resumed send');

      expect(calls).not.toContain('start_chat');
      expect(sendAttempt).toBe(2);
      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].role).toBe('user');
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
    // The backend's parse_control_command parses the wire blocks (built from
    // chatInput.text), never displayText — plan mode prefixes only the wire text.
    const PLAN_MODE_PREFIX = '[Plan mode] Produce a plan only.\n\n';

    it('suppresses the optimistic bubble when the wire text is control-shaped even though displayText carries a plan-mode prefix', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockResolvedValue(undefined);

      // Composer contract: payload (wire) gets prefixed in plan mode, displayText does not.
      await service.sendMessage(
        { text: '/model claude-sonnet-5', attachments: [] },
        '/model claude-sonnet-5'
      );

      // No optimistic bubble — the backend will emit a ControlChip for this wire text.
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
      // Composer contract: displayText is the unprefixed bubble text; here it
      // happens to look control-shaped even though the wire text is not.
      await service.sendMessage({ text: wireText, attachments: [] }, '/model claude-sonnet-5');

      // Backend's parse_control_command sees the prefixed wire text, which does not
      // match `^/(model|effort)\s+\S+$`, so no ControlChip is emitted — the bubble
      // must render, or the message would silently vanish from the UI.
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
        context_window_size: 200000,
        model: undefined,
        rate_limit: undefined,
      });
    });

    it('Result stores context_usage and the fit-gate tokens from the last API call', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'x' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: {
          session_id: 'abc',
          total_cost: 0.05,
          // Turn-sum usage is inflated (tool-heavy turn) — must not reach ctx.
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
      // 2 + 66,844 + 4,920 (input-only, no output)
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
      // Next turn: e.g. a local slash command — no API call, no context_usage.
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
      // get_conversation_cost is the SSOT total (no frontend delta sum); the
      // footer mirrors whatever the aggregator returns.
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
      // First turn: footer = the aggregator total, not CC's 0.99 estimate.
      expect(service.sessionStats?.total_cost).toBeCloseTo(0.2, 6);

      aggregatorTotal = 0.5; // proxy recorded a second turn; aggregator now sums both.
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'b' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_2', total_cost: 1.5 },
      });
      await new Promise((r) => setTimeout(r, 0));
      // Footer mirrors the aggregator (Rust sums the sidecar), no frontend delta.
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
      // Both turns' uuids must reach the aggregator, not just the latest.
      expect(sentIds).toContain('msg_1');
      expect(sentIds).toContain('msg_2');
    });

    it('lagging proxy append (get_usage_for_response null) keeps live CC and skips get_conversation_cost', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const spy = vi.spyOn(mockTauri, 'invoke');
      spy.mockImplementation(async (cmd: string) => {
        if (cmd === 'get_usage_for_response') return null; // proxy hasn't recorded this turn yet
        if (cmd === 'get_conversation_cost') return 9.99;
        return undefined;
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.42 },
      });
      await new Promise((r) => setTimeout(r, 0));
      // Line not present yet → footer stays on the live CC value, aggregator not consulted.
      expect(service.sessionStats?.total_cost).toBe(0.42);
      expect(spy).not.toHaveBeenCalledWith('get_conversation_cost', expect.anything());
    });

    it('reconcile hides the per-message cost when the proxy SSOT is free/null', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      vi.spyOn(mockTauri, 'invoke').mockImplementation(async (cmd: string) => {
        // Local is free → null cost (rendered "—"), never $0.00.
        if (cmd === 'get_usage_for_response') return { cost_usd: null, cost_source: 'free' };
        return undefined;
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        // CC reports a non-zero turn_cost (local estimate); proxy says free/null.
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
        // The turn's line is present (unpriced); the session aggregator returns
        // null (nothing priced) → footer stays null ("—"), not CC's estimate.
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
      // Subscription is unpriced → null (rendered "—"), replacing CC's $0.42 estimate.
      expect(service.sessionStats?.total_cost).toBeNull();
    });

    it('local provider suppresses the live CC cost preview (no $0.00x flicker)', async () => {
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      // Simulate an active local provider (no real cost).
      (service as unknown as { _currentProvider: string | null })._currentProvider = 'local';
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        // CC still emits an estimate for the local model; it must be ignored.
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
        // First read: OpenRouter cost deferred (null); later reads priced
        // (actual). Footer aggregator follows the same arc.
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
          // model + usage give the entry a `meta` so per-message cost can attach.
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
        // Initial reconcile: deferred keeps the live preview (footer 0.99), not
        // blanked; per-message stays on its preview (here undefined).
        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBeUndefined();
        expect(service.sessionStats?.total_cost).toBe(0.99);

        // OpenRouter finishes pricing; the retry must pick it up.
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
            turn_cost: 0.5, // CC preview attaches a visible per-message cost
            model: 'openrouter/anthropic/claude-haiku-4.5',
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        // Bug #31: deferred must NOT blank the flashed preview — it stays visible.
        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBe(0.5);
        expect(service.sessionStats?.total_cost).toBe(0.5);

        // Once OpenRouter prices it, the terminal value overwrites the preview.
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
        // OpenRouter can take far longer than the early backoff to price a
        // large generation; the retry window must outlast that.
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
            total_cost: 0.13, // inflated CC live preview
            turn_cost: 0.13,
            model: 'openrouter/z-ai/glm-5-turbo',
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        // Still deferred at first → preview stays.
        expect(service.messages.find((m) => m.uuid === 'msg_1')?.meta?.cost).toBe(0.13);

        // Advance past OpenRouter's pricing latency in small steps.
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
          return undefined; // send_message etc. resolve
        });

        service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'a' } });
        service.handleStreamChunk({
          chunk_type: 'Result',
          data: { session_id: 'abc', assistant_uuid: 'msg_1', total_cost: 0.1 },
        });
        await vi.advanceTimersByTimeAsync(0);
        const callsAfterFirst = calls;

        // A new turn (sendMessage bumps `_turnId`) must abandon msg_1's stale
        // deferred retry instead of firing through its backoff.
        await service.sendMessage('next question');
        await vi.advanceTimersByTimeAsync(10_000);

        // No unbounded growth: the superseded retry stopped (allow the in-flight one).
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
      // No state change ⇒ no rebuild ⇒ the state() signal keeps its identity.
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
      // Signal and getter agree.
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
    it('sends the pending Anthropic override once after SystemInit and clears it', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.setPendingModelOverride('claude-opus-4-8[1m]');

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-1' },
      });
      await Promise.resolve();

      const modelSendCall = invokeSpy.mock.calls.find(
        ([cmd, args]) =>
          cmd === 'send_message' && JSON.stringify(args).includes('/model claude-opus-4-8[1m]')
      );
      expect(modelSendCall).toBeTruthy();
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('does not resend the pending override on a second SystemInit', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.setPendingModelOverride('claude-opus-4-8[1m]');

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-1' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8[1m]', session_id: 'sess-1' },
      });
      await Promise.resolve();

      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('pendingModelOverride is null when nothing was set', () => {
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('applyEffortSelection with a live idle session sends the wire /effort immediately', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-live' },
      });
      await Promise.resolve();
      invokeSpy.mockClear();

      await service.applyEffortSelection('low');
      const effortSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort low')
      );
      expect(effortSend).toBeDefined();
    });

    it('applyEffortSelection mid-stream queues and flushes the wire /effort after the turn', async () => {
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
      await Promise.resolve();
      effortSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort xhigh')
      );
      expect(effortSend).toBeDefined();
    });

    it('applyEffortSelection without a live session sends nothing (the spawn --effort covers it)', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.applyEffortSelection('low');
      const effortSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/effort ')
      );
      expect(effortSend).toBeUndefined();
    });

    it('a queued override is NOT consumed by a SystemInit arriving mid-stream; it fires after the turn ends', async () => {
      // Field repro: session restart mid-send fires SystemInit while isStreaming
      // is true; the old code consumed the queue into sendMessage's silent drop.
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.setPendingModelOverride('claude-haiku-4-5');
      service.isStreaming = true;

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-restart' },
      });
      await Promise.resolve();
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');
      let modelSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSend).toBeUndefined();

      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'sess-restart' },
      } as never);
      await Promise.resolve();
      modelSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSend).toBeDefined();
      expect(JSON.stringify(modelSend?.[1])).toContain('/model claude-haiku-4-5');
      expect(service.pendingModelOverride()).toBeNull();
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
      });
      const modelSend = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSend).toBeUndefined();
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');
    });

    it('a queued override survives resetForNewConversation and fires on the fresh SystemInit', async () => {
      // The queue exists precisely to outlive a same-project fresh-session start
      // (pick with no live session -> type a message -> startFreshSession).
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.setPendingModelOverride('claude-haiku-4-5');

      service.resetForNewConversation();
      expect(service.pendingModelOverride()).toBe('claude-haiku-4-5');

      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'sess-new' },
      });
      await Promise.resolve();

      const modelSendCall = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSendCall).toBeDefined();
      expect(JSON.stringify(modelSendCall?.[1])).toContain('/model claude-haiku-4-5');
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('resumeConversation clears a queued override so a later SystemInit sends no /model', async () => {
      // The pick targeted the fresh session being composed, not an old transcript
      // the user resumes afterward — resuming must not leak it into that session.
      TestBed.inject(ProjectStateService).activeProject.set('test');
      mockTauri.invokeHandler = async () => undefined;
      service.setPendingModelOverride('claude-haiku-4-5');

      await service.resumeConversation('old-sess');
      expect(service.pendingModelOverride()).toBeNull();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-opus-4-8', session_id: 'old-sess' },
      });
      await Promise.resolve();

      const modelSendCall = invokeSpy.mock.calls.find(
        ([cmd, args]) => cmd === 'send_message' && JSON.stringify(args).includes('/model ')
      );
      expect(modelSendCall).toBeUndefined();
      expect(service.pendingModelOverride()).toBeNull();
    });

    it('a project switch clears a queued override so a later SystemInit sends no /model', async () => {
      // project_switch_started → 'switching' only fires once projectState.init()
      // has wired the Tauri listener (mirrors the 'resume on restart' setup).
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.setPendingModelOverride('claude-opus-4-8[1m]');

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

  describe('RateLimit chunk handling', () => {
    it('RateLimit with utilization updates sessionStats immediately if present', () => {
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });
      expect(service.sessionStats?.rate_limit).toBeUndefined();

      service.handleStreamChunk({
        chunk_type: 'RateLimit',
        data: { status: 'allowed_warning', utilization: 65, resets_at: 1738425600 },
      });

      expect(service.sessionStats?.rate_limit).toEqual({
        status: 'allowed_warning',
        utilization: 65,
        resets_at: 1738425600,
      });
    });

    it('RateLimit before Result is included when Result arrives', () => {
      service.handleStreamChunk({
        chunk_type: 'RateLimit',
        data: { status: 'allowed', utilization: 30, resets_at: null },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(service.sessionStats?.rate_limit).toEqual({
        status: 'allowed',
        utilization: 30,
        resets_at: null,
      });
    });

    it('RateLimit with null utilization does not store rate limit', () => {
      service.handleStreamChunk({
        chunk_type: 'RateLimit',
        data: { status: 'allowed', utilization: null, resets_at: null },
      });
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(service.sessionStats?.rate_limit).toBeUndefined();
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

    it('resetForNewConversation clears rate limit', () => {
      service.handleStreamChunk({
        chunk_type: 'RateLimit',
        data: { status: 'allowed', utilization: 50, resets_at: 123 },
      });
      service.resetForNewConversation();

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });
      service.handleStreamChunk({
        chunk_type: 'Result',
        data: { session_id: 'abc', total_cost: 0.05 },
      });

      expect(service.sessionStats?.rate_limit).toBeUndefined();
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

      // Reset wipes legacy fields and the rebuild projects an empty tree.
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
          meta: { cost: 0.13 }, // stale inflated preview from a deferred turn
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

      // A mutating chunk rebuilds the tree to a fresh identity and the
      // streaming projection reflects the new content.
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
      // The renderer pre-joins labels — service treats `value` as opaque.
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
      // _setState does not rebuild the tree — drive a chunk to trigger notifyChange().
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
      // Simulate a new Rust MessageBlock variant the TS union does not yet know.
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

  describe('auth error routing', () => {
    it('surfaces auth error as auth_required status', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      // Bypass normal init — set ready directly so startChatSession fires
      projectState.activeProject.set('test');
      projectState.status.set('ready');

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat')
          throw new Error('Claude is not authenticated. Please authenticate first.');
        return undefined;
      };

      await service.init();
      // startChatSession is fire-and-forget — flush microtask queue
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
      await service.sendMessage('hello');
      expect(projectState.status()).toBe('auth_required');
    });
  });

  describe('session startup timeout', () => {
    it('shows error when startingSession does not clear within deadline', async () => {
      // Invoke sendMessage without full init.
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') throw new Error('no active session');
        return undefined;
      };

      // Simulate startingSession permanently stuck true
      (service as unknown as { startingSession: boolean }).startingSession = true;

      // First 5 Date.now() calls return base, the rest return past the deadline.
      const base = 1000000;
      let nowCall = 0;
      const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
        nowCall++;
        return nowCall <= 5 ? base : base + 60_000;
      });

      await service.sendMessage('hello');
      spy.mockRestore();

      // Should have 2 messages: user + assistant error
      expect(service.messages).toHaveLength(2);
      const lastMsg = service.messages[1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.blocks[0].type).toBe('error');
      expect((lastMsg.blocks[0] as { content: string }).content).toContain(
        'Session is still starting'
      );
      expect(service.isStreaming).toBe(false);
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
      // partial assistant + error block from the failed stop = 2 messages.
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
      // Only the partial assistant message — no extra error block.
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
      // Real dispatch order: Result flips isStreaming=false, THEN the backend
      // drain emits QueueDrained; dropping it strands the chip + the new turn.
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

      // The dispatched turn's content must now flow (it used to be dropped).
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
      // Simulate a buffered chunk from the dying turn arriving after stop.
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Text',
        data: { content: 'late content from stopped turn' },
      });
      expect(service.isStreaming).toBe(false);
      expect(service.currentBlocks).toEqual([]);
      // Must not be appended — only the (empty) partial-then-stop noop ran.
      const lateText = service.messages.some((m) =>
        m.blocks.some((b) => b.type === 'text' && b.content === 'late content from stopped turn')
      );
      expect(lateText).toBe(false);
    });

    it('RateLimit chunk dispatched after Result still updates sessionStats.rate_limit', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
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
      const before = service.sessionStats;
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'RateLimit',
        data: { status: 'ok', utilization: 0.42, resets_at: '2026-04-18T12:00:00Z' },
      });
      expect(service.sessionStats).not.toBe(before);
      expect(service.sessionStats?.rate_limit).toEqual({
        status: 'ok',
        utilization: 0.42,
        resets_at: '2026-04-18T12:00:00Z',
      });
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
      let rejectAnswer: (err: Error) => void = () => {};
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'submit_question_answer') {
          return new Promise<undefined>((_, rej) => {
            rejectAnswer = rej;
          });
        }
        return undefined;
      };
      const answerPromise = service.submitAnswer('t1', 0, 'A');
      await service.stopConversation();
      rejectAnswer(new Error('Broken pipe'));
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
      // Already-committed entries are untouched.
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
      // Same object — no mutation, no replacement.
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
      expect(service.lastContextTokens).toBe(24771); // durable across reset
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
          rate_limit: undefined,
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
          rate_limit: undefined,
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
          rate_limit: undefined,
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
      // No setup — empty session, no anchor.
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
      // Original two entries restored, plus an error-bearing assistant entry.
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
          rate_limit: undefined,
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
          rate_limit: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;

      // The trailing chip sits after the last assistant, so the anchor picker
      // never reaches it; the real question before that assistant stays the anchor.
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
          rate_limit: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;

      // The user entry immediately before the last assistant is a chip; the picker
      // stops at it rather than proposing a command as a retry target.
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
          rate_limit: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;
      // _setState does not rebuild the tree — drive a chunk to trigger notifyChange()
      // so `retryEnabled` (which reads the projected state tree, not legacy fields)
      // observes the chip. Before the fix, the chip block was dropped to `[]` by
      // `messageBlocksToState`, so this guard could never see it via this signal.
      service.handleStreamChunk({
        chunk_type: 'RateLimit',
        data: { status: 'ok', utilization: null, resets_at: null },
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
          rate_limit: undefined,
          context_window_size: 200_000,
          total_output_tokens: 0,
        },
      });
      service.isStreaming = false;
      service.handleStreamChunk({
        chunk_type: 'RateLimit',
        data: { status: 'ok', utilization: null, resets_at: null },
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
      // Backend turn_cost wins (authoritative)
      expect(meta?.cost).toBe(0.018);
    });

    it('does not compute cost on the frontend when backend omits turn_cost', () => {
      // No frontend pricing (proxy is SSOT): absent turn_cost leaves cost
      // undefined until reconcileFooterCost fills it from the proxy.
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
          // turn_cost intentionally omitted
        },
      });

      const meta = service.messages[0].meta;
      // model + usage are still recorded; cost stays undefined (no fabrication).
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

      // Provisional: no turn_cost → cost stays undefined (no frontend pricing).
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
          // Provisional: backend still computing authoritative cost
        },
      });

      // After provisional: model recorded, cost undefined (no frontend pricing).
      const provisional = service.messages[0].meta;
      expect(provisional?.model).toBe('claude-haiku-4-5');
      expect(provisional?.cost).toBeUndefined();

      // Simulate final Result in a fresh assistant turn — replaces the
      // previous entry behaviour is per-turn. Test that turn_cost wins.
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
          turn_cost: 0.007, // authoritative — overrides pricing.ts fallback
        },
      });

      expect(service.messages).toHaveLength(2);
      const finalMeta = service.messages[1].meta;
      expect(finalMeta?.cost).toBe(0.007);
    });
  });

  // ── ADR-045 — queued message ─────────────────────────────────────────────
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
          rate_limit: null,
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
      // No silent drop: the slot (and chip) exist immediately, backend waits.
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

      // A late session id must NOT resurrect the cancelled message.
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
      // The chip must not vanish on a failed registration — no silent drop.
      expect(service.pendingQueue?.text).toBe('next');
    });

    it('resetForNewConversation clears pendingQueue', () => {
      service._setState({ pendingQueue: { text: 'leftover', queued_at: 1 } });
      service.resetForNewConversation();
      expect(service.pendingQueue).toBeNull();
    });
  });

  // ── ADR-042 — state-tree signal projections (legacy fields → tree) ──────
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
      // _setState does NOT trigger notifyChange — drive a chunk to fire it.
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
      // Same reference — nothing replaced.
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
      // Internal state — accessed through a controlled cast since the field
      // is intentionally private.
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
      // Regression guard: dedupe was removed (cheap command) — skipping
      // re-fetches per project silently broke the post-save footer refresh.
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
    // resolveContextWindow is private; cast to assert on each tier directly.
    type Internal = {
      resolveContextWindow: (live: number | undefined, model: string | undefined) => number;
      _persistedContextTokens: number | null;
      _contextWindowSize: number;
    };

    it('prefers the live stream value over every fallback', () => {
      const internal = service as unknown as Internal;
      internal._persistedContextTokens = 16_384;
      internal._contextWindowSize = 8_192;
      expect(internal.resolveContextWindow(500_000, 'claude-opus-4-7')).toBe(500_000);
    });

    it('falls back to the Anthropic SSOT when no live value is available', async () => {
      // Populate the injected AnthropicModelsService cache via its public
      // list() once with a fixture backend.
      const anthropic = TestBed.inject(AnthropicModelsService);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_anthropic_models') {
          return [
            {
              id: 'claude-opus-4-7',
              family: 'Opus 4.7',
              context_tokens: 1_000_000,
              latest: true,
              premium: true,
            },
          ];
        }
        return undefined;
      };
      await anthropic.list();
      const internal = service as unknown as Internal;
      expect(internal.resolveContextWindow(undefined, 'claude-opus-4-7')).toBe(1_000_000);
    });

    it('falls back to persisted context_tokens when SSOT and live are absent', () => {
      const internal = service as unknown as Internal;
      internal._persistedContextTokens = 32_768;
      internal._contextWindowSize = 8_192;
      expect(internal.resolveContextWindow(undefined, 'unknown-model')).toBe(32_768);
    });

    it('falls back to previous _contextWindowSize when persisted is also absent', () => {
      const internal = service as unknown as Internal;
      internal._persistedContextTokens = null;
      internal._contextWindowSize = 65_536;
      expect(internal.resolveContextWindow(undefined, 'unknown-model')).toBe(65_536);
    });

    it('falls back to DEFAULT_CONTEXT_TOKENS as the last resort', () => {
      const internal = service as unknown as Internal;
      internal._persistedContextTokens = null;
      internal._contextWindowSize = 0;
      expect(internal.resolveContextWindow(undefined, undefined)).toBe(DEFAULT_CONTEXT_TOKENS);
    });
  });

  // ── mapContextOverflowError ────────────────────────────────────────────────

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

  // ── mapNotLoggedInError ─────────────────────────────────────────────────────

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

  // ── isNotAuthenticatedError gate predicate ─────────────────────────────────

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

  // ── handleStreamChunk Error — context-overflow mapping ────────────────────

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

  // ── handleStreamChunk Error — not-logged-in mapping ────────────────────────

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

  // ── resume on restart (service-owned, survives an unmounted ChatComponent) ──

  describe('resume on restart', () => {
    /** Casts onto the private restart-lifecycle notifiers used to drive the path. */
    type RestartInternal = {
      notifyRestartBegin(): Promise<void>;
      notifyReady(): void;
    };
    /** Casts onto private token fields so a test can force history (not) fitting. */
    type TokensInternal = {
      _lastContextTokens: number | null;
      _persistedContextTokens: number | null;
    };

    /**
     * Fires restart-begin (interrupt) then restart-complete (resume) + flush.
     * @param projectState - ProjectStateService instance to notify.
     */
    async function fireRestart(projectState: ProjectStateService): Promise<void> {
      await (projectState as unknown as RestartInternal).notifyRestartBegin();
      projectState.notifyRestartComplete();
      await new Promise((r) => setTimeout(r, 0));
    }

    let projectState: ProjectStateService;

    beforeEach(async () => {
      projectState = TestBed.inject(ProjectStateService);
      // projectState.init() wires the Tauri listeners that translate
      // project_switch_started → 'switching' for the switch-clears-id test.
      await projectState.init();
      projectState.activeProject.set('test');
      await service.init();
    });

    it('resumes the durable session with NO ChatComponent mounted (key regression)', async () => {
      // No decider registered (component never mounted) → service auto-resumes.
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
              // Trailing sidechain (subagent) line: history.rs strips its
              // usage, so the seed must fall back to the previous message.
              { role: 'assistant', content: 'subagent output' },
            ],
          };
        }
        return undefined;
      };

      await fireRestart(projectState);

      // Last usage-bearing main-chain call wins — truthful before any live Result.
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
              // Trailing main-chain line with all-zero usage (e.g. an aborted
              // API call) must not overwrite the real prior context occupancy.
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
      // History exceeds the window → would prompt if mounted; unmounted ⇒ resume.
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

      // 'fresh' must NOT resume, MUST start a clean session, and clear the durable id.
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

    it('re-reads the llm config so a GROWN post-restart window auto-resumes without asking', async () => {
      service.seedSessionId('sess-window');
      (service as unknown as TokensInternal)._lastContextTokens = 25229;
      // Stale cache from the PREVIOUS model: too small — would wrongly ask.
      (service as unknown as TokensInternal)._persistedContextTokens = 8192;
      const decider = vi.fn(() => Promise.resolve('fresh' as const));
      service.setResumeDecider(decider);
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        // The post-restart model has a big window: history fits.
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
      // Stale cache from the PREVIOUS model: big — would wrongly auto-resume.
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

      // The decision saw the NEW (smaller) window and asked the mounted view.
      expect(decider).toHaveBeenCalledTimes(1);
      expect(calls).toContain('resume_conversation'); // decider chose resume
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
      // Regression: resetForNewConversation zeroed `initialized`, so the remount
      // init() started a fresh start_chat that clobbered the in-flight resume.
      projectState.status.set('ready');
      service.seedSessionId('sess-mid');
      let releaseResume: (() => void) | null = null;
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'get_conversation') {
          return {
            session_id: 'sess-mid',
            messages: [{ role: 'user', blocks: [{ type: 'text', content: 'restored' }] }],
          };
        }
        if (cmd === 'resume_conversation') {
          await new Promise<void>((resolve) => {
            releaseResume = resolve;
          });
        }
        return undefined;
      };

      const restartDone = fireRestart(projectState);
      // The llm-config re-read precedes the resume RPC; wait until it's in flight.
      await vi.waitFor(() => {
        expect(releaseResume).not.toBeNull();
      });
      // Remount while resume is still in flight.
      await service.init();
      releaseResume!();
      await restartDone;

      // The released resume pipeline settles asynchronously; wait for its load.
      await vi.waitFor(() => {
        expect(service.messagesFromState()[0]?.blocks[0]).toEqual({
          type: 'text',
          content: 'restored',
        });
      });
      // Asserted after full settle: even a late competing start_chat would show.
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
      // Resume finished: _resumeInProgress is false but _lastKnownSessionId holds.
      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(calls).not.toContain('start_chat');
      expect(service.lastKnownSessionId).toBe('sess-done');
    });

    it('newConversation reset then init() still starts a fresh session', async () => {
      // Negative control: the guard must not block the legitimate fresh-start path.
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

  // ── resumeConversation transcript failure (non-blocking notice) ────────────

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
      // Session stays live: durable + footer ids seeded so retry/queue work.
      expect(service.lastKnownSessionId).toBe('sess-notice');
      expect(service.sessionStats?.session_id).toBe('sess-notice');
      expect(service.isStreaming).toBe(false);
      // Non-blocking notice explains the empty scrollback.
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

  // ── historyFitsTarget pure predicate ───────────────────────────────────────

  describe('historyFitsTarget', () => {
    it('fits, exceeds, and unknown', () => {
      expect(historyFitsTarget(8000, 131072)).toBe(true);
      expect(historyFitsTarget(25229, 8192)).toBe(false);
      expect(historyFitsTarget(null, 8192)).toBe(true); // no history → safe to resume
      expect(historyFitsTarget(25229, null)).toBe(false); // unknown window → ask, don't auto-resume
      expect(historyFitsTarget(8192, 8192)).toBe(false); // equal → does NOT fit
    });
  });

  // ── toChatMessages per-message meta (resumed footer) ────────────────────────

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

  // ── toChatMessages — history tool-block normalization ──────────────────────

  describe('toChatMessages history tool-block normalization', () => {
    /**
     * Wraps raw history-shaped blocks into a one-message transcript.
     * @param blocks - Raw blocks as the backend history payload ships them.
     */
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
      // Rust serializes the chip as `type: control_chip`; the frontend renders it
      // via the `type: chip` variant so a resumed chip matches the live path exactly.
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
      // A live session already has a seeded session id.
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'my-or/anthropic/claude-sonnet-5', session_id: 'sess-1' },
      });

      const pending = service.applyModelSelection({
        catalogId: 'anthropic/claude-haiku-4-5',
        wireId: 'my-or/anthropic/claude-haiku-4-5',
        providerId: 'my-or',
        kind: 'open_router',
      });
      expect(calls).toEqual(['setProviderModel-start']);
      resolveSet();
      await pending;
      expect(calls).toEqual(['setProviderModel-start', 'setProviderModel-resolved', 'sendMessage']);
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
      });

      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(service.modelSelectionError()).toContain('locked config');
    });

    it('sends the wire command directly for a live anthropic selection (no config write-through)', async () => {
      const service = TestBed.inject(ChatStateService);
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      const setProviderModelSpy = vi.spyOn(anthropicModels, 'setProviderModel');
      const sendMessageSpy = vi.spyOn(service, 'sendMessage').mockResolvedValue(undefined);
      service.handleStreamChunk({
        chunk_type: 'SystemInit',
        data: { model: 'claude-sonnet-5', session_id: 'sess-2' },
      });

      await service.applyModelSelection({
        catalogId: 'claude-opus-4-8',
        wireId: 'claude-opus-4-8',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
      });

      expect(setProviderModelSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledWith('/model claude-opus-4-8');
    });

    it('queues a pending anthropic override, not a wire send, when no session is live', async () => {
      const service = TestBed.inject(ChatStateService);
      const sendMessageSpy = vi.spyOn(service, 'sendMessage').mockResolvedValue(undefined);

      await service.applyModelSelection({
        catalogId: 'claude-opus-4-8',
        wireId: 'claude-opus-4-8',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
      });

      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(service.pendingModelOverride()).toBe('claude-opus-4-8');
    });

    it('does nothing further for a no-session non-anthropic selection beyond the write-through', async () => {
      const service = TestBed.inject(ChatStateService);
      TestBed.inject(ProjectStateService).activeProject.set('proj');
      const anthropicModels = TestBed.inject(AnthropicModelsService);
      const setProviderModelSpy = vi
        .spyOn(anthropicModels, 'setProviderModel')
        .mockResolvedValue(undefined);
      const sendMessageSpy = vi.spyOn(service, 'sendMessage').mockResolvedValue(undefined);

      await service.applyModelSelection({
        catalogId: 'llama4',
        wireId: 'my-ollama/llama4',
        providerId: 'my-ollama',
        kind: 'local',
      });

      expect(setProviderModelSpy).toHaveBeenCalledWith(expect.any(String), 'my-ollama', 'llama4');
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(service.pendingModelOverride()).toBeNull();
    });
  });
});
