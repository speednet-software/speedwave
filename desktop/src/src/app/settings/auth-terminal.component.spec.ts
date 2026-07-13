import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Clipboard } from '@angular/cdk/clipboard';
import { AuthTerminalComponent } from './auth-terminal.component';
import { TauriService } from '../services/tauri.service';
import { LoggerService } from '../services/logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('AuthTerminalComponent', () => {
  let component: AuthTerminalComponent;
  let fixture: ComponentFixture<AuthTerminalComponent>;
  let mockTauri: MockTauriService;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  const SAMPLE_COMMAND = "cd '/Users/test/Projects' && speedwave login --project 'test-project'";
  const SAMPLE_COMMAND_WITH_PREFIX =
    "export SPEEDWAVE_DATA_DIR='/Users/test/.speedwave-dev' && cd '/Users/test/Projects' && speedwave login --project 'test-project'";

  beforeEach(async () => {
    vi.useFakeTimers();
    mockTauri = new MockTauriService();
    mockLogger = makeMockLogger();

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') return SAMPLE_COMMAND;
      if (cmd === 'get_platform') return 'macos';
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [AuthTerminalComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: mockLogger },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AuthTerminalComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('project', 'test-project');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Replace the CDK `Clipboard.copy` implementation with a spy returning `returns`; the spy is
   * returned for assertions.
   * @param returns - the boolean the spy should return when invoked
   */
  function mockClipboard(returns: boolean): ReturnType<typeof vi.fn> {
    const spy = vi.fn().mockReturnValue(returns);
    const cdkClipboard = TestBed.inject(Clipboard);
    cdkClipboard.copy = spy as unknown as typeof cdkClipboard.copy;
    return spy;
  }

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('fetches command on init', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(component.command).toBe(SAMPLE_COMMAND);
  });

  it('calls get_auth_command with correct project', () => {
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    fixture.detectChanges();
    expect(invokeSpy).toHaveBeenCalledWith('get_auth_command', { project: 'test-project' });
  });

  it('displays command in auth-command element', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const el = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="auth-command"]');
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain(SAMPLE_COMMAND);
  });

  it('displays command with SPEEDWAVE_DATA_DIR prefix when present', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') return SAMPLE_COMMAND_WITH_PREFIX;
      return undefined;
    };
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const el = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="auth-command"]');
    expect(el!.textContent).toContain('SPEEDWAVE_DATA_DIR');
  });

  it('sets error when get_auth_command fails on init', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') throw 'project not found';
      return undefined;
    };
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(component.error).toBe('project not found');
  });

  it('starts polling even when get_auth_command fails', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') throw 'project not found';
      return undefined;
    };
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    vi.advanceTimersByTime(3000);
    expect(invokeSpy).toHaveBeenCalledWith('get_auth_status', { project: 'test-project' });
  });

  it('renders error banner when error is set', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') throw 'config error';
      return undefined;
    };
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const banner = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="auth-error"]'
    );
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('config error');
  });

  it('does not render error banner when error is empty', () => {
    component.error = '';
    fixture.detectChanges();
    const banner = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="auth-error"]'
    );
    expect(banner).toBeNull();
  });

  it('copies command to clipboard on click', () => {
    const spy = mockClipboard(true);
    component.command = SAMPLE_COMMAND;
    component.copyCommand();
    expect(spy).toHaveBeenCalledWith(SAMPLE_COMMAND);
  });

  it('shows Copied! feedback after copy', () => {
    mockClipboard(true);
    component.command = SAMPLE_COMMAND;
    component.copyCommand();
    expect(component.copied).toBe(true);
  });

  it('resets Copied! feedback after 2 seconds', () => {
    mockClipboard(true);
    component.command = SAMPLE_COMMAND;
    component.copyCommand();
    expect(component.copied).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(component.copied).toBe(false);
  });

  it('handles clipboard write failure', () => {
    mockClipboard(false);
    component.command = SAMPLE_COMMAND;
    component.copyCommand();
    expect(component.error).toBe('Failed to copy to clipboard');
  });

  it('cleans up copy timer on destroy', () => {
    mockClipboard(true);
    component.command = SAMPLE_COMMAND;
    component.copyCommand();
    expect(component.copied).toBe(true);
    component.ngOnDestroy();
    vi.advanceTimersByTime(2000);
    // copied remains true because the timer was cleared before it could reset
    expect(component.copied).toBe(true);
  });

  it('auth-command element is queryable by data-testid', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const el = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="auth-command"]');
    expect(el).toBeTruthy();
  });

  it('copy button is disabled when command is empty', () => {
    component.command = '';
    fixture.detectChanges();
    const btn = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="auth-copy-command"]'
    );
    // Button is not rendered when command is empty (inside @if block)
    expect(btn).toBeNull();
  });

  it('copy button is enabled when command is set', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const btn = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="auth-copy-command"]'
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it('does not show Windows note on non-Windows platforms', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const note = (fixture.nativeElement as HTMLElement).textContent;
    expect(note).not.toContain('On Windows');
  });

  it('does not set error or crash when get_platform rejects (logs via LoggerService)', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') return SAMPLE_COMMAND;
      if (cmd === 'get_platform') throw 'platform probe failed';
      return undefined;
    };
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(component.error).toBe('');
    expect(component.isWindows).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('auth-terminal: get_platform failed: platform probe failed')
    );
  });

  it('shows Windows note on Windows platform', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') return SAMPLE_COMMAND;
      if (cmd === 'get_platform') return 'windows';
      return undefined;
    };
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const note = (fixture.nativeElement as HTMLElement).textContent;
    expect(note).toContain('On Windows');
    expect(note).toContain('PowerShell');
  });

  it('displays PowerShell-shaped command on Windows', async () => {
    const WIN_COMMAND =
      "Set-Location 'C:\\Users\\test\\Projects'; speedwave login --project 'test-project'";
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') return WIN_COMMAND;
      if (cmd === 'get_platform') return 'windows';
      return undefined;
    };
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const el = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="auth-command"]');
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain('Set-Location');
    expect(el!.textContent).toContain('; speedwave');
    expect(el!.textContent).not.toContain('&&');
  });

  it('starts polling on init', () => {
    fixture.detectChanges();
    vi.advanceTimersByTime(3000);
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    mockTauri.invokeHandler = async () => ({ oauth_authenticated: false });
    vi.advanceTimersByTime(3000);
    expect(invokeSpy).toHaveBeenCalledWith('get_auth_status', { project: 'test-project' });
  });

  it('cleans up polling timer on destroy', () => {
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    fixture.detectChanges();
    component.ngOnDestroy();
    invokeSpy.mockClear();
    vi.advanceTimersByTime(10000);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  // ── Open terminal primary button ─────────────────────────────────────────

  it('renders the primary "Open terminal" button', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const btn = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="auth-open-terminal"]'
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent?.trim()).toBe('Open terminal and log in');
  });

  it('shows "Or run this command yourself" hint above the copy block', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Or run this command yourself');
  });

  it('invokes start_oauth_login when the primary button is clicked', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();

    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    component.openTerminal();
    expect(invokeSpy).toHaveBeenCalledWith('start_oauth_login', { project: 'test-project' });
  });

  it('clears any previous error when openTerminal is invoked', async () => {
    component.error = 'previous error';
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    component.openTerminal();
    // Error is cleared synchronously before the Tauri call returns.
    expect(component.error).toBe('');
  });

  it('sets error and re-enables the button when start_oauth_login fails', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') return SAMPLE_COMMAND;
      if (cmd === 'get_platform') return 'macos';
      if (cmd === 'start_oauth_login') throw 'no terminal found';
      return undefined;
    };
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);

    component.openTerminal();
    await vi.advanceTimersByTimeAsync(0);
    // Allow the .finally() microtask to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(component.error).toBe('no terminal found');
    expect(component.opening).toBe(false);
  });

  it('keeps polling running after openTerminal is invoked', async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    component.openTerminal();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    vi.advanceTimersByTime(3000);
    expect(invokeSpy).toHaveBeenCalledWith('get_auth_status', { project: 'test-project' });
  });
});
