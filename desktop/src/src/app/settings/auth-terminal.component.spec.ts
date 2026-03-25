import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AuthTerminalComponent } from './auth-terminal.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('AuthTerminalComponent', () => {
  let component: AuthTerminalComponent;
  let fixture: ComponentFixture<AuthTerminalComponent>;
  let mockTauri: MockTauriService;

  const SAMPLE_COMMAND = "cd '/Users/test/Projects' && speedwave";
  const SAMPLE_COMMAND_WITH_PREFIX =
    "export SPEEDWAVE_DATA_DIR='/Users/test/.speedwave-dev' && cd '/Users/test/Projects' && speedwave";

  beforeEach(async () => {
    vi.useFakeTimers();
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
      if (cmd === 'get_auth_command') return SAMPLE_COMMAND;
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [AuthTerminalComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(AuthTerminalComponent);
    component = fixture.componentInstance;
    component.project = 'test-project';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // navigator.clipboard may not exist in test environments (jsdom/happy-dom).
  // Provide a minimal mock so vi.spyOn works.
  function mockClipboard(impl: () => Promise<void>): void {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: impl },
      writable: true,
      configurable: true,
    });
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

  it('copies command to clipboard on click', async () => {
    const writeTextFn = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeTextFn);
    component.command = SAMPLE_COMMAND;
    await component.copyCommand();
    expect(writeTextFn).toHaveBeenCalledWith(SAMPLE_COMMAND);
  });

  it('shows Copied! feedback after copy', async () => {
    mockClipboard(vi.fn().mockResolvedValue(undefined));
    component.command = SAMPLE_COMMAND;
    await component.copyCommand();
    expect(component.copied).toBe(true);
  });

  it('resets Copied! feedback after 2 seconds', async () => {
    mockClipboard(vi.fn().mockResolvedValue(undefined));
    component.command = SAMPLE_COMMAND;
    await component.copyCommand();
    expect(component.copied).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(component.copied).toBe(false);
  });

  it('handles clipboard write failure', async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error('clipboard denied')));
    component.command = SAMPLE_COMMAND;
    await component.copyCommand();
    expect(component.error).toBe('Failed to copy to clipboard');
  });

  it('cleans up copy timer on destroy', async () => {
    mockClipboard(vi.fn().mockResolvedValue(undefined));
    component.command = SAMPLE_COMMAND;
    await component.copyCommand();
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
});
