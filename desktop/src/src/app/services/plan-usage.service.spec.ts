import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { PlanUsageService } from './plan-usage.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { makeMockLogger } from '../testing/mock-logger';
import type { ClaudePlanUsage } from '../models/claude-control';
import type { RateLimitInfo } from '../models/chat';

const NOW = Date.parse('2026-09-18T10:00:00Z');

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

const WARNING: RateLimitInfo = {
  status: 'allowed_warning',
  rate_limit_type: 'five_hour',
  utilization_percent: 60,
  resets_at: 1738425600,
  overage_status: null,
  is_using_overage: false,
};

describe('PlanUsageService', () => {
  let mockTauri: MockTauriService;
  let service: PlanUsageService;
  let usageCalls: number;
  let usageResult: () => Promise<ClaudePlanUsage>;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    usageCalls = 0;
    usageResult = async () => USAGE;
    mockTauri.invokeHandler = async (cmd) => {
      if (cmd !== 'get_plan_usage') return undefined;
      usageCalls += 1;
      return usageResult();
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: makeMockLogger() },
      ],
    });
    service = TestBed.inject(PlanUsageService);
  });

  it('has no limits before the first read, and none without a project', () => {
    expect(service.limits('acme', NOW)).toBeNull();
    expect(service.limits(null, NOW)).toBeNull();
    expect(service.lastSignal(null)).toBeNull();
  });

  it('holds the 5-hour and weekly utilization Claude Code reports', async () => {
    await service.refresh('acme');

    const windows = service.limits('acme', NOW)?.windows ?? [];
    expect(windows.map((w) => [w.key, w.utilization])).toEqual([
      ['five_hour', 15],
      ['seven_day', 70],
    ]);
  });

  it('keeps each project on its own sign-in', async () => {
    await service.refresh('acme');

    expect(service.limits('other', NOW)).toBeNull();
  });

  it('stops reporting a window once its reset time passes, without another read', async () => {
    await service.refresh('acme');

    const later = Date.parse('2026-09-18T13:00:00Z');

    expect(service.limits('acme', later)?.windows.map((w) => w.key)).toEqual(['seven_day']);
    expect(usageCalls).toBe(1);
  });

  it('clears the limits when a later read fails', async () => {
    await service.refresh('acme');
    usageResult = async () => {
      throw new Error("control request 'get_usage' got no response within 10000 ms");
    };

    await service.refresh('acme');

    expect(service.limits('acme', NOW)).toBeNull();
  });

  it('is absent for an API-key session', async () => {
    usageResult = async () => ({
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    });

    await service.refresh('acme');

    expect(service.limits('acme', NOW)).toBeNull();
  });

  it('shares one request between concurrent reads', async () => {
    await Promise.all([service.refresh('acme'), service.refresh('acme')]);

    expect(usageCalls).toBe(1);

    await service.refresh('acme');
    expect(usageCalls).toBe(2);
  });

  it('stores a rate limit warning as the status signal and re-reads the limits', async () => {
    service.recordSignal('acme', WARNING);
    await service.refresh('acme');

    expect(service.lastSignal('acme')).toEqual(WARNING);
    expect(usageCalls).toBe(1);
    expect(service.limits('acme', NOW)?.windows[0].utilization).toBe(15);
  });

  it('keeps the status and reset time of an event without a utilization', () => {
    const allowed: RateLimitInfo = { ...WARNING, status: 'allowed', utilization_percent: null };

    service.recordSignal('acme', allowed);

    expect(service.lastSignal('acme')).toEqual(allowed);
  });

  it('forgets a project on logout or provider switch', async () => {
    await service.refresh('acme');
    service.recordSignal('acme', WARNING);

    service.drop('acme');

    expect(service.limits('acme', NOW)).toBeNull();
    expect(service.lastSignal('acme')).toBeNull();
  });

  it('survives a drop of a project it never heard of', () => {
    service.drop('nobody');

    expect(service.limits('nobody', NOW)).toBeNull();
  });
});
