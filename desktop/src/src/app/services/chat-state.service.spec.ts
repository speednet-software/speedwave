import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChatStateService } from './chat-state.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

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
    service.messages = [];
    service.isStreaming = false;
    service.currentStream = '';
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

  describe('checkContainers', () => {
    it('sets containerStatus to running on success', async () => {
      await service.checkContainers();

      expect(service.containerStatus).toBe('running');
      expect(service.containerError).toBe('');
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
      expect(service.messages[0].content).toBe('Hello');
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
      expect(service.messages[1].content).toContain('Failed to send message');
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
      expect(service.messages[0].content).toBe('Retry me');
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
      expect(service.messages[1].content).toContain('Failed to restart session');
      expect(service.messages[1].content).toContain('backend crashed');
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
      expect(service.messages[1].content).toContain('Failed to send message');
    });
  });

  describe('handleStreamChunk', () => {
    it('accumulates text chunks', () => {
      service.handleStreamChunk({ chunk_type: 'text', content: 'Hello ' });
      service.handleStreamChunk({ chunk_type: 'text', content: 'world!' });

      expect(service.currentStream).toBe('Hello world!');
      expect(service.isStreaming).toBe(true);
    });

    it('saves result as message', () => {
      service.handleStreamChunk({ chunk_type: 'text', content: 'Response' });
      service.handleStreamChunk({ chunk_type: 'result', content: '' });

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].content).toBe('Response');
      expect(service.isStreaming).toBe(false);
      expect(service.currentStream).toBe('');
    });

    it('handles error chunk', () => {
      service.isStreaming = true;
      service.currentStream = 'partial';

      service.handleStreamChunk({ chunk_type: 'error', content: 'bad' });

      expect(service.isStreaming).toBe(false);
      expect(service.currentStream).toBe('');
      expect(service.messages[0].content).toBe('Error: bad');
    });

    it('appends tool_use to stream', () => {
      service.currentStream = 'text';
      service.handleStreamChunk({ chunk_type: 'tool_use', content: 'search' });

      expect(service.currentStream).toBe('text\n\n_Using tool: search_\n\n');
    });
  });

  describe('resetForNewConversation', () => {
    it('clears messages and streaming state', () => {
      service.messages = [{ role: 'user', content: 'old', timestamp: 1 }];
      service.isStreaming = true;
      service.currentStream = 'partial';

      service.resetForNewConversation();

      expect(service.messages).toEqual([]);
      expect(service.isStreaming).toBe(false);
      expect(service.currentStream).toBe('');
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
      service.loadMessages([{ role: 'user', content: 'loaded', timestamp: 1 }]);

      expect(service.messages).toHaveLength(1);
      expect(service.messages[0].content).toBe('loaded');
    });
  });

  describe('onChange', () => {
    it('notifies listeners on stream chunk', () => {
      const cb = vi.fn();
      service.onChange(cb);

      service.handleStreamChunk({ chunk_type: 'text', content: 'hi' });

      expect(cb).toHaveBeenCalled();
    });

    it('returns unsubscribe function', () => {
      const cb = vi.fn();
      const unsub = service.onChange(cb);
      unsub();

      service.handleStreamChunk({ chunk_type: 'text', content: 'hi' });

      expect(cb).not.toHaveBeenCalled();
    });
  });
});
