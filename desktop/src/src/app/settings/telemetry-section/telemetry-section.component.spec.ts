import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TelemetrySectionComponent } from './telemetry-section.component';
import { TauriService } from '../../services/tauri.service';
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
});
