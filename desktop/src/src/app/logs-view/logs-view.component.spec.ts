import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LogsViewComponent, parseLogLine } from './logs-view.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';

const MOCK_LOGS = [
  'speedwave_test_mcp-hub_1 | [14:34:02.814] INFO  Dispatched tool call',
  'speedwave_test_redmine_1 | [14:34:01.672] INFO  POST /projects/x → 201',
  'speedwave_test_sharepoint_1 | [14:33:58.440] WARN  OAuth token expires soon',
  'speedwave_test_slack_1 | [14:33:42.018] ERROR rate_limited: channels.history',
  'speedwave_test_mcp-hub_1 | [14:33:57.182] DEBUG Low-level handshake chunk',
].join('\n');

describe('LogsViewComponent', () => {
  let component: LogsViewComponent;
  let fixture: ComponentFixture<LogsViewComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return MOCK_LOGS;
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [LogsViewComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }, provideRouter([])],
    }).compileComponents();

    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'test';

    fixture = TestBed.createComponent(LogsViewComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // -- Happy path --

  it('renders a line per parsed log entry', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const lines = fixture.nativeElement.querySelectorAll('[data-testid="logs-line"]');
    expect(lines).toHaveLength(5);
  });

  it('renders the parsed timestamp / source / level / message', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const times = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="logs-time"]')
    ) as HTMLElement[];
    // formatTime() prefixes bracketed `HH:MM:SS` stamps with today's date so
    // the time column always carries a day. The raw bracketed value is kept
    // in the `title` attribute for hover.
    expect(times[0].textContent?.trim()).toMatch(/^\d{4}-\d{2}-\d{2} 14:34:02$/);
    expect(times[0].getAttribute('title')).toBe('14:34:02.814');

    const sources = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="logs-source"]')
    ) as HTMLElement[];
    expect(sources[0].textContent?.trim()).toBe('mcp-hub');

    const levels = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="logs-level"]')
    ) as HTMLElement[];
    expect(levels.map((l) => l.textContent?.trim())).toEqual([
      'info',
      'info',
      'warn',
      'error',
      'debug',
    ]);

    const messages = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="logs-message"]')
    ) as HTMLElement[];
    expect(messages[3].textContent).toContain('rate_limited');
  });

  it("prefixes today's date when the log line only carries HH:MM:SS", async () => {
    // Reproduces the user-reported regression where the time column showed
    // `11:32:56` with no day. Application-level logs inside the container
    // emit `[HH:MM:SS]` and that often reaches the parser before any
    // compose-level ISO stamp does. The fallback dates them with the host's
    // current day so two entries from different days cannot collide.
    mockTauri.invokeHandler = async (cmd: string) =>
      cmd === 'get_compose_logs' ? 'speedwave_test_mcp-hub_1 | [11:32:56] INFO  hello' : undefined;
    vi.spyOn(component as unknown as { todayIso(): string }, 'todayIso').mockReturnValue(
      '2026-04-28'
    );

    await component.ngOnInit();
    fixture.detectChanges();

    const time = fixture.nativeElement.querySelector('[data-testid="logs-time"]') as HTMLElement;
    expect(time.textContent?.trim()).toBe('2026-04-28 11:32:56');
    expect(time.getAttribute('title')).toBe('11:32:56');
  });

  it('renders ISO timestamps as `YYYY-MM-DD HH:MM:SS` and exposes the raw value via title', async () => {
    // `nerdctl compose logs --timestamps` prefixes lines with RFC3339
    // stamps. The view shrinks them to a fixed-width `YYYY-MM-DD HH:MM:SS`
    // for the time column and keeps the full ISO value in `[title]` so
    // hovering still reveals microseconds + timezone.
    mockTauri.invokeHandler = async (cmd: string) =>
      cmd === 'get_compose_logs'
        ? 'speedwave_test_mcp-hub_1 | 2026-04-28T11:32:56.123456Z INFO  hello'
        : undefined;

    await component.ngOnInit();
    fixture.detectChanges();

    const time = fixture.nativeElement.querySelector('[data-testid="logs-time"]') as HTMLElement;
    expect(time.textContent?.trim()).toBe('2026-04-28 11:32:56');
    expect(time.getAttribute('title')).toBe('2026-04-28T11:32:56.123456Z');
  });

  // -- ARIA --

  it('marks the scroll region as role="log" with aria-live="polite"', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const scroll = fixture.nativeElement.querySelector('[data-testid="logs-scroll"]');
    expect(scroll?.getAttribute('role')).toBe('log');
    expect(scroll?.getAttribute('aria-live')).toBe('polite');
  });

  it('marks each level chip with aria-pressed reflecting active state', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const chipAll = fixture.nativeElement.querySelector('[data-testid="logs-level-all"]');
    const chipError = fixture.nativeElement.querySelector('[data-testid="logs-level-error"]');
    expect(chipAll?.getAttribute('aria-pressed')).toBe('true');
    expect(chipError?.getAttribute('aria-pressed')).toBe('false');

    component['setLevel']('error');
    fixture.detectChanges();

    expect(
      fixture.nativeElement
        .querySelector('[data-testid="logs-level-all"]')
        ?.getAttribute('aria-pressed')
    ).toBe('false');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="logs-level-error"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
  });

  // -- Edge cases --

  it('renders an empty-hint when no log lines are returned', async () => {
    mockTauri.invokeHandler = async () => '';

    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    const empty = fixture.nativeElement.querySelector('[data-testid="logs-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No logs captured');
  });

  it('renders a filter-empty hint when lines exist but filters exclude all', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    component['setLevel']('warn');
    component['setSource']('mcp-hub');
    fixture.detectChanges();

    const empty = fixture.nativeElement.querySelector('[data-testid="logs-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No log lines match');
  });

  it('wraps a very long log message with break-words', async () => {
    const longMessage = 'x'.repeat(2000);
    mockTauri.invokeHandler = async () =>
      `speedwave_test_claude_1 | [12:00:00] INFO  ${longMessage}`;

    await component.ngOnInit();
    fixture.detectChanges();

    const message = fixture.nativeElement.querySelector(
      '[data-testid="logs-message"]'
    ) as HTMLElement;
    expect(message.textContent).toContain(longMessage);
    expect(message.className).toContain('break-words');
  });

  // -- Error path --

  it('renders an error block when get_compose_logs rejects', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('compose logs unavailable');
    };

    await component.ngOnInit();
    fixture.detectChanges();

    const error = fixture.nativeElement.querySelector('[data-testid="logs-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('compose logs unavailable');
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('shows "No active project" error when activeProject is null and the lifecycle has settled', async () => {
    projectState.activeProject = null;
    // Mark the lifecycle as settled (any non-loading status works) so the
    // banner is allowed to surface — during boot the view stays in a quiet
    // loading state instead.
    projectState.status = 'error';

    await component.ngOnInit();
    fixture.detectChanges();

    const error = fixture.nativeElement.querySelector('[data-testid="logs-error"]');
    expect(error?.textContent).toContain('No active project');
  });

  it('stays in loading state without an error when project lifecycle is still booting', async () => {
    projectState.activeProject = null;
    projectState.status = 'loading';

    await component.ngOnInit();
    fixture.detectChanges();

    expect(component.error()).toBe('');
    expect(component.loading()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="logs-error"]')).toBeNull();
  });

  it('refetches logs once the project lifecycle settles after mount', async () => {
    // Simulate the boot race: component mounts before the shell has had a
    // chance to load `activeProject`. The view should pick up the project as
    // soon as `onProjectSettled` fires and stop showing the loading state.
    projectState.activeProject = null;
    projectState.status = 'loading';
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.lines()).toHaveLength(0);

    projectState.activeProject = 'test';
    projectState.status = 'ready';
    // The mock service exposes a notify hook through onProjectSettled
    // listeners — emulate a settled event by calling all registered callbacks.
    (projectState as unknown as { settledListeners: Array<() => void> }).settledListeners.forEach(
      (cb) => cb()
    );
    // The settled callback fires `void this.refresh()` — let the queued
    // microtask resolve before asserting on the new state.
    await new Promise<void>((r) => setTimeout(r, 0));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.lines().length).toBeGreaterThan(0);
    expect(component.error()).toBe('');
  });

  // -- State transitions (filters combine) --

  it('filtering by level=error leaves only the error row visible', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[data-testid="logs-line"]')).toHaveLength(5);

    const errorChip = fixture.nativeElement.querySelector(
      '[data-testid="logs-level-error"]'
    ) as HTMLButtonElement;
    errorChip.click();
    fixture.detectChanges();

    const remaining = fixture.nativeElement.querySelectorAll('[data-testid="logs-line"]');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].textContent).toContain('rate_limited');
  });

  it('source + level filters combine (level=info and source=mcp-hub leaves the hub INFO row)', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    component['setLevel']('info');
    component['setSource']('mcp-hub');
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="logs-line"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Dispatched tool call');
  });

  it('switching the source filter from all to redmine narrows the list', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    component['setSource']('redmine');
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="logs-line"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('POST /projects/x');
  });

  // -- Source select --

  it('renders a source <select> with one option per distinct source plus "all"', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector(
      '[data-testid="logs-source-select"]'
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    const values = Array.from(select.options).map((o) => o.value);
    // 4 distinct sources in MOCK_LOGS: mcp-hub, redmine, sharepoint, slack — sorted alphabetically.
    expect(values).toEqual(['all', 'mcp-hub', 'redmine', 'sharepoint', 'slack']);
  });

  it('source select option labels carry per-source line counts', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector(
      '[data-testid="logs-source-select"]'
    ) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent?.trim());
    expect(labels[0]).toBe('all sources (5)');
    // mcp-hub appears twice in MOCK_LOGS (info + debug) so its counter must read 2.
    expect(labels.find((l) => l?.startsWith('mcp-hub'))).toBe('mcp-hub (2)');
    expect(labels.find((l) => l?.startsWith('redmine'))).toBe('redmine (1)');
  });

  it('changing the source select narrows the visible rows', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector(
      '[data-testid="logs-source-select"]'
    ) as HTMLSelectElement;
    select.value = 'sharepoint';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="logs-line"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('OAuth token expires');
  });

  it('falls back to source=all when the selected source vanishes from a refresh', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    component['setSource']('redmine');
    expect(component.filters().source).toBe('redmine');

    // Next refresh returns logs without the `redmine` source — the stale
    // selection must be reconciled instead of stranding the user on an empty list.
    mockTauri.invokeHandler = async (cmd: string) =>
      cmd === 'get_compose_logs'
        ? 'speedwave_test_mcp-hub_1 | [12:00:00] INFO  still here'
        : undefined;
    await component['refresh']();
    fixture.detectChanges();

    expect(component.filters().source).toBe('all');
  });
});

describe('parseLogLine', () => {
  it('parses a compose-format line with timestamp and level', () => {
    const line = parseLogLine('mcp_hub_1 | [14:34:02.814] INFO  Listening on :4000');
    expect(line.source).toBe('mcp_hub');
    expect(line.time).toBe('14:34:02.814');
    expect(line.level).toBe('info');
    expect(line.message).toBe('Listening on :4000');
  });

  it('strips the speedwave_<project>_ prefix from compose sources', () => {
    const line = parseLogLine('speedwave_demo_mcp-hub_1 | [10:00:00] INFO  started');
    expect(line.source).toBe('mcp-hub');
  });

  it('normalises WARNING to warn and TRACE to debug', () => {
    expect(parseLogLine('hub_1 | [00:00:00] WARNING x').level).toBe('warn');
    expect(parseLogLine('hub_1 | [00:00:00] TRACE x').level).toBe('debug');
  });

  it('handles lines with no level prefix', () => {
    const line = parseLogLine('hub_1 | [00:00:00] raw text');
    expect(line.level).toBe('info');
    expect(line.message).toBe('raw text');
  });

  it('handles a completely unstructured line', () => {
    const line = parseLogLine('a plain line with no pipe');
    expect(line.source).toBe('log');
    expect(line.level).toBe('info');
    expect(line.message).toBe('a plain line with no pipe');
  });

  it('returns empty fields on blank input', () => {
    const line = parseLogLine('   ');
    expect(line.source).toBe('log');
    expect(line.message).toBe('');
  });

  it('parses an ISO-timestamp line via the ISO_TIME_RE branch', () => {
    const line = parseLogLine('hub_1 | 2024-01-15T14:34:02.814Z INFO started');
    expect(line.time).toBe('2024-01-15T14:34:02.814Z');
    expect(line.level).toBe('info');
    expect(line.message).toBe('started');
  });
});

describe('LogsViewComponent — status bar layout', () => {
  let component: LogsViewComponent;
  let fixture: ComponentFixture<LogsViewComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;

  const MOCK_HEALTH = {
    containers: [
      { name: 'speedwave_demo_hub', status: 'running', healthy: true },
      { name: 'speedwave_demo_redmine', status: 'running', healthy: true },
      { name: 'speedwave_demo_sharepoint', status: 'starting', healthy: false },
    ],
    vm: { running: true, vm_type: 'lima' },
    mcp_os: { running: true },
    ide_bridge: {
      running: true,
      port: 4001,
      ws_url: 'ws://127.0.0.1:4001',
      detected_ides: [{ ide_name: 'cursor', port: 49820, ws_url: null }],
      // Connected = an IDE has been actively selected via `select_ide`. The
      // status bar reads this field as SSOT — `running` alone is not enough.
      selected_ide: { ide_name: 'cursor', port: 49820, ws_url: null },
    },
    overall_healthy: false,
  };

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health') return MOCK_HEALTH;
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [LogsViewComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }, provideRouter([])],
    }).compileComponents();

    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'demo';

    fixture = TestBed.createComponent(LogsViewComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('renders the System health header with project pill and refresh hint', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const title = fixture.nativeElement.querySelector('[data-testid="logs-title"]');
    expect(title).not.toBeNull();
    expect(title.textContent).toContain('System health');
    const hint = fixture.nativeElement.querySelector('[data-testid="logs-refresh-hint"]');
    expect(hint).not.toBeNull();
    const pill = fixture.nativeElement.querySelector('app-project-pill');
    expect(pill).not.toBeNull();
  });

  it('renders a single full-width status bar with overall / vm / containers / bridge / mcp_os sections', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('[data-testid="logs-status-bar"]');
    expect(bar).not.toBeNull();
    // role="status" so screen readers announce the latest snapshot in place.
    expect(bar?.getAttribute('role')).toBe('status');

    expect(fixture.nativeElement.querySelector('[data-testid="health-overall"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="health-vm"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="health-containers"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="health-bridge"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="health-mcpos"]')).not.toBeNull();
  });

  it('computed signals reflect the current health snapshot', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.vmRunning()).toBe(true);
    expect(component.bridgeConnected()).toBe(true);
    expect(component.mcpOsRunning()).toBe(true);
    expect(component.anyContainerUnhealthy()).toBe(true);
    expect(component.containersLabel()).toContain('2 of 3');
    expect(component.containersDetail()).toContain('sharepoint');
    expect(component.detectedIdes()).toHaveLength(1);
  });

  it('reports disconnected and surfaces a connect link when bridge is running but no IDE is selected (SSOT regression guard)', async () => {
    // Backend can report `running: true` (the bridge daemon is scanning for
    // IDEs) while no IDE has been actively selected — historically the UI
    // confused the two and showed `connected · Cursor :…` even though the
    // /integrations table offered a `connect →` button. The status bar must
    // read `selected_ide` as the source of truth for the connected state
    // and offer a deep-link to the section where the user can connect.
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health')
        return {
          ...MOCK_HEALTH,
          ide_bridge: {
            ...MOCK_HEALTH.ide_bridge,
            selected_ide: null,
          },
        };
      return undefined;
    };
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.bridgeConnected()).toBe(false);
    // Detail line still carries a count, but the "none selected" label is
    // gone — the routerLink takes its place so the action is one click away.
    expect(component.bridgeDetail()).toBe('1 detected');
    expect(component.bridgeShowConnectLink()).toBe(true);

    const link = fixture.nativeElement.querySelector(
      '[data-testid="bridge-connect-link"]'
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent?.trim()).toContain('connect');
    // Anchor target must point to the IDE Bridge section in /integrations
    // so anchorScrolling can drop the user right at the connect table.
    expect(link.getAttribute('href')).toBe('/integrations#ide-bridge');
  });

  it('hides the connect link and reports `no IDE detected` when neither selected nor detected', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health')
        return {
          ...MOCK_HEALTH,
          ide_bridge: {
            running: false,
            port: null,
            ws_url: null,
            detected_ides: [],
            selected_ide: null,
          },
        };
      return undefined;
    };
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.bridgeConnected()).toBe(false);
    expect(component.bridgeDetail()).toBe('no IDE detected');
    expect(component.bridgeShowConnectLink()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="bridge-connect-link"]')).toBeNull();
  });

  it('hides the connect link when an IDE is already selected', async () => {
    // MOCK_HEALTH starts with selected_ide set — the link must not appear
    // because the user has nothing left to connect.
    await component.ngOnInit();
    fixture.detectChanges();
    expect(component.bridgeConnected()).toBe(true);
    expect(component.bridgeShowConnectLink()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="bridge-connect-link"]')).toBeNull();
  });

  it('details panel toggles open and lists per-container + detected IDE rows', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    // Default: details collapsed so logs claim maximum vertical space.
    expect(fixture.nativeElement.querySelector('[data-testid="logs-status-details"]')).toBeNull();

    const overallBtn = fixture.nativeElement.querySelector(
      '[data-testid="health-overall"]'
    ) as HTMLButtonElement;
    overallBtn.click();
    fixture.detectChanges();

    const details = fixture.nativeElement.querySelector('[data-testid="logs-status-details"]');
    expect(details).not.toBeNull();

    // One row per container, identified by stripped name.
    expect(
      fixture.nativeElement.querySelector('[data-testid="health-container-hub"]')
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="health-container-sharepoint"]')
    ).not.toBeNull();

    // One row for the cursor IDE detected in the snapshot.
    const ideRows = fixture.nativeElement.querySelectorAll('[data-testid="health-ide-row"]');
    expect(ideRows).toHaveLength(1);
    expect(ideRows[0].textContent).toContain('cursor');
    expect(ideRows[0].textContent).toContain('49820');

    // Re-clicking collapses the panel.
    overallBtn.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="logs-status-details"]')).toBeNull();
  });

  it('renders refresh and export-diagnostics controls in the status bar', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="logs-refresh"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="logs-export"]')).not.toBeNull();
  });

  it('export-diagnostics invokes the matching tauri command and opens the confirmation dialog with the resulting path', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health') return MOCK_HEALTH;
      if (cmd === 'export_diagnostics') return '/tmp/speedwave-diag.zip';
      return undefined;
    };
    await component.ngOnInit();
    fixture.detectChanges();
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');

    // Dialog must stay closed before the user clicks export so it can never
    // appear from a stale signal in another flow.
    expect(
      fixture.nativeElement.querySelector('[data-testid="export-diagnostics-overlay"]')
    ).toBeNull();

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="logs-export"]'
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(invokeSpy).toHaveBeenCalledWith(
      'export_diagnostics',
      expect.objectContaining({ project: 'demo' })
    );
    expect(component.diagnosticsExporting()).toBe(false);
    expect(component.diagnosticsPath()).toBe('/tmp/speedwave-diag.zip');
    expect(component.exportDialogOpen()).toBe(true);

    expect(
      fixture.nativeElement.querySelector('[data-testid="export-diagnostics-overlay"]')
    ).not.toBeNull();
    const note = fixture.nativeElement.querySelector('[data-testid="modal-note"]');
    expect(note?.textContent).toContain('/tmp/speedwave-diag.zip');
  });

  it('does not open the export dialog when the backend returns an empty path', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health') return MOCK_HEALTH;
      if (cmd === 'export_diagnostics') return '   ';
      return undefined;
    };
    await component.ngOnInit();
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector('[data-testid="logs-export"]') as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.exportDialogOpen()).toBe(false);
    expect(
      fixture.nativeElement.querySelector('[data-testid="export-diagnostics-overlay"]')
    ).toBeNull();
  });

  it('copy button writes the path to the clipboard and flips its label to copied', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health') return MOCK_HEALTH;
      if (cmd === 'export_diagnostics') return '/tmp/speedwave-diag.zip';
      return undefined;
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await component.ngOnInit();
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector('[data-testid="logs-export"]') as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();

    const copyBtn = fixture.nativeElement.querySelector(
      '[data-testid="export-diagnostics-copy"]'
    ) as HTMLButtonElement;
    expect(copyBtn.textContent?.trim()).toBe('copy path');
    copyBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledWith('/tmp/speedwave-diag.zip');
    expect(component.diagnosticsCopied()).toBe(true);
    const updated = fixture.nativeElement.querySelector(
      '[data-testid="export-diagnostics-copy"]'
    ) as HTMLButtonElement;
    expect(updated.textContent?.trim()).toBe('copied ✓');
  });

  it('close button dismisses the dialog and clears the transient copy state', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health') return MOCK_HEALTH;
      if (cmd === 'export_diagnostics') return '/tmp/speedwave-diag.zip';
      return undefined;
    };
    await component.ngOnInit();
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector('[data-testid="logs-export"]') as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();
    component.diagnosticsCopied.set(true);

    (
      fixture.nativeElement.querySelector(
        '[data-testid="export-diagnostics-close"]'
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(component.exportDialogOpen()).toBe(false);
    expect(component.diagnosticsCopied()).toBe(false);
    expect(
      fixture.nativeElement.querySelector('[data-testid="export-diagnostics-overlay"]')
    ).toBeNull();
  });

  it('clipboard rejection routes the failure into the error banner and closes the dialog', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health') return MOCK_HEALTH;
      if (cmd === 'export_diagnostics') return '/tmp/speedwave-diag.zip';
      return undefined;
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) },
      configurable: true,
    });
    await component.ngOnInit();
    fixture.detectChanges();

    (
      fixture.nativeElement.querySelector('[data-testid="logs-export"]') as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        '[data-testid="export-diagnostics-copy"]'
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.exportDialogOpen()).toBe(false);
    expect(component.error()).toContain('clipboard denied');
  });

  it('export-diagnostics surfaces backend errors via the existing error banner', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health') return MOCK_HEALTH;
      if (cmd === 'export_diagnostics') throw new Error('zip failed');
      return undefined;
    };
    await component.ngOnInit();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="logs-export"]'
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.diagnosticsExporting()).toBe(false);
    const banner = fixture.nativeElement.querySelector('[data-testid="logs-error"]');
    expect(banner?.textContent).toContain('zip failed');
  });

  it('forces trace-level logging on init so exported diagnostics carry full context', async () => {
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    await component.ngOnInit();
    expect(invokeSpy).toHaveBeenCalledWith('set_log_level', { level: 'trace' });
  });

  it('does not surface set_log_level failures (browser dev mode is silent)', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'set_log_level') throw new Error('not in tauri');
      if (cmd === 'get_compose_logs') return '';
      if (cmd === 'get_health') return MOCK_HEALTH;
      return undefined;
    };
    await component.ngOnInit();
    fixture.detectChanges();
    // forceMaxLogLevel is best-effort — the error must not bleed into the
    // banner or block subsequent fetches.
    expect(component.error()).toBe('');
  });

  it('schedules a scroll-to-bottom write after each successful fetch', async () => {
    // Reproduces the user-visible bug where opening /logs landed on top of
    // the stream. The component delegates the actual scroll to
    // `afterNextRender({ write })` so the browser commits DOM first; that
    // hook does not flush in the jsdom test runtime. We assert the contract
    // instead — `scrollToBottom` is invoked after `lines.set(...)` so the
    // render hook has work to do once Angular commits.
    const scrollSpy = vi.spyOn(
      component as unknown as { scrollToBottom(): void },
      'scrollToBottom'
    );

    await component.ngOnInit();
    fixture.detectChanges();

    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });
});
