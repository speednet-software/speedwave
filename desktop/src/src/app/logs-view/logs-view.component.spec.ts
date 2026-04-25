import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
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
      providers: [{ provide: TauriService, useValue: mockTauri }],
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
    expect(times[0].textContent?.trim()).toBe('14:34:02.814');

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

    component.setLevel('error');
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

    component.setSource('lima-does-not-exist');
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

  it('shows "No active project" error when activeProject is null', async () => {
    projectState.activeProject = null;

    await component.ngOnInit();
    fixture.detectChanges();

    const error = fixture.nativeElement.querySelector('[data-testid="logs-error"]');
    expect(error?.textContent).toContain('No active project');
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

    component.setLevel('info');
    component.setSource('mcp-hub');
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="logs-line"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Dispatched tool call');
  });

  it('switching the source filter from all to redmine narrows the list', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    component.setSource('redmine');
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="logs-line"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('POST /projects/x');
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
});
