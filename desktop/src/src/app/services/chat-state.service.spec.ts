import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChatStateService } from './chat-state.service';
import { ProjectStateService } from './project-state.service';
import { TauriService } from './tauri.service';
import { MockTauriService, MOCK_BUNDLE_RECONCILE_DONE } from '../testing/mock-tauri.service';
import type { StreamChunk } from '../models/chat';

describe('ChatStateService', () => {
  let service: ChatStateService;
  let mockTauri: MockTauriService;

  beforeEach(() => {
    mockTauri = new MockTauriService();

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
          return { api_key_configured: false, oauth_authenticated: true };
        case 'start_chat':
          return undefined;
        case 'send_message':
          return undefined;
        default:
          return undefined;
      }
    };

    TestBed.configureTestingModule({
      providers: [ChatStateService, { provide: TauriService, useValue: mockTauri }],
    });

    service = TestBed.inject(ChatStateService);

    // Reset state between tests
    service._setState({ messages: [], currentBlocks: [], sessionStats: null });
    service.isStreaming = false;
  });

  describe('init', () => {
    it('logs startChatSession error without blocking projectState', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      // start_chat failure should NOT block projectState — containers are still running,
      // only the Claude session failed (rate limit, OOM, etc). sendMessage auto-retry
      // handles session recovery.
      expect(projectState.status).toBe('ready');
      expect(errorSpy).toHaveBeenCalledWith('Failed to start chat session:', expect.any(Error));
      errorSpy.mockRestore();
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
      expect(projectState.status).toBe('error');
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
      expect(spy).toHaveBeenCalledWith('send_message', { message: 'Hello' });
    });

    it('ignores empty text', async () => {
      await service.sendMessage('');
      expect(service.messages).toHaveLength(0);
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
      if (block.type === 'tool_use') {
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
      if (block.type === 'tool_use') {
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
      const cb = vi.fn();
      service.onChange(cb);

      service.handleStreamChunk({
        chunk_type: 'UnknownFutureType' as StreamChunk['chunk_type'],
        data: {},
      } as StreamChunk);

      expect(cb).not.toHaveBeenCalled();
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

    it('notifies change listeners', () => {
      const cb = vi.fn();
      service.onChange(cb);

      service.resetForNewConversation();

      expect(cb).toHaveBeenCalled();
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
  });

  describe('onChange', () => {
    it('notifies listeners on stream chunk', () => {
      const cb = vi.fn();
      service.onChange(cb);

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });

      expect(cb).toHaveBeenCalled();
    });

    it('returns unsubscribe function', () => {
      const cb = vi.fn();
      const unsub = service.onChange(cb);
      unsub();

      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hi' } });

      expect(cb).not.toHaveBeenCalled();
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
    it('adds ask_user block to currentBlocks', () => {
      const chunk: StreamChunk = {
        chunk_type: 'AskUserQuestion',
        data: {
          tool_id: 'toolu_ask1',
          question: 'Pick a fruit',
          options: [
            { label: 'Apple', value: 'apple' },
            { label: 'Banana', value: 'banana' },
          ],
          header: 'Fruits',
          multi_select: false,
        },
      };
      service.handleStreamChunk(chunk);

      expect(service.currentBlocks).toHaveLength(1);
      const block = service.currentBlocks[0];
      expect(block.type).toBe('ask_user');
      if (block.type === 'ask_user') {
        expect(block.question.tool_id).toBe('toolu_ask1');
        expect(block.question.question).toBe('Pick a fruit');
        expect(block.question.options).toHaveLength(2);
        expect(block.question.answered).toBe(false);
      }
    });

    it('answerQuestion marks block as answered and calls backend', async () => {
      service.handleStreamChunk({
        chunk_type: 'AskUserQuestion',
        data: {
          tool_id: 'toolu_ask1',
          question: 'Pick one',
          options: [{ label: 'A', value: 'a' }],
          header: '',
          multi_select: false,
        },
      });

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.answerQuestion('toolu_ask1', ['a']);

      const block = service.currentBlocks[0];
      if (block.type === 'ask_user') {
        expect(block.question.answered).toBe(true);
        expect(block.question.selected_values).toEqual(['a']);
      }

      expect(invokeSpy).toHaveBeenCalledWith('answer_question', {
        toolUseId: 'toolu_ask1',
        answer: 'a',
      });
    });

    it('answerQuestion adds error block, resets isStreaming, and reverts answered state on failure', async () => {
      service.isStreaming = true;
      service.handleStreamChunk({
        chunk_type: 'AskUserQuestion',
        data: {
          tool_id: 'toolu_ask1',
          question: 'Pick one',
          options: [{ label: 'A', value: 'a' }],
          header: '',
          multi_select: false,
        },
      });

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'answer_question') throw new Error('pipe broken');
        return undefined;
      };

      await service.answerQuestion('toolu_ask1', ['a']);

      expect(service.isStreaming).toBe(false);

      const askBlock = service.currentBlocks.find(
        (b) => b.type === 'ask_user' && b.question.tool_id === 'toolu_ask1'
      );
      expect(askBlock).toBeDefined();
      if (askBlock && askBlock.type === 'ask_user') {
        expect(askBlock.question.answered).toBe(false);
        expect(askBlock.question.selected_values).toEqual([]);
      }

      const lastBlock = service.currentBlocks[service.currentBlocks.length - 1];
      expect(lastBlock.type).toBe('error');
      if (lastBlock.type === 'error') {
        expect(lastBlock.content).toContain('Failed to send answer');
      }
    });

    it('answerQuestion with stale tool_use_id does not throw and calls backend', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.answerQuestion('toolu_nonexistent', ['yes']);

      expect(service.currentBlocks).toHaveLength(0);
      expect(invokeSpy).toHaveBeenCalledWith('answer_question', {
        toolUseId: 'toolu_nonexistent',
        answer: 'yes',
      });
    });

    it('answerQuestion joins multiple values with comma', async () => {
      service.handleStreamChunk({
        chunk_type: 'AskUserQuestion',
        data: {
          tool_id: 'toolu_ask1',
          question: 'Pick fruits',
          options: [
            { label: 'A', value: 'apple' },
            { label: 'B', value: 'banana' },
          ],
          header: '',
          multi_select: true,
        },
      });

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.answerQuestion('toolu_ask1', ['apple', 'banana']);

      expect(invokeSpy).toHaveBeenCalledWith('answer_question', {
        toolUseId: 'toolu_ask1',
        answer: 'apple, banana',
      });
    });
  });

  describe('auth error routing', () => {
    it('surfaces auth error as auth_required status', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      // Bypass normal init — set ready directly so startChatSession fires
      projectState.activeProject = 'test';
      projectState.status = 'ready';

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat')
          throw new Error('Claude is not authenticated. Please authenticate first.');
        return undefined;
      };

      await service.init();
      // startChatSession is fire-and-forget — flush microtask queue
      await new Promise((r) => setTimeout(r, 0));
      expect(projectState.status).toBe('auth_required');
    });

    it('routes auth error in sendMessage retry to auth_required', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      projectState.activeProject = 'test';
      projectState.status = 'ready';

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
      expect(projectState.status).toBe('auth_required');
    });
  });

  describe('session startup timeout', () => {
    it('shows error when startingSession does not clear within deadline', async () => {
      // Directly invoke sendMessage without full init — we only need the
      // retry path and the startingSession flag.
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') throw new Error('no active session');
        return undefined;
      };

      // Simulate startingSession permanently stuck true
      (service as unknown as { startingSession: boolean }).startingSession = true;

      // Mock Date.now to make the deadline expire immediately.
      // sendMessage calls: (1) user-msg timestamp, (2) deadline = Date.now() + 30_000,
      // (3+) while-loop condition Date.now() < deadline.
      // Track Date.now() calls.  We need the deadline setup call to
      // return `base` and all subsequent calls to return past the
      // deadline.  Use a generous threshold: the first 5 calls return
      // base (covers user-msg timestamp, notifyChange(), deadline setup,
      // plus any framework overhead).  After that, jump past the
      // deadline so the while loop exits on the next iteration.
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

    it('answerQuestion: stopConversation wins the race, no error block is appended', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
      service.isStreaming = true;
      service._setState({
        currentBlocks: [
          {
            type: 'ask_user',
            question: {
              tool_id: 't1',
              question: 'q?',
              options: [{ value: 'a', label: 'A' }],
              header: '',
              multi_select: false,
              answered: false,
              selected_values: [],
            },
          },
        ],
      });
      let rejectAnswer: (err: Error) => void = () => {};
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'answer_question') {
          return new Promise<undefined>((_, rej) => {
            rejectAnswer = rej;
          });
        }
        return undefined;
      };
      const answerPromise = service.answerQuestion('t1', ['a']);
      await service.stopConversation();
      rejectAnswer(new Error('Broken pipe'));
      await answerPromise;
      expect(service.messages.every((m) => m.blocks.every((b) => b.type !== 'error'))).toBe(true);
      expect(service.currentBlocks).toEqual([]);
    });
  });
});
