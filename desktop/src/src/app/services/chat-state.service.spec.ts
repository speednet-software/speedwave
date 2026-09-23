import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChatStateService, MAX_CHAT_TABS, NEW_CONVERSATION_BUSY } from './chat-state.service';
import { ProjectStateService } from './project-state.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { PlanUsageService } from './plan-usage.service';
import { MockTauriService, MOCK_BUNDLE_RECONCILE_DONE } from '../testing/mock-tauri.service';
import { createDeferred, type Deferred } from '../testing/deferred';
import { makeMockLogger } from '../testing/mock-logger';
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

  describe('startNewConversation — listener wiring', () => {
    it('attaches the stream listener before the session starts', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'start_chat') return undefined;
        if (cmd === 'list_projects')
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        if (cmd === 'get_bundle_reconcile_state') return MOCK_BUNDLE_RECONCILE_DONE;
        if (cmd === 'check_containers_running') return true;
        return undefined;
      };
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

  describe('tab id addressing (SPEED-388)', () => {
    it('passes its tab id to start_chat', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      const spy = vi.spyOn(mockTauri, 'invoke');

      await service.init();
      await new Promise((r) => setTimeout(r, 0));

      expect(spy).toHaveBeenCalledWith('start_chat', { project: 'test', tabId: service.tabId });
    });

    it('drops chat_stream chunks addressed to another tab', async () => {
      await service.init();
      service.isStreaming = true;

      mockTauri.dispatchEvent('chat_stream', {
        tab_id: 'not-mine',
        chunk_type: 'Text',
        data: { content: 'x' },
      });

      expect(service.currentBlocks).toEqual([]);
      expect(service.messagesFromState()).toEqual([]);
    });

    it('routes chunks addressed to its own tab', async () => {
      await service.init();

      mockTauri.dispatchEvent('chat_stream', {
        tab_id: service.tabId,
        chunk_type: 'SystemInit',
        data: { model: 'm', session_id: 'sid' },
      });

      expect(service.sessionStats?.session_id).toBe('sid');
    });

    it('starts a fresh session after a project switch reaches ready', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      const spy = vi.spyOn(mockTauri, 'invoke');

      mockTauri.dispatchEvent('project_switch_started', { project: 'test' });
      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'test' });

      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledWith(
          'start_chat',
          expect.objectContaining({ tabId: service.tabId })
        );
      });
    });

    it('does not start a second session on a bare container-restart ready with no prior switching', async () => {
      const projectState = TestBed.inject(ProjectStateService);
      await projectState.init();
      await service.init();
      await new Promise((r) => setTimeout(r, 0));
      const spy = vi.spyOn(mockTauri, 'invoke');

      await projectState.restartContainers();

      expect(projectState.status()).toBe('ready');
      expect(spy.mock.calls.filter(([cmd]) => cmd === 'start_chat')).toHaveLength(0);
    });
  });

  describe('tab registry (SPEED-388 phase 2)', () => {
    describe('demux', () => {
      it('routes a chat_stream chunk to the store matching its tab_id and drops unknown tabs', async () => {
        await service.init();
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        const store1 = service.tabs().get(tab1)!;
        const store2 = service.tabs().get(tab2)!;
        store1.isStreaming = true;
        store2.isStreaming = true;

        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab1,
          chunk_type: 'Text',
          data: { content: 'to tab1' },
        });
        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab2,
          chunk_type: 'Text',
          data: { content: 'to tab2' },
        });
        mockTauri.dispatchEvent('chat_stream', {
          tab_id: 'unknown-tab',
          chunk_type: 'Text',
          data: { content: 'nowhere' },
        });

        expect(store1.currentBlocks).toEqual([{ type: 'text', content: 'to tab1' }]);
        expect(store2.currentBlocks).toEqual([{ type: 'text', content: 'to tab2' }]);
      });

      it('streams two tabs concurrently with no cross-talk', async () => {
        await service.init();
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        const store1 = service.tabs().get(tab1)!;
        const store2 = service.tabs().get(tab2)!;
        store1.isStreaming = true;
        store2.isStreaming = true;

        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab1,
          chunk_type: 'Text',
          data: { content: 'a1' },
        });
        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab2,
          chunk_type: 'Text',
          data: { content: 'b1' },
        });
        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab1,
          chunk_type: 'Text',
          data: { content: 'a2' },
        });
        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab2,
          chunk_type: 'Text',
          data: { content: 'b2' },
        });

        expect(store1.currentBlocks).toEqual([{ type: 'text', content: 'a1a2' }]);
        expect(store2.currentBlocks).toEqual([{ type: 'text', content: 'b1b2' }]);
      });

      it('a background (non-active) tab keeps streaming while it is not the active tab', async () => {
        await service.init();
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        service.activateTab(tab1);
        const store2 = service.tabs().get(tab2)!;
        store2.isStreaming = true;

        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab2,
          chunk_type: 'Text',
          data: { content: 'still going' },
        });

        expect(service.activeTabId()).toBe(tab1);
        expect(store2.currentBlocks).toEqual([{ type: 'text', content: 'still going' }]);
      });

      it('drops a content chunk for a tab that is not itself streaming, even bypass types still apply', async () => {
        await service.init();
        const tab1 = service.activeTabId();
        const store1 = service.tabs().get(tab1)!;
        store1.isStreaming = false;

        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab1,
          chunk_type: 'Text',
          data: { content: 'dropped' },
        });
        mockTauri.dispatchEvent('chat_stream', {
          tab_id: tab1,
          chunk_type: 'SystemInit',
          data: { model: 'm', session_id: 'sid-bypass' },
        });

        expect(store1.currentBlocks).toEqual([]);
        expect(store1.sessionStats?.session_id).toBe('sid-bypass');
      });
    });

    describe('openTab', () => {
      it('creates additional tabs up to MAX_CHAT_TABS and throws beyond the cap', async () => {
        expect(service.tabs().size).toBe(1);
        expect(service.canOpenTab()).toBe(true);

        await service.openTab();
        expect(service.tabs().size).toBe(2);
        await service.openTab();
        expect(service.tabs().size).toBe(MAX_CHAT_TABS);
        expect(service.canOpenTab()).toBe(false);

        await expect(service.openTab()).rejects.toThrow();
        expect(service.tabs().size).toBe(MAX_CHAT_TABS);
      });

      it('activates the newly created tab', async () => {
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();

        expect(tab2).not.toBe(tab1);
        expect(service.activeTabId()).toBe(tab2);
      });
    });

    describe('closeTab', () => {
      it('interrupts a streaming tab, invokes close_chat_tab, disposes it, and activates a neighbor', async () => {
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        service.activateTab(tab1);
        const store1 = service.tabs().get(tab1)!;
        store1.isStreaming = true;
        store1.setResumeDecider(() => Promise.resolve('resume'));

        await service.closeTab(tab1);

        expect(invokeSpy).toHaveBeenCalledWith('stop_chat', { tabId: tab1 });
        expect(invokeSpy).toHaveBeenCalledWith('close_chat_tab', { tabId: tab1 });
        expect(service.tabs().has(tab1)).toBe(false);
        expect(service.activeTabId()).toBe(tab2);
        expect((store1 as unknown as { _resumeDecider: unknown })._resumeDecider).toBeNull();
      });

      it('closing a background (non-active) tab leaves the active tab unchanged', async () => {
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        service.activateTab(tab1);

        await service.closeTab(tab2);

        expect(service.activeTabId()).toBe(tab1);
        expect(service.tabs().has(tab2)).toBe(false);
        expect(service.tabs().size).toBe(1);
      });

      it('closing the last remaining tab replaces it with a fresh store instead of leaving zero tabs', async () => {
        const tab1 = service.activeTabId();

        await service.closeTab(tab1);

        expect(service.tabs().size).toBe(1);
        expect(service.tabs().has(tab1)).toBe(false);
        expect(service.activeTabId()).not.toBe(tab1);
      });

      it('is a no-op for an unknown tab id', async () => {
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');
        const tab1 = service.activeTabId();

        await service.closeTab('does-not-exist');

        expect(service.tabs().size).toBe(1);
        expect(service.activeTabId()).toBe(tab1);
        expect(invokeSpy).not.toHaveBeenCalledWith('close_chat_tab', expect.anything());
      });
    });

    describe('activateTab', () => {
      it('switches the active tab', async () => {
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        service.activateTab(tab1);

        service.activateTab(tab2);

        expect(service.activeTabId()).toBe(tab2);
      });

      it('is a no-op for an unknown tab id', () => {
        const tab1 = service.activeTabId();

        service.activateTab('does-not-exist');

        expect(service.activeTabId()).toBe(tab1);
      });

      it('re-points facade computed signals to the newly active store', async () => {
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        const store2 = service.tabs().get(tab2)!;
        store2.handleStreamChunk({ chunk_type: 'Text', data: { content: 'hello from tab2' } });
        store2.handleStreamChunk({
          chunk_type: 'Result',
          data: { session_id: 'tab2-sess', total_cost: 0 },
        });
        service.activateTab(tab1);

        expect(service.hasConversation()).toBe(false);

        service.activateTab(tab2);

        expect(service.hasConversation()).toBe(true);
        expect(service.messagesFromState()[0]?.blocks[0]).toEqual({
          type: 'text',
          content: 'hello from tab2',
        });
      });
    });

    describe('openConversation (resume rule)', () => {
      it('branch 1: activates the tab that already owns the session instead of resuming again', async () => {
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        const store2 = service.tabs().get(tab2)!;
        store2.seedSessionId('owned-session');
        service.activateTab(tab1);
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.openConversation('owned-session');

        expect(service.activeTabId()).toBe(tab2);
        expect(invokeSpy).not.toHaveBeenCalledWith(
          'resume_conversation',
          expect.objectContaining({ sessionId: 'owned-session' })
        );
      });

      it('branch 1: also matches a tab that only optimistically claims the session', async () => {
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        const store2 = service.tabs().get(tab2)!;
        (store2 as unknown as { _optimisticSessionId: string | null })._optimisticSessionId =
          'optimistic-session';
        service.activateTab(tab1);

        await service.openConversation('optimistic-session');

        expect(service.activeTabId()).toBe(tab2);
      });

      it('single-tab gate: a busy sole tab resumes in place instead of spawning an invisible second tab', async () => {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        const tab1 = service.activeTabId();
        const active = service.tabs().get(tab1)!;
        active.isStreaming = true;
        mockTauri.invokeHandler = async (cmd: string) => {
          if (cmd === 'get_conversation') return { session_id: 'single-busy', messages: [] };
          return undefined;
        };
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.openConversation('single-busy');

        expect(service.tabs().size).toBe(1);
        expect(service.activeTabId()).toBe(tab1);
        expect(invokeSpy).toHaveBeenCalledWith(
          'resume_conversation',
          expect.objectContaining({ sessionId: 'single-busy', tabId: tab1 })
        );
      });

      it('branch 2: with 2+ tabs an idle+clean active tab resumes in place', async () => {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        const tab2 = await service.openTab();
        expect(service.tabs().size).toBe(2);
        mockTauri.invokeHandler = async (cmd: string) => {
          if (cmd === 'get_conversation') return { session_id: 'resume-me', messages: [] };
          return undefined;
        };
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.openConversation('resume-me');

        expect(service.activeTabId()).toBe(tab2);
        expect(service.tabs().size).toBe(2);
        expect(invokeSpy).toHaveBeenCalledWith(
          'resume_conversation',
          expect.objectContaining({ sessionId: 'resume-me', tabId: tab2 })
        );
      });

      it('branch 3: with 2+ tabs a busy active tab under the cap opens a new resuming tab', async () => {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        const tab2 = await service.openTab();
        expect(service.tabs().size).toBe(2);
        const active = service.tabs().get(tab2)!;
        active.isStreaming = true;
        mockTauri.invokeHandler = async (cmd: string) => {
          if (cmd === 'get_conversation') return { session_id: 'resume-new-tab', messages: [] };
          return undefined;
        };
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.openConversation('resume-new-tab');

        expect(service.tabs().size).toBe(3);
        const newTabId = service.activeTabId();
        expect(newTabId).not.toBe(tab2);
        expect(invokeSpy).toHaveBeenCalledWith(
          'resume_conversation',
          expect.objectContaining({ sessionId: 'resume-new-tab', tabId: newTabId })
        );
      });

      it('branch 4: resumes into the active tab once at the cap, even while busy', async () => {
        TestBed.inject(ProjectStateService).activeProject.set('test');
        const tab1 = service.activeTabId();
        const active = service.tabs().get(tab1)!;
        active.isStreaming = true;
        await service.openTab();
        await service.openTab();
        service.activateTab(tab1);
        expect(service.tabs().size).toBe(MAX_CHAT_TABS);
        expect(service.canOpenTab()).toBe(false);

        mockTauri.invokeHandler = async (cmd: string) => {
          if (cmd === 'get_conversation') return { session_id: 'cap-resume', messages: [] };
          return undefined;
        };
        const invokeSpy = vi.spyOn(mockTauri, 'invoke');

        await service.openConversation('cap-resume');

        expect(service.tabs().size).toBe(MAX_CHAT_TABS);
        expect(service.activeTabId()).toBe(tab1);
        expect(invokeSpy).toHaveBeenCalledWith(
          'resume_conversation',
          expect.objectContaining({ sessionId: 'cap-resume', tabId: tab1 })
        );
      });

      it('resumeConversation is an alias for openConversation', async () => {
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        const store2 = service.tabs().get(tab2)!;
        store2.seedSessionId('via-alias');
        service.activateTab(tab1);

        await service.resumeConversation('via-alias');

        expect(service.activeTabId()).toBe(tab2);
      });
    });

    describe('project switch disposes every tab', () => {
      it('leaves exactly one fresh tab and clears every prior store', async () => {
        const projectState = TestBed.inject(ProjectStateService);
        await projectState.init();
        await service.init();
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        const store1 = service.tabs().get(tab1)!;
        const store2 = service.tabs().get(tab2)!;
        store1.setResumeDecider(() => Promise.resolve('resume'));
        store2.setResumeDecider(() => Promise.resolve('resume'));

        mockTauri.dispatchEvent('project_switch_started', { project: 'other-project' });
        await new Promise((r) => setTimeout(r, 10));

        expect(service.tabs().size).toBe(1);
        expect(service.tabs().has(tab1)).toBe(false);
        expect(service.tabs().has(tab2)).toBe(false);
        expect((store1 as unknown as { _resumeDecider: unknown })._resumeDecider).toBeNull();
        expect((store2 as unknown as { _resumeDecider: unknown })._resumeDecider).toBeNull();
      });
    });

    describe('restart-complete flags background tabs', () => {
      type RestartInternal = {
        notifyRestartBegin(): Promise<void>;
      };

      async function fireRestart(projectState: ProjectStateService): Promise<void> {
        await (projectState as unknown as RestartInternal).notifyRestartBegin();
        projectState.notifyRestartComplete();
        await new Promise((r) => setTimeout(r, 0));
      }

      it('flags a background tab with a session as sessionEnded and resumes only the active tab', async () => {
        const projectState = TestBed.inject(ProjectStateService);
        await projectState.init();
        projectState.activeProject.set('test');
        await service.init();
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        service.activateTab(tab1);
        const store2 = service.tabs().get(tab2)!;
        store2.seedSessionId('bg-session');

        await fireRestart(projectState);

        expect(store2.sessionEnded()).toBe(true);
        expect(service.tabs().get(tab1)!.sessionEnded()).toBe(false);
      });

      it('does not flag a fresh never-used background tab', async () => {
        const projectState = TestBed.inject(ProjectStateService);
        await projectState.init();
        projectState.activeProject.set('test');
        await service.init();
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        service.activateTab(tab1);
        const store2 = service.tabs().get(tab2)!;
        expect(store2.lastKnownSessionId).toBeNull();
        expect(store2.optimisticSessionId).toBeNull();

        await fireRestart(projectState);

        expect(store2.sessionEnded()).toBe(false);
      });

      it('clears the stream state of a flagged streaming background tab', async () => {
        const projectState = TestBed.inject(ProjectStateService);
        await projectState.init();
        projectState.activeProject.set('test');
        await service.init();
        const tab1 = service.activeTabId();
        const tab2 = await service.openTab();
        service.activateTab(tab1);
        const store2 = service.tabs().get(tab2)!;
        store2.seedSessionId('bg-streaming');
        store2.handleStreamChunk({ chunk_type: 'Text', data: { content: 'partial' } });
        expect(store2.isStreaming).toBe(true);

        await fireRestart(projectState);

        expect(store2.sessionEnded()).toBe(true);
        expect(store2.isStreaming).toBe(false);
        expect(store2.currentBlocks).toEqual([]);
        expect(store2.messages.at(-1)?.blocks).toEqual([{ type: 'text', content: 'partial' }]);
      });
    });
  });

  describe('pendingModelOverride — project switch clears queued pick', () => {
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

  describe('stopConversation', () => {
    it('stopConversation finalizes text blocks and resets isStreaming', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      service.isStreaming = true;
      service._setState({ currentBlocks: [{ type: 'text', content: 'partial' }] });
      await service.stopConversation();
      expect(invokeSpy).toHaveBeenCalledWith('stop_chat', { tabId: service.tabId });
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
        tab_id: service.tabId,
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
        tab_id: service.tabId,
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
        tab_id: service.tabId,
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
        tab_id: service.tabId,
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
        tab_id: service.tabId,
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
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'RateLimit',
        tab_id: service.tabId,
        data: signal,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(TestBed.inject(PlanUsageService).lastSignal('test')).toEqual(signal);
    });

    it('SystemInit chunk dispatched between turns updates the model', async () => {
      mockTauri.isRunningInTauri = () => true;
      await service.init();
      expect(service.isStreaming).toBe(false);
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'SystemInit',
        tab_id: service.tabId,
        data: { model: 'claude-opus-4-7' },
      });
      service.isStreaming = true;
      mockTauri.dispatchEvent('chat_stream', {
        chunk_type: 'Result',
        tab_id: service.tabId,
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
        tab_id: service.tabId,
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
        tab_id: service.tabId,
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
            provider: kind.startsWith('anthropic') ? 'anthropic' : 'openrouter',
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
      (service.activeStore() as unknown as TokensInternal)._lastContextTokens = 25229;
      (service.activeStore() as unknown as TokensInternal)._persistedContextTokens = 8192;
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
      (service.activeStore() as unknown as TokensInternal)._lastContextTokens = 25229;
      (service.activeStore() as unknown as TokensInternal)._persistedContextTokens = 8192;
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
      (service.activeStore() as unknown as TokensInternal)._lastContextTokens = 25229;
      (service.activeStore() as unknown as TokensInternal)._persistedContextTokens = 8192;
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
      (service.activeStore() as unknown as TokensInternal)._lastContextTokens = 25229;
      (service.activeStore() as unknown as TokensInternal)._persistedContextTokens = 8192;
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
      (service.activeStore() as unknown as TokensInternal)._lastContextTokens = 25229;
      (service.activeStore() as unknown as TokensInternal)._persistedContextTokens = 8192;
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
      (service.activeStore() as unknown as TokensInternal)._lastContextTokens = 25229;
      (service.activeStore() as unknown as TokensInternal)._persistedContextTokens = 200_000;
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
      (service.activeStore() as unknown as TokensInternal)._lastContextTokens = 25229;
      (service.activeStore() as unknown as TokensInternal)._persistedContextTokens = 200_000;
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
      (service.activeStore() as unknown as TokensInternal)._lastContextTokens = 25229;
      (service.activeStore() as unknown as TokensInternal)._persistedContextTokens = 8192;
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
