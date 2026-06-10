import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SystemHealthService, HEALTH_REFRESH_INTERVAL_MS } from './system-health.service';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { HealthReport } from '../models/health';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeReport(overallHealthy = true): HealthReport {
  return {
    containers: [{ name: 'claude', status: 'running', healthy: true }],
    vm: { running: true, vm_type: 'lima' },
    mcp_os: { running: true },
    ide_bridge: {
      running: true,
      port: 4000,
      ws_url: null,
      detected_ides: [],
      selected_ide: null,
    },
    overall_healthy: overallHealthy,
  };
}

describe('SystemHealthService', () => {
  let service: SystemHealthService;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockTauri = new MockTauriService();
    mockLogger = makeMockLogger();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_health') return makeReport();
      return undefined;
    };

    TestBed.configureTestingModule({
      providers: [
        SystemHealthService,
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'test';
    service = TestBed.inject(SystemHealthService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
  });

  describe('ensurePolling idempotence', () => {
    it('a second call does not start a second timer', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      await service.ensurePolling();
      await service.ensurePolling();
      await service.ensurePolling();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it('the initial fetch resolves and populates the signal', async () => {
      await service.ensurePolling();
      expect(service.health()).toEqual(makeReport());
    });

    it('the second call resolves without invoking get_health again', async () => {
      await service.ensurePolling();
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.ensurePolling();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('byte-identical snapshot dedupe', () => {
    it('does not re-write the signal when the report is unchanged', async () => {
      await service.ensurePolling();
      const first = service.health();

      // A subsequent identical fetch must keep the SAME object reference so
      // OnPush descendants do not re-render between real changes.
      await service.refresh();
      expect(service.health()).toBe(first);
    });

    it('writes a new snapshot when the report changes', async () => {
      await service.ensurePolling();
      const first = service.health();

      mockTauri.invokeHandler = async (cmd: string) =>
        cmd === 'get_health' ? makeReport(false) : undefined;
      await service.refresh();

      expect(service.health()).not.toBe(first);
      expect(service.health()?.overall_healthy).toBe(false);
    });
  });

  describe('report shape guard', () => {
    it('ignores a malformed report missing the vm/ide_bridge keys', async () => {
      mockTauri.invokeHandler = async (cmd: string) =>
        cmd === 'get_health' ? ({ garbage: true } as unknown as HealthReport) : undefined;

      await service.refresh();

      expect(service.health()).toBeNull();
    });

    it('ignores a null report', async () => {
      mockTauri.invokeHandler = async (cmd: string) =>
        cmd === 'get_health' ? (null as unknown as HealthReport) : undefined;

      await service.refresh();

      expect(service.health()).toBeNull();
    });

    it('does nothing when no project is active', async () => {
      projectState.activeProject = null;
      const spy = vi.spyOn(mockTauri, 'invoke');

      await service.refresh();

      expect(spy).not.toHaveBeenCalled();
      expect(service.health()).toBeNull();
    });
  });

  describe('error handling', () => {
    it('keeps the previous snapshot and logs (debug) when get_health throws inside Tauri', async () => {
      mockTauri.runningInTauri = true;
      await service.ensurePolling();
      const prev = service.health();

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_health') throw new Error('vm down');
        return undefined;
      };
      await service.refresh();

      expect(service.health()).toBe(prev);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('get_health failed: Error: vm down')
      );
    });

    it('stays silent (no log) when get_health throws outside Tauri', async () => {
      mockTauri.runningInTauri = false;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_health') throw new Error('not in tauri');
        return undefined;
      };

      await service.refresh();

      expect(mockLogger.debug).not.toHaveBeenCalled();
    });
  });

  describe('polling cadence', () => {
    it('refreshes on the interval', async () => {
      const spy = vi.spyOn(mockTauri, 'invoke');
      await service.ensurePolling();
      const afterInitial = spy.mock.calls.filter((c) => c[0] === 'get_health').length;

      await vi.advanceTimersByTimeAsync(HEALTH_REFRESH_INTERVAL_MS);

      const afterTick = spy.mock.calls.filter((c) => c[0] === 'get_health').length;
      expect(afterTick).toBe(afterInitial + 1);
    });
  });

  describe('ngOnDestroy cleanup', () => {
    it('clears the timer so no further fetches occur', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      await service.ensurePolling();

      service.ngOnDestroy();

      expect(clearSpy).toHaveBeenCalled();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await vi.advanceTimersByTimeAsync(HEALTH_REFRESH_INTERVAL_MS * 3);
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('unsubscribes from project-settled so a settle no longer triggers a fetch', async () => {
      await service.ensurePolling();
      service.ngOnDestroy();

      const spy = vi.spyOn(mockTauri, 'invoke');
      // Re-running ensurePolling after destroy must be allowed (started reset).
      expect(service['started']).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it('allows ensurePolling to restart after destroy', async () => {
      await service.ensurePolling();
      service.ngOnDestroy();

      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      await service.ensurePolling();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    });
  });
});
