import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SystemHealthComponent } from './system-health.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { HealthReport } from '../models/health';

type Private = Record<string, unknown>;

function makeHealthReport(overrides: Record<string, unknown> = {}): HealthReport {
  return {
    containers: [
      { name: 'speedwave_test_claude', status: 'running', healthy: true },
      { name: 'speedwave_test_mcp_hub', status: 'running', healthy: true },
    ],
    vm: { running: true, vm_type: 'lima' },
    mcp_os: { running: true },
    ide_bridge: { running: true, port: 9100, ws_url: 'ws://localhost:9100', detected_ides: [] },
    overall_healthy: true,
    ...overrides,
  } as HealthReport;
}

describe('SystemHealthComponent', () => {
  let component: SystemHealthComponent;
  let fixture: ComponentFixture<SystemHealthComponent>;
  let mockTauri: MockTauriService;
  let listenCallback: (event: { payload: { kind: string; detail: string } }) => void;
  let reconciledCallback: () => void;
  const mockUnlisten = vi.fn();
  const mockUnlistenReconciled = vi.fn();

  function setupDefaultHandler(): void {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_health':
          return makeHealthReport();
        case 'get_bridge_status':
          return null;
        default:
          return undefined;
      }
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockUnlisten.mockReset();

    mockTauri = new MockTauriService();
    setupDefaultHandler();

    mockUnlistenReconciled.mockReset();

    mockTauri.listen = async (_event: string, handler: unknown) => {
      if (_event === 'ide_bridge_event') {
        listenCallback = handler as (event: { payload: { kind: string; detail: string } }) => void;
        return mockUnlisten;
      }
      if (_event === 'containers_reconciled') {
        reconciledCallback = handler as () => void;
        return mockUnlistenReconciled;
      }
      return vi.fn();
    };

    await TestBed.configureTestingModule({
      imports: [SystemHealthComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(SystemHealthComponent);
    component = fixture.componentInstance;
  });

  describe('initial state', () => {
    it('has correct default values', () => {
      expect(component.report).toBeNull();
      expect(component.loading).toBe(false);
      expect(component.error).toBeNull();
      expect(component.lastUpdated).toBeNull();
      expect(component.project).toBeNull();
      expect(component.selectedContainer).toBeNull();
      expect(component.bridgeStatus).toBeNull();
      expect(component.selectedIde).toBeNull();
      expect(component.lastEvent).toBeNull();
      expect(component.eventFading).toBe(false);
      expect(component.logContent).toBe('');
      expect(component.logLoading).toBe(false);
      expect(component.logError).toBeNull();
      expect(component.showAllLogs).toBe(false);
      expect(component.tailLines).toBe(200);
    });
  });

  describe('polling', () => {
    it('starts a 15s interval that calls refresh via ngOnInit', async () => {
      vi.useFakeTimers();
      const refreshSpy = vi.spyOn(component, 'refresh').mockResolvedValue();

      component.ngOnInit();
      await vi.advanceTimersByTimeAsync(0);

      refreshSpy.mockClear();

      await vi.advanceTimersByTimeAsync(15000);
      expect(refreshSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      const afterFirst = refreshSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15000);
      expect(refreshSpy.mock.calls.length).toBeGreaterThan(afterFirst);

      component.ngOnDestroy();
      vi.useRealTimers();
    });

    it('stops polling after ngOnDestroy', async () => {
      vi.useFakeTimers();
      vi.spyOn(component, 'refresh').mockResolvedValue();

      component.ngOnInit();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15000);

      component.ngOnDestroy();

      expect((component as never as Private)['intervalId']).toBeNull();

      vi.useRealTimers();
    });
  });

  describe('refresh()', () => {
    it('sets loading=true during fetch and loading=false after', async () => {
      const promise = component.refresh();
      expect(component.loading).toBe(true);
      expect(component.error).toBeNull();

      await promise;

      expect(component.loading).toBe(false);
    });

    it('stores health report and sets lastUpdated', async () => {
      const report = makeHealthReport();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_health') return report;
        if (cmd === 'get_bridge_status') return null;
        return undefined;
      };

      await component.refresh();

      expect(component.report).toEqual(report);
      expect(component.lastUpdated).toBeInstanceOf(Date);
    });

    it('sets error and nulls report on failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_health') throw new Error('connection refused');
        if (cmd === 'get_bridge_status') return null;
        return undefined;
      };

      await component.refresh();

      expect(component.error).toContain('Not connected');
      expect(component.error).toContain('connection refused');
      expect(component.report).toBeNull();
      expect(component.loading).toBe(false);
    });

    it('fetches bridge status', async () => {
      const bridge = { port: 9100, upstream_ide: 'Cursor', upstream_port: 3001 };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_health') return makeHealthReport();
        if (cmd === 'get_bridge_status') return bridge;
        return undefined;
      };

      await component.refresh();

      expect(component.bridgeStatus).toEqual(bridge);
    });

    it('passes project input to get_health', async () => {
      component.project = 'my-project';
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.refresh();

      expect(invokeSpy).toHaveBeenCalledWith('get_health', { project: 'my-project' });
    });
  });

  describe('refresh() closes logs for removed container', () => {
    it('calls closeLogs when selectedContainer is no longer in report', async () => {
      component.selectedContainer = 'speedwave_test_removed';
      component.showAllLogs = false;
      component.logContent = 'old logs';

      await component.refresh();

      expect(component.selectedContainer).toBeNull();
      expect(component.logContent).toBe('');
    });

    it('does not close logs when selectedContainer is "all"', async () => {
      component.selectedContainer = 'all';
      component.showAllLogs = true;

      await component.refresh();

      expect(component.selectedContainer).toBe('all');
      expect(component.showAllLogs).toBe(true);
    });

    it('does not close logs when selectedContainer still exists', async () => {
      component.selectedContainer = 'speedwave_test_claude';
      component.showAllLogs = false;

      await component.refresh();

      expect(component.selectedContainer).toBe('speedwave_test_claude');
    });
  });

  describe('refresh() resets selectedIde when bridge has no upstream', () => {
    it('nulls selectedIde when bridgeStatus has no upstream_ide', async () => {
      component.selectedIde = { ide_name: 'VS Code', port: 3000 };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_health') return makeHealthReport();
        if (cmd === 'get_bridge_status')
          return { port: 9100, upstream_ide: null, upstream_port: null };
        return undefined;
      };

      await component.refresh();

      expect(component.selectedIde).toBeNull();
    });

    it('keeps selectedIde when bridgeStatus has upstream_ide', async () => {
      component.selectedIde = { ide_name: 'VS Code', port: 3000 };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_health') return makeHealthReport();
        if (cmd === 'get_bridge_status')
          return { port: 9100, upstream_ide: 'VS Code', upstream_port: 3000 };
        return undefined;
      };

      await component.refresh();

      expect(component.selectedIde).toEqual({ ide_name: 'VS Code', port: 3000 });
    });
  });

  describe('selectContainer()', () => {
    it('sets selectedContainer, showAllLogs=false, and calls fetchLogs', () => {
      mockTauri.invokeHandler = async () => 'container log output';

      component.selectContainer('speedwave_test_claude');

      expect(component.selectedContainer).toBe('speedwave_test_claude');
      expect(component.showAllLogs).toBe(false);
      expect(component.logLoading).toBe(true);
    });
  });

  describe('selectAllLogs()', () => {
    it('sets selectedContainer="all", showAllLogs=true, and calls fetchLogs', () => {
      mockTauri.invokeHandler = async () => 'all logs';

      component.selectAllLogs();

      expect(component.selectedContainer).toBe('all');
      expect(component.showAllLogs).toBe(true);
      expect(component.logLoading).toBe(true);
    });
  });

  describe('closeLogs()', () => {
    it('resets all log state', () => {
      component.selectedContainer = 'speedwave_test_claude';
      component.showAllLogs = true;
      component.logContent = 'some logs';
      component.logError = 'some error';

      component.closeLogs();

      expect(component.selectedContainer).toBeNull();
      expect(component.showAllLogs).toBe(false);
      expect(component.logContent).toBe('');
      expect(component.logError).toBeNull();
    });
  });

  describe('fetchLogs() single container', () => {
    it('invokes get_container_logs for a specific container', async () => {
      component.selectedContainer = 'speedwave_test_claude';
      component.showAllLogs = false;
      component.tailLines = 200;
      mockTauri.invokeHandler = async () => 'log line 1\nlog line 2';

      await component.fetchLogs();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.selectedContainer = 'speedwave_test_claude';
      component.showAllLogs = false;
      component.tailLines = 200;
      mockTauri.invokeHandler = async () => 'log line 1\nlog line 2';

      await component.fetchLogs();

      expect(invokeSpy).toHaveBeenCalledWith('get_container_logs', {
        container: 'speedwave_test_claude',
        tail: 200,
      });
      expect(component.logContent).toBe('log line 1\nlog line 2');
      expect(component.logLoading).toBe(false);
      expect(component.logError).toBeNull();
    });
  });

  describe('fetchLogs() all containers', () => {
    it('invokes get_compose_logs when showAllLogs is true', async () => {
      component.selectedContainer = 'all';
      component.showAllLogs = true;
      component.project = 'my-project';
      component.tailLines = 500;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => 'compose log output';

      await component.fetchLogs();

      expect(invokeSpy).toHaveBeenCalledWith('get_compose_logs', {
        project: 'my-project',
        tail: 500,
      });
      expect(component.logContent).toBe('compose log output');
    });
  });

  describe('fetchLogs() clamps tailLines', () => {
    it('clamps tailLines to minimum 1', async () => {
      component.selectedContainer = 'test';
      component.showAllLogs = false;
      component.tailLines = -50;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => '';

      await component.fetchLogs();

      expect(invokeSpy).toHaveBeenCalledWith('get_container_logs', {
        container: 'test',
        tail: 1,
      });
    });

    it('clamps tailLines to maximum 10000', async () => {
      component.selectedContainer = 'test';
      component.showAllLogs = false;
      component.tailLines = 99999;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => '';

      await component.fetchLogs();

      expect(invokeSpy).toHaveBeenCalledWith('get_container_logs', {
        container: 'test',
        tail: 10000,
      });
    });

    it('defaults to 200 when tailLines is NaN', async () => {
      component.selectedContainer = 'test';
      component.showAllLogs = false;
      component.tailLines = NaN;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => '';

      await component.fetchLogs();

      expect(invokeSpy).toHaveBeenCalledWith('get_container_logs', {
        container: 'test',
        tail: 200,
      });
    });
  });

  describe('fetchLogs() error', () => {
    it('sets logError and clears logContent on failure', async () => {
      component.selectedContainer = 'speedwave_test_claude';
      component.showAllLogs = false;
      mockTauri.invokeHandler = async () => {
        throw new Error('container not found');
      };

      await component.fetchLogs();

      expect(component.logError).toContain('Failed to fetch logs');
      expect(component.logContent).toBe('');
      expect(component.logLoading).toBe(false);
    });
  });

  describe('fetchLogs() does nothing when no selectedContainer', () => {
    it('returns early without invoking', async () => {
      component.selectedContainer = null;
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');

      await component.fetchLogs();

      expect(invokeSpy).not.toHaveBeenCalled();
      expect(component.logLoading).toBe(false);
    });
  });

  describe('ide_bridge_event', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(component, 'refresh').mockResolvedValue();
      component.ngOnInit();
      if ((component as never as Private)['intervalId'] !== null) {
        clearInterval(
          (component as never as Private)['intervalId'] as ReturnType<typeof setInterval>
        );
        (component as never as Private)['intervalId'] = null;
      }
    });

    afterEach(() => {
      component.ngOnDestroy();
      vi.useRealTimers();
    });

    it('sets lastEvent from event payload', () => {
      listenCallback({ payload: { kind: 'openFile', detail: '/tmp/test.ts' } });

      expect(component.lastEvent).toBe('openFile: /tmp/test.ts');
      expect(component.eventFading).toBe(false);
    });

    it('starts fading after 9 seconds', () => {
      listenCallback({ payload: { kind: 'getDiagnostics', detail: 'all' } });
      expect(component.eventFading).toBe(false);

      vi.advanceTimersByTime(9000);

      expect(component.eventFading).toBe(true);
      expect(component.lastEvent).toBe('getDiagnostics: all');
    });

    it('clears lastEvent after 9s + 1s', () => {
      listenCallback({ payload: { kind: 'openFile', detail: 'file.ts' } });

      vi.advanceTimersByTime(9000);
      expect(component.eventFading).toBe(true);

      vi.advanceTimersByTime(1000);
      expect(component.lastEvent).toBeNull();
      expect(component.eventFading).toBe(false);
    });

    it('resets timer on new event before previous clears', () => {
      listenCallback({ payload: { kind: 'first', detail: 'event1' } });

      vi.advanceTimersByTime(5000);
      expect(component.lastEvent).toBe('first: event1');
      expect(component.eventFading).toBe(false);

      listenCallback({ payload: { kind: 'second', detail: 'event2' } });
      expect(component.lastEvent).toBe('second: event2');
      expect(component.eventFading).toBe(false);

      vi.advanceTimersByTime(9000);
      expect(component.eventFading).toBe(true);
      expect(component.lastEvent).toBe('second: event2');

      vi.advanceTimersByTime(1000);
      expect(component.lastEvent).toBeNull();
    });
  });

  describe('ngOnDestroy()', () => {
    it('handles destroy when no interval or listener exists', () => {
      expect(() => component.ngOnDestroy()).not.toThrow();
    });

    it('clears interval on destroy', () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      (component as never as Private)['intervalId'] = setInterval(() => {}, 15000);

      component.ngOnDestroy();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect((component as never as Private)['intervalId']).toBeNull();
    });

    it('clears event timer on destroy', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      (component as never as Private)['eventTimerId'] = setTimeout(() => {}, 9000);

      component.ngOnDestroy();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect((component as never as Private)['eventTimerId']).toBeNull();
    });

    it('calls unlisten on destroy', async () => {
      vi.spyOn(component, 'refresh').mockResolvedValue();
      component.ngOnInit();
      await new Promise((r) => queueMicrotask(r));
      await new Promise((r) => queueMicrotask(r));

      component.ngOnDestroy();

      expect(mockUnlisten).toHaveBeenCalled();
      expect((component as never as Private)['unlistenEvent']).toBeNull();
    });

    it('calls unlistenReconciled on destroy', async () => {
      vi.spyOn(component, 'refresh').mockResolvedValue();
      component.ngOnInit();
      await new Promise((r) => queueMicrotask(r));
      await new Promise((r) => queueMicrotask(r));

      component.ngOnDestroy();

      expect(mockUnlistenReconciled).toHaveBeenCalled();
      expect((component as never as Private)['unlistenReconciled']).toBeNull();
    });
  });

  describe('containers_reconciled event', () => {
    it('triggers refresh when containers_reconciled event fires', async () => {
      const refreshSpy = vi.spyOn(component, 'refresh').mockResolvedValue();
      component.ngOnInit();
      await new Promise((r) => queueMicrotask(r));
      await new Promise((r) => queueMicrotask(r));

      refreshSpy.mockClear();
      reconciledCallback();

      expect(refreshSpy).toHaveBeenCalledOnce();
    });

    it('does not call refresh after ngOnDestroy', async () => {
      const refreshSpy = vi.spyOn(component, 'refresh').mockResolvedValue();
      component.ngOnInit();
      await new Promise((r) => queueMicrotask(r));
      await new Promise((r) => queueMicrotask(r));

      component.ngOnDestroy();
      refreshSpy.mockClear();

      expect(mockUnlistenReconciled).toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it('handles listen rejection gracefully', async () => {
      mockTauri.listen = async (_event: string, handler: unknown) => {
        if (_event === 'ide_bridge_event') {
          listenCallback = handler as (event: {
            payload: { kind: string; detail: string };
          }) => void;
          return mockUnlisten;
        }
        if (_event === 'containers_reconciled') {
          throw new Error('listen failed');
        }
        return vi.fn();
      };

      expect(() => component.ngOnInit()).not.toThrow();
      await new Promise((r) => queueMicrotask(r));
      await new Promise((r) => queueMicrotask(r));

      expect((component as never as Private)['unlistenReconciled']).toBeNull();
      expect(() => component.ngOnDestroy()).not.toThrow();
    });

    it('handles refresh() error inside reconciled handler', async () => {
      const refreshSpy = vi
        .spyOn(component, 'refresh')
        .mockRejectedValueOnce(new Error('refresh failed'));
      component.ngOnInit();
      await new Promise((r) => queueMicrotask(r));
      await new Promise((r) => queueMicrotask(r));

      refreshSpy.mockClear();
      refreshSpy.mockRejectedValueOnce(new Error('refresh failed'));

      expect(() => reconciledCallback()).not.toThrow();
    });
  });
});
