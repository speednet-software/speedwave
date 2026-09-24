import { TestBed } from '@angular/core/testing';
import { ClaudeControlService } from './claude-control.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { makeMockLogger } from '../testing/mock-logger';
import {
  CLAUDE_SESSION_INFO_EVENT,
  type ClaudeContextUsage,
  type ClaudePlanUsage,
  type ClaudeSessionInfo,
  type ClaudeSessionInfoState,
} from '../models/claude-control';

const INFO: ClaudeSessionInfo = {
  models: [
    {
      value: 'default',
      resolved_model: 'claude-opus-5[1m]',
      display_name: 'Default (recommended)',
      description: 'Opus 5 with 1M context',
      supports_effort: true,
      supported_effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ],
  account: { subscription_type: 'Claude Max', api_provider: 'firstParty' },
};

const USAGE: ClaudePlanUsage = {
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

const CONTEXT: ClaudeContextUsage = {
  model: 'claude-opus-5[1m]',
  total_tokens: 46_567,
  max_tokens: 1_000_000,
  percentage: 5,
  categories: [{ name: 'System prompt', tokens: 3_902, is_deferred: false }],
};

describe('ClaudeControlService', () => {
  let mockTauri: MockTauriService;
  let logger: ReturnType<typeof makeMockLogger>;

  function createService(): ClaudeControlService {
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: logger },
      ],
    });
    return TestBed.inject(ClaudeControlService);
  }

  async function awaitListener(): Promise<void> {
    for (let i = 0; i < 20 && !mockTauri.listenHandlers[CLAUDE_SESSION_INFO_EVENT]; i++) {
      await Promise.resolve();
    }
  }

  function emit(project: string, status: ClaudeSessionInfoState): void {
    mockTauri.dispatchEvent(CLAUDE_SESSION_INFO_EVENT, { project, status });
  }

  beforeEach(() => {
    mockTauri = new MockTauriService();
    logger = makeMockLogger();
  });

  it('reports unavailable for a project it has heard nothing about', async () => {
    const service = createService();
    await awaitListener();

    expect(service.sessionInfoState('acme')).toEqual({ state: 'unavailable' });
    expect(service.sessionInfo('acme')).toBeNull();
  });

  it('stores the ready state pushed by the backend', async () => {
    const service = createService();
    await awaitListener();

    emit('acme', { state: 'ready', info: INFO });

    expect(service.sessionInfoState('acme').state).toBe('ready');
    expect(service.sessionInfo('acme')).toEqual(INFO);
  });

  it('keeps each project on its own state', async () => {
    const service = createService();
    await awaitListener();

    emit('acme', { state: 'ready', info: INFO });
    emit('other', { state: 'pending' });

    expect(service.sessionInfo('acme')).toEqual(INFO);
    expect(service.sessionInfoState('other')).toEqual({ state: 'pending' });
  });

  it('invalidates the ready list while a new session is pending', async () => {
    const service = createService();
    await awaitListener();

    emit('acme', { state: 'ready', info: INFO });
    emit('acme', { state: 'pending' });

    expect(service.sessionInfoState('acme')).toEqual({ state: 'pending' });
    expect(service.sessionInfo('acme')).toBeNull();
  });

  it('drops the ready list when the new session reports unavailable', async () => {
    const service = createService();
    await awaitListener();

    emit('acme', { state: 'ready', info: INFO });
    emit('acme', { state: 'unavailable' });

    expect(service.sessionInfoState('acme')).toEqual({ state: 'unavailable' });
    expect(service.sessionInfo('acme')).toBeNull();
  });

  it('pulls the state for a consumer created after the event', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd !== 'get_chat_session_info') return undefined;
      calls.push(args);
      return { state: 'ready', info: INFO };
    };
    const service = createService();

    await service.refreshSessionInfo('acme');

    expect(calls).toEqual([{ project: 'acme' }]);
    expect(service.sessionInfo('acme')).toEqual(INFO);
  });

  it('leaves the state alone when the pull fails', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('chat session is busy');
    };
    const service = createService();
    await awaitListener();
    emit('acme', { state: 'ready', info: INFO });

    await service.refreshSessionInfo('acme');

    expect(service.sessionInfo('acme')).toEqual(INFO);
    expect(logger.debug).toHaveBeenCalledWith('get_chat_session_info failed: chat session is busy');
  });

  it('returns the plan usage of the project', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd !== 'get_plan_usage') return undefined;
      calls.push(args);
      return USAGE;
    };
    const service = createService();

    expect(await service.planUsage('acme')).toEqual(USAGE);
    expect(calls).toEqual([{ project: 'acme' }]);
  });

  it('degrades plan usage to null on any failure', async () => {
    mockTauri.invokeHandler = async () => {
      throw 'control request timed out';
    };
    const service = createService();

    expect(await service.planUsage('acme')).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith('get_plan_usage failed: control request timed out');
  });

  it('returns the context usage of the project', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd !== 'get_context_usage') return undefined;
      calls.push(args);
      return CONTEXT;
    };
    const service = createService();

    expect(await service.contextUsage('acme')).toEqual(CONTEXT);
    expect(calls).toEqual([{ project: 'acme' }]);
  });

  it('degrades context usage to null on any failure', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('no chat session for this project');
    };
    const service = createService();

    expect(await service.contextUsage('acme')).toBeNull();
  });

  it('stays usable when the event subscription fails', async () => {
    mockTauri.listen = async () => {
      throw new Error('not running inside Tauri');
    };
    mockTauri.invokeHandler = async (cmd) => (cmd === 'get_plan_usage' ? USAGE : undefined);
    const service = createService();
    await Promise.resolve();

    expect(service.sessionInfoState('acme')).toEqual({ state: 'unavailable' });
    expect(await service.planUsage('acme')).toEqual(USAGE);
  });
});
