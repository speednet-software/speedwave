import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChatStateService } from './chat-state.service';
import { ProjectStateService } from './project-state.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
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

    TestBed.configureTestingModule({
      providers: [ChatStateService, { provide: TauriService, useValue: mockTauri }],
    });

    service = TestBed.inject(ChatStateService);

    // Reset state between tests
    service._setState({ messages: [], currentBlocks: [], sessionStats: null });
    service.isStreaming = false;
    service.containerStatus = 'checking';
    service.containerError = '';
  });

  describe('init', () => {
    it('only runs checkContainers once', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.init();
      const firstCallCount = spy.mock.calls.filter((c) => c[0] === 'start_chat').length;

      await service.init();
      const secondCallCount = spy.mock.calls.filter((c) => c[0] === 'start_chat').length;

      expect(firstCallCount).toBe(1);
      expect(secondCallCount).toBe(1);
    });
  });

  describe('setupStreamListener error handling', () => {
    it('ignores listen failure when not running inside Tauri', async () => {
      mockTauri.listen = async () => {
        throw new Error('Tauri not available');
      };

      await service.init();

      expect(service.containerStatus).not.toBe('error');
    });

    it('sets error status when listen fails inside Tauri', async () => {
      const failingMock = new MockTauriService();
      // Simulate Tauri runtime presence via the shared method
      failingMock.isRunningInTauri = () => true;
      failingMock.listen = async () => {
        throw new Error('IPC failure');
      };
      failingMock.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'list_projects':
            return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
          case 'check_containers_running':
            return true;
          case 'start_chat':
            return undefined;
          default:
            return undefined;
        }
      };

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Create a fresh injector so setupStreamListener runs again
      await TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [ChatStateService, { provide: TauriService, useValue: failingMock }],
      });
      const freshService = TestBed.inject(ChatStateService);
      await freshService.init();

      expect(errorSpy).toHaveBeenCalledWith('Failed to set up stream listener:', expect.any(Error));

      errorSpy.mockRestore();
    });
  });

  describe('checkContainers', () => {
    it('sets containerStatus to running on success', async () => {
      await service.checkContainers();

      expect(service.containerStatus).toBe('running');
      expect(service.containerError).toBe('');
    });

    it('sets activeProject from list_projects result', async () => {
      await service.checkContainers();

      expect(service.activeProject).toBe('test');
    });

    it('sets activeProject to null when no active project', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects') return { projects: [], active_project: null };
        return undefined;
      };

      await service.checkContainers();

      expect(service.activeProject).toBeNull();
    });

    it('sets error when no active project', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects') return { projects: [], active_project: null };
        return undefined;
      };

      await service.checkContainers();

      expect(service.containerStatus).toBe('error');
      expect(service.containerError).toContain('No active project');
    });

    it('starts containers when not running', async () => {
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        if (cmd === 'list_projects') {
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        }
        if (cmd === 'check_containers_running') return false;
        return undefined;
      };

      await service.checkContainers();

      expect(calls).toContain('start_containers');
      expect(service.containerStatus).toBe('running');
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

    it('auto-retries on "session exited" by restarting chat', async () => {
      let sendAttempt = 0;
      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
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

      expect(calls).toContain('start_chat');
      expect(calls.filter((c) => c === 'send_message')).toHaveLength(2);
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
      let sendAttempt = 0;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'send_message') {
          sendAttempt++;
          if (sendAttempt === 1) throw new Error('no active session');
          return undefined;
        }
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
      expect((errorBlock as { type: 'error'; content: string }).content).toContain(
        'Failed to send message'
      );
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

      // Send four separate fragments that together form valid JSON
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
        // Verify the assembled JSON is actually parseable
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
          cost_usd: 0.01,
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
        cost_usd: 0.01,
        total_cost: 0.05,
        usage: { input_tokens: 100, output_tokens: 50 },
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
        data: { session_id: 'abc', cost_usd: 0.01 },
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
      // Claude Code always copies the full response into `result`.
      // When text was already streamed, result_text is redundant and must be skipped.
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

    it('full streaming sequence produces correct state', () => {
      // Simulate a full turn: text -> thinking -> tool -> tool_result -> text -> result
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
        data: { session_id: 'sid', cost_usd: 0.002, total_cost: 0.01 },
      });

      expect(service.messages).toHaveLength(1);
      const blocks = service.messages[0].blocks;
      expect(blocks).toHaveLength(4); // text, thinking, tool_use, text
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('thinking');
      expect(blocks[2].type).toBe('tool_use');
      expect(blocks[3].type).toBe('text');
      expect(service.isStreaming).toBe(false);
    });
  });

  describe('project switching/settled events via ProjectStateService', () => {
    it('project_switch_started clears state and shows overlay', async () => {
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
      expect(service.containerStatus).toBe('switching');
    });

    it('project_switch_succeeded sets running and syncs activeProject', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();

      // First trigger switching, then succeeded
      mockTauri.dispatchEvent('project_switch_started', { project: 'other-project' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'other-project' });
      await new Promise((r) => setTimeout(r, 10));

      expect(service.containerStatus).toBe('running');
      expect(service.activeProject).toBe('other-project');
    });

    it('project_switch_failed with rollback project sets running with error', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();

      mockTauri.dispatchEvent('project_switch_started', { project: 'fail-project' });
      mockTauri.dispatchEvent('project_switch_failed', {
        project: 'test',
        error: 'chat failed',
      });
      await new Promise((r) => setTimeout(r, 10));

      // Rolled back to 'test' — container is considered running for the old project
      expect(service.containerStatus).toBe('running');
      expect(service.containerError).toContain('chat failed');
      expect(service.activeProject).toBe('test');
    });

    it('project_switch_failed without rollback project sets error', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();

      mockTauri.dispatchEvent('project_switch_started', { project: 'fail-project' });
      mockTauri.dispatchEvent('project_switch_failed', {
        project: null,
        error: 'chat failed',
      });
      await new Promise((r) => setTimeout(r, 10));

      // No rollback project — error state
      expect(service.containerStatus).toBe('error');
      expect(service.containerError).toContain('chat failed');
      expect(service.activeProject).toBeNull();
    });
  });

  describe('resetForNewConversation', () => {
    it('clears messages, blocks, and streaming state', () => {
      service._setState({
        messages: [{ role: 'user', blocks: [{ type: 'text', content: 'old' }], timestamp: 1 }],
        currentBlocks: [{ type: 'text', content: 'partial' }],
        sessionStats: { session_id: 'x', cost_usd: 0, total_cost: 0 },
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

      // isStreaming must be reset so the user is not stuck
      expect(service.isStreaming).toBe(false);

      // The question block should be reverted to unanswered so the user can retry
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
      // No AskUserQuestion block exists for this tool_use_id — simulates a stale session mismatch
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await service.answerQuestion('toolu_nonexistent', ['yes']);

      // The block-marking map finds no match, so currentBlocks stays empty — no crash
      expect(service.currentBlocks).toHaveLength(0);
      // Backend is still called — it decides how to handle the stale ID
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
});
