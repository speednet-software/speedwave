import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TelemetrySectionComponent } from './telemetry-section.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import type { TelemetryConfigResponse } from '../../models/telemetry';

function baseResponse(overrides: Partial<TelemetryConfigResponse> = {}): TelemetryConfigResponse {
  return {
    enabled: true,
    endpoint: 'https://corp:4318',
    protocol: 'grpc',
    export_metrics: true,
    export_logs: false,
    has_headers: false,
    resource_attributes: null,
    include_account_uuid: true,
    log_user_prompts: false,
    log_assistant_responses: false,
    log_tool_details: false,
    log_raw_api_bodies: false,
    metric_export_interval_ms: null,
    logs_export_interval_ms: null,
    locks: {
      enabled: false,
      endpoint: false,
      protocol: false,
      export_metrics: false,
      export_logs: false,
      headers: false,
      resource_attributes: false,
      include_account_uuid: false,
      log_user_prompts: false,
      log_assistant_responses: false,
      log_tool_details: false,
      log_raw_api_bodies: false,
      metric_export_interval_ms: false,
      logs_export_interval_ms: false,
    },
    any_locked: false,
    kill_switch: false,
    ...overrides,
  };
}

describe('TelemetrySectionComponent', () => {
  let component: TelemetrySectionComponent;
  let fixture: ComponentFixture<TelemetrySectionComponent>;
  let mockTauri: MockTauriService;

  function setup(resp: TelemetryConfigResponse): void {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) =>
      cmd === 'get_telemetry_config' ? resp : undefined;
  }

  async function create(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [TelemetrySectionComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();
    fixture = TestBed.createComponent(TelemetrySectionComponent);
    component = fixture.componentInstance;
  }

  beforeEach(() => {
    setup(baseResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create', async () => {
    await create();
    expect(component).toBeTruthy();
  });

  it('reads telemetry config on init and reflects a locked endpoint', async () => {
    setup(
      baseResponse({
        endpoint: 'https://corp:4318',
        locks: { ...baseResponse().locks, endpoint: true },
        any_locked: true,
      })
    );
    await create();
    await component.ngOnInit();
    await fixture.whenStable();
    expect(component.endpoint()).toBe('https://corp:4318');
    expect(component.config()?.locks.endpoint).toBe(true);
  });

  it('greys the whole section when kill_switch is set', async () => {
    setup(baseResponse({ kill_switch: true, enabled: false }));
    await create();
    await component.ngOnInit();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="telemetry-killswitch"]')
    ).not.toBeNull();
  });

  it('renders the enable control as a toggle (like integrations), not a bare checkbox', async () => {
    await create();
    await component.ngOnInit();
    fixture.detectChanges();
    // The switch is the shared app-toggle: a sr-only checkbox inside the toggle wrapper.
    expect(fixture.nativeElement.querySelector('app-toggle')).not.toBeNull();
    const toggle = fixture.nativeElement.querySelector('[data-testid="toggle"]');
    expect(toggle).not.toBeNull();
    const input = fixture.nativeElement.querySelector('[data-testid="telemetry-enabled"]');
    expect(input.classList.contains('peer')).toBe(true);
    expect(input.classList.contains('sr-only')).toBe(true);
  });

  it('save() invokes update_telemetry_config with { update }', async () => {
    await create();
    await component.ngOnInit();
    const spy = vi.spyOn(mockTauri, 'invoke');
    await component.save();
    const call = spy.mock.calls.find((c) => c[0] === 'update_telemetry_config');
    expect(call).toBeDefined();
    expect(call?.[1]).toHaveProperty('update');
  });

  async function savedHeadersUpdate(): Promise<Record<string, unknown>> {
    const spy = vi.spyOn(mockTauri, 'invoke');
    await component.save();
    const call = spy.mock.calls.find((c) => c[0] === 'update_telemetry_config');
    return (call?.[1] as { update: Record<string, unknown> }).update;
  }

  it('save() omits headers when the field was never touched (preserve saved secret)', async () => {
    setup(baseResponse({ has_headers: true }));
    await create();
    await component.ngOnInit();
    expect('headers' in (await savedHeadersUpdate())).toBe(false);
  });

  it('save() sends headers:null when the field was touched and cleared (remove secret)', async () => {
    setup(baseResponse({ has_headers: true }));
    await create();
    await component.ngOnInit();
    component.onHeadersInput('');
    expect((await savedHeadersUpdate())['headers']).toBeNull();
  });

  it('save() sends the new value when the field was touched with text (replace secret)', async () => {
    await create();
    await component.ngOnInit();
    component.onHeadersInput('Authorization=Bearer new');
    expect((await savedHeadersUpdate())['headers']).toBe('Authorization=Bearer new');
  });

  it('editing the endpoint clears a stale probe verdict', async () => {
    await create();
    await component.ngOnInit();
    component.probeResult.set('reachable');
    component.onEndpointInput('https://other:4318');
    expect(component.endpoint()).toBe('https://other:4318');
    expect(component.probeResult()).toBe('');
  });

  async function savedUpdate(): Promise<Record<string, unknown>> {
    const spy = vi.spyOn(mockTauri, 'invoke');
    await component.save();
    const call = spy.mock.calls.find((c) => c[0] === 'update_telemetry_config');
    return (call?.[1] as { update: Record<string, unknown> }).update;
  }

  describe('onPrivacyToggle', () => {
    function checkboxEvent(checked: boolean): Event {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      return { target: input } as unknown as Event;
    }

    it('sets the signal when the user confirms enabling', async () => {
      await create();
      await component.ngOnInit();
      const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const ev = checkboxEvent(true);
      component.onPrivacyToggle('logUserPrompts', ev);
      expect(spy).toHaveBeenCalledOnce();
      expect(component.logUserPrompts()).toBe(true);
      expect((ev.target as HTMLInputElement).checked).toBe(true);
    });

    it('leaves the signal off and unchecks the box when the user cancels', async () => {
      await create();
      await component.ngOnInit();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const ev = checkboxEvent(true);
      component.onPrivacyToggle('logUserPrompts', ev);
      expect(component.logUserPrompts()).toBe(false);
      expect((ev.target as HTMLInputElement).checked).toBe(false);
    });

    it('turning a gate OFF never prompts', async () => {
      await create();
      await component.ngOnInit();
      component.logToolDetails.set(true);
      const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      component.onPrivacyToggle('logToolDetails', checkboxEvent(false));
      expect(spy).not.toHaveBeenCalled();
      expect(component.logToolDetails()).toBe(false);
    });
  });

  describe('parseInterval', () => {
    it.each([
      ['', null],
      ['  ', null],
      ['abc', null],
      ['0', null],
      ['-5', null],
      ['60000', 60000],
      ['1.9', 1],
    ])('parses %o to %o', async (input, expected) => {
      await create();
      // parseInterval is protected; the tri-state input handlers exercise it.
      component.onMetricIntervalInput(input);
      expect(component.metricExportIntervalMs()).toBe(expected);
    });
  });

  describe('testConnection', () => {
    async function probeVerdict(handler: () => Promise<boolean>): Promise<string> {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_telemetry_config') return baseResponse();
        if (cmd === 'probe_otlp_endpoint') return handler();
        return undefined;
      };
      await create();
      await component.ngOnInit();
      await component.testConnection();
      return component.probeResult();
    }

    it('shows reachable when the probe resolves true', async () => {
      expect(await probeVerdict(async () => true)).toBe('reachable');
    });

    it('shows unreachable when the probe resolves false', async () => {
      expect(await probeVerdict(async () => false)).toBe('unreachable from this host');
    });

    it('shows unreachable when the probe rejects', async () => {
      expect(
        await probeVerdict(async () => {
          throw new Error('dial failed');
        })
      ).toBe('unreachable from this host');
    });
  });

  it('refresh() surfaces an error when get_telemetry_config rejects', async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async () => {
      throw new Error('boom');
    };
    await create();
    const emitted: string[] = [];
    component.errorOccurred.subscribe((m) => emitted.push(m));
    await component.ngOnInit();
    expect(component.error()).toBe('boom');
    expect(emitted).toContain('boom');
  });

  it('save() sends the interval as null when it is touched and cleared', async () => {
    setup(baseResponse({ metric_export_interval_ms: 60000 }));
    await create();
    await component.ngOnInit();
    component.onMetricIntervalInput('');
    const update = await savedUpdate();
    expect('metric_export_interval_ms' in update).toBe(true);
    expect(update['metric_export_interval_ms']).toBeNull();
  });

  it('save() omits an untouched interval (leave managed/default unchanged)', async () => {
    setup(baseResponse({ metric_export_interval_ms: 60000 }));
    await create();
    await component.ngOnInit();
    const update = await savedUpdate();
    expect('metric_export_interval_ms' in update).toBe(false);
  });

  it('save() requests a container restart on success (OTEL env is baked at create time)', async () => {
    await create();
    await component.ngOnInit();
    const projectState = TestBed.inject(ProjectStateService);
    const spy = vi.spyOn(projectState, 'requestRestart');
    await component.save();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('save() does NOT request a restart when the write fails', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_telemetry_config') return baseResponse();
      if (cmd === 'update_telemetry_config') throw new Error('save failed');
      return undefined;
    };
    await create();
    await component.ngOnInit();
    const projectState = TestBed.inject(ProjectStateService);
    const spy = vi.spyOn(projectState, 'requestRestart');
    await component.save();
    expect(spy).not.toHaveBeenCalled();
    expect(component.error()).toBe('save failed');
  });

  it('save() shows a transient saved confirmation on success', async () => {
    await create();
    await component.ngOnInit();
    expect(component.saved()).toBe(false);
    await component.save();
    expect(component.saved()).toBe(true);
  });
});
