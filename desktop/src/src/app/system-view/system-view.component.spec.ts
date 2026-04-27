import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SystemViewComponent, SYSTEM_REFRESH_INTERVAL_MS } from './system-view.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { HealthReport } from '../models/health';

const MOCK_HEALTHY_REPORT: HealthReport = {
  containers: [
    { name: 'speedwave_test_claude', status: 'running', healthy: true },
    { name: 'speedwave_test_mcp-hub', status: 'running', healthy: true },
    { name: 'speedwave_test_redmine', status: 'starting', healthy: false },
  ],
  vm: { running: true, vm_type: 'lima' },
  mcp_os: { running: true },
  ide_bridge: {
    running: true,
    port: 4001,
    ws_url: 'ws://127.0.0.1:4001',
    detected_ides: [],
  },
  overall_healthy: false,
};

const MOCK_EMPTY_REPORT: HealthReport = {
  containers: [],
  vm: { running: false, vm_type: 'lima' },
  mcp_os: { running: false },
  ide_bridge: { running: false, port: null, ws_url: null, detected_ides: [] },
  overall_healthy: false,
};

describe('SystemViewComponent', () => {
  let component: SystemViewComponent;
  let fixture: ComponentFixture<SystemViewComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_health') return MOCK_HEALTHY_REPORT;
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [SystemViewComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'test';

    fixture = TestBed.createComponent(SystemViewComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // -- Happy path: renders a row per container --

  it('renders a row for every container in the health report', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="system-row"]');
    expect(rows).toHaveLength(3);
  });

  it('renders the container name, state, and healthy flag in each row', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const names = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="system-name"]')
    ) as HTMLElement[];
    expect(names.map((n) => n.textContent?.trim())).toEqual([
      'speedwave_test_claude',
      'speedwave_test_mcp-hub',
      'speedwave_test_redmine',
    ]);

    const states = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="system-state"]')
    ) as HTMLElement[];
    expect(states.map((s) => s.textContent?.trim())).toEqual(['running', 'running', 'starting']);
  });

  it('renders a filled dot for healthy and hollow dot for unhealthy containers', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const healthy = fixture.nativeElement.querySelectorAll('[data-testid="system-dot-healthy"]');
    expect(healthy).toHaveLength(2);
    const unhealthy = fixture.nativeElement.querySelectorAll(
      '[data-testid="system-dot-unhealthy"]'
    );
    expect(unhealthy).toHaveLength(1);
  });

  it('applies terminal-minimal table classes on the wrapper', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const wrapper = fixture.nativeElement.querySelector(
      '[data-testid="system-table-wrapper"]'
    ) as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain('overflow-hidden');
    expect(wrapper.className).toContain('rounded');
    expect(wrapper.className).toContain('ring-1');
    expect(wrapper.className).toContain('ring-line');

    const table = fixture.nativeElement.querySelector(
      '[data-testid="system-table"]'
    ) as HTMLElement;
    expect(table.className).toContain('mono');
    expect(table.className).toContain('border-collapse');
  });

  it('renders the vm/overall/ide_bridge summary tiles', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="system-vm"]')?.textContent).toContain(
      'lima'
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="system-overall"]')?.textContent?.trim()
    ).toBe('degraded');
    expect(
      fixture.nativeElement.querySelector('[data-testid="system-bridge"]')?.textContent?.trim()
    ).toBe('connected');
  });

  // -- ARIA --

  it('includes a visually hidden caption describing the table', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const caption = fixture.nativeElement.querySelector('caption');
    expect(caption).not.toBeNull();
    expect(caption?.textContent?.trim()).toBe('System containers and health');
    expect(caption?.className).toContain('sr-only');
  });

  it('adds an aria-label communicating the actual restart-all scope', async () => {
    // The Tauri command recreates ALL project containers, not just the one
    // whose row was clicked. The label must communicate the actual scope.
    await component.ngOnInit();
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('[data-testid="system-restart"]');
    expect(buttons[0].getAttribute('aria-label')).toBe('Restart all project containers');
    expect(buttons[0].textContent?.trim()).toBe('restart all');
  });

  // -- Edge case: empty containers --

  it('shows an empty hint when health report has zero containers', async () => {
    mockTauri.invokeHandler = async () => MOCK_EMPTY_REPORT;

    await component.ngOnInit();
    fixture.detectChanges();

    const hint = fixture.nativeElement.querySelector('[data-testid="system-empty"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('No containers');
    expect(fixture.nativeElement.querySelector('[data-testid="system-table"]')).toBeNull();
  });

  it('shows an empty-project error when activeProject is null', async () => {
    projectState.activeProject = null;

    await component.ngOnInit();
    fixture.detectChanges();

    const error = fixture.nativeElement.querySelector('[data-testid="system-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('No active project');
  });

  // -- Error path --

  it('renders an error block when get_health rejects', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('health unavailable');
    };

    await component.ngOnInit();
    fixture.detectChanges();

    const error = fixture.nativeElement.querySelector('[data-testid="system-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('health unavailable');
    expect(error?.getAttribute('role')).toBe('alert');
  });

  // -- State transitions --

  it('refresh interval schedules setInterval with the 5 s cadence', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      await component.ngOnInit();
      fixture.detectChanges();

      expect(spy).toHaveBeenCalledOnce();
      const [, delay] = spy.mock.calls[0];
      expect(delay).toBe(SYSTEM_REFRESH_INTERVAL_MS);

      // ngOnDestroy clears the interval it created.
      component.ngOnDestroy();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('refresh invoked directly re-fetches health', async () => {
    const calls: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      calls.push(cmd);
      return MOCK_HEALTHY_REPORT;
    };

    await component.ngOnInit();
    const baseline = calls.length;

    await component['refresh']();
    expect(calls.length).toBe(baseline + 1);
    await component['refresh']();
    expect(calls.length).toBe(baseline + 2);
  });

  it('restart button invokes recreate_project_containers then re-fetches health', async () => {
    const calls: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'get_health') return MOCK_HEALTHY_REPORT;
      return undefined;
    };

    await component.ngOnInit();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="system-restart"]'
    ) as HTMLButtonElement;
    await component['restart']('speedwave_test_claude');
    fixture.detectChanges();

    expect(calls).toContain('recreate_project_containers');
    expect(calls.filter((c) => c === 'get_health').length).toBeGreaterThanOrEqual(2);
    expect(btn.disabled).toBe(false); // restored after completion
  });

  it('disables the restart button while the restart is in flight', async () => {
    const restartResolver: { current: (() => void) | null } = { current: null };
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_health') return MOCK_HEALTHY_REPORT;
      if (cmd === 'recreate_project_containers') {
        return new Promise<void>((resolve) => {
          restartResolver.current = resolve;
        });
      }
      return undefined;
    };

    await component.ngOnInit();
    fixture.detectChanges();

    const restartPromise = component['restart']('speedwave_test_claude');
    fixture.detectChanges();

    expect(component.restarting.has('speedwave_test_claude')).toBe(true);

    restartResolver.current?.();
    await restartPromise;
    fixture.detectChanges();

    expect(component.restarting.has('speedwave_test_claude')).toBe(false);
  });
});
