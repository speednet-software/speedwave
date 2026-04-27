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

  describe('copyMessage', () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
    });

    it('writes flattened text content to the clipboard and returns true', async () => {
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
      const ok = await service.copyMessage(0);
      expect(ok).toBe(true);
      expect(writeText).toHaveBeenCalledWith('Hello\n\nWorld');
    });

    it('returns false for an out-of-range index', async () => {
      const ok = await service.copyMessage(99);
      expect(ok).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
    });

    it('returns false when there is no copyable text (only tool_use/thinking)', async () => {
      service._setState({
        messages: [
          {
            role: 'assistant',
            blocks: [{ type: 'thinking', content: 'hmm', collapsed: true }],
            timestamp: 1,
          },
        ],
      });
      const ok = await service.copyMessage(0);
      expect(ok).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
    });

    it('returns false when navigator.clipboard is missing', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
      });
      service._setState({
        messages: [{ role: 'assistant', blocks: [{ type: 'text', content: 'x' }], timestamp: 1 }],
      });
      const ok = await service.copyMessage(0);
      expect(ok).toBe(false);
    });

    it('returns false when clipboard.writeText rejects', async () => {
      writeText.mockRejectedValueOnce(new Error('denied'));
      service._setState({
        messages: [{ role: 'assistant', blocks: [{ type: 'text', content: 'x' }], timestamp: 1 }],
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ok = await service.copyMessage(0);
      expect(ok).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
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

    it('falls back to pricing.ts cost calculation when backend omits turn_cost', () => {
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
      expect(meta?.cost).toBeCloseTo(3, 6); // 1M input * $3/1M for Sonnet
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
      // Mimics the Feature-3 patch stream: text streams in, then a
      // provisional meta arrives (no turn_cost yet), then a final Result
      // overrides the provisional values.
      service.handleStreamChunk({ chunk_type: 'Text', data: { content: 'Hi.' } });

      // Provisional: usage without turn_cost — the frontend should fall
      // back to pricing.ts. First finalize (provisional Result).
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

      // After provisional: meta.cost is the pricing.ts fallback
      // Haiku: 1000 * 1 / 1M + 500 * 5 / 1M = 0.001 + 0.0025 = 0.0035
      const provisional = service.messages[0].meta;
      expect(provisional?.model).toBe('claude-haiku-4-5');
      expect(provisional?.cost).toBeCloseTo(0.0035, 6);

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

    it('queueMessage no-ops without a session id', async () => {
      service._setState({ sessionStats: null });
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      const prior = await service.queueMessage('next');
      expect(prior).toBeNull();
      expect(calls).not.toContain('queue_message');
      expect(service.pendingQueue).toBeNull();
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

    it('queueMessage swallows backend errors and leaves slot untouched', async () => {
      setSession('s-1');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'queue_message') throw new Error('backend down');
        return undefined;
      };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const prior = await service.queueMessage('next');
      warnSpy.mockRestore();
      expect(prior).toBeNull();
      expect(service.pendingQueue).toBeNull();
    });

    it('resetForNewConversation clears pendingQueue', () => {
      service._setState({ pendingQueue: { text: 'leftover', queued_at: 1 } });
      service.resetForNewConversation();
      expect(service.pendingQueue).toBeNull();
    });
  });

  // ── ADR-042/043 — JSON Patch state-tree reducer ──────────────────────────
  describe('state-tree signal + applyLogMsg', () => {
    it('initial state matches DEFAULT_STATE_TREE', () => {
      const s = service.state();
      expect(s.session_id).toBeNull();
      expect(s.entries).toEqual([]);
      expect(s.is_streaming).toBe(false);
      expect(s.pending_queue).toBeNull();
      expect(s.session_totals.cost).toBe(0);
    });

    it('SessionStarted lifecycle commits session_id', () => {
      service.applyLogMsg({ type: 'session_started', data: { session_id: 'abc-123' } });
      expect(service.state().session_id).toBe('abc-123');
    });

    it('JsonPatch sets is_streaming to true via /is_streaming', () => {
      service.applyLogMsg({
        type: 'json_patch',
        data: [{ op: 'replace', path: '/is_streaming', value: true }],
      });
      expect(service.state().is_streaming).toBe(true);
    });

    it('JsonPatch sequence stays consistent (apply then apply equals composed)', () => {
      // Bring up an entry then replace its text — final state must match
      // a single composed patch (associativity property).
      service.applyLogMsg({
        type: 'json_patch',
        data: [
          {
            op: 'add',
            path: '/entries/0',
            value: {
              index: 0,
              role: 'assistant',
              uuid: null,
              uuid_status: 'pending',
              blocks: [{ kind: 'text', content: '' }],
              meta: null,
              edited_at: null,
              timestamp: 1,
            },
          },
        ],
      });
      service.applyLogMsg({
        type: 'json_patch',
        data: [{ op: 'replace', path: '/entries/0/blocks/0/content', value: 'hi' }],
      });
      expect(service.state().entries).toHaveLength(1);
      const entry = service.state().entries[0];
      expect(entry.blocks[0]).toEqual({ kind: 'text', content: 'hi' });
    });

    it('Resync replaces the entire state-tree wholesale', () => {
      service.applyLogMsg({
        type: 'session_started',
        data: { session_id: 'old' },
      });
      service.applyLogMsg({
        type: 'resync',
        data: {
          session_id: 'replaced',
          entries: [],
          session_totals: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
            cost: 0.5,
            turn_count: 1,
          },
          pending_queue: null,
          model: 'opus-4.7',
          is_streaming: false,
        },
      });
      const s = service.state();
      expect(s.session_id).toBe('replaced');
      expect(s.session_totals.input_tokens).toBe(1);
      expect(s.model).toBe('opus-4.7');
    });

    it('SessionEnded forces is_streaming back to false', () => {
      service.applyLogMsg({
        type: 'json_patch',
        data: [{ op: 'replace', path: '/is_streaming', value: true }],
      });
      expect(service.state().is_streaming).toBe(true);
      service.applyLogMsg({ type: 'session_ended' });
      expect(service.state().is_streaming).toBe(false);
    });

    it('Bad patch is dropped without throwing or mutating state', () => {
      const before = service.state();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      service.applyLogMsg({
        type: 'json_patch',
        data: [{ op: 'replace', path: '/missing/key/that/does/not/exist', value: 1 }],
      });
      warnSpy.mockRestore();
      expect(service.state()).toBe(before);
    });

    it('subscribeToSession invokes subscribe_session and listens on the returned event', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = [];
      const listenCalls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'subscribe_session') return { event_name: 'chat_patch::sess-1' };
        return undefined;
      };
      mockTauri.listen = (async (event: string, _handler: unknown) => {
        listenCalls.push(event);
        return () => undefined;
      }) as typeof mockTauri.listen;

      await service.subscribeToSession('sess-1');
      expect(calls).toEqual([{ cmd: 'subscribe_session', args: { sessionId: 'sess-1' } }]);
      expect(listenCalls).toEqual(['chat_patch::sess-1']);
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

    it('subscribeToSession is idempotent for the same session id', async () => {
      const calls: Array<{ cmd: string }> = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push({ cmd });
        if (cmd === 'subscribe_session') return { event_name: 'chat_patch::sess-x' };
        return undefined;
      };
      mockTauri.listen = (async () => () => undefined) as typeof mockTauri.listen;
      await service.subscribeToSession('sess-x');
      await service.subscribeToSession('sess-x');
      const subscribeCalls = calls.filter((c) => c.cmd === 'subscribe_session');
      expect(subscribeCalls).toHaveLength(1);
    });
  });

  describe('seedResumedSession', () => {
    it('stamps the session id when none is set so retry/queue work pre-Result', () => {
      service._setState({ messages: [], currentBlocks: [], sessionStats: null });
      service.seedResumedSession('resumed-sess-1');
      expect(service.sessionStats?.session_id).toBe('resumed-sess-1');
      expect(service.sessionStats?.total_cost).toBe(0);
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
      service.seedResumedSession('sess-x');
      // Same reference — nothing replaced.
      expect(service.sessionStats).toBe(before);
      expect(service.sessionStats?.total_cost).toBe(0.123);
    });

    it('refuses an empty session id', () => {
      service._setState({ messages: [], currentBlocks: [], sessionStats: null });
      service.seedResumedSession('');
      expect(service.sessionStats).toBeNull();
    });
  });
});
