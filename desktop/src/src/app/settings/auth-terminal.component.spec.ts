import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AuthTerminalComponent } from './auth-terminal.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('AuthTerminalComponent', () => {
  let component: AuthTerminalComponent;
  let fixture: ComponentFixture<AuthTerminalComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockTauri = new MockTauriService();

    // Default: polling returns not-authenticated
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') return { oauth_authenticated: false };
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
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('clears error before opening terminal', () => {
    component.error = 'previous error';
    mockTauri.invokeHandler = async () => undefined;
    component.openTerminal();
    expect(component.error).toBe('');
  });

  it('sets error when open_auth_terminal fails', async () => {
    mockTauri.invokeHandler = async () => {
      throw 'CLI binary not found';
    };
    component.openTerminal();
    // Wait for the promise rejection to propagate
    await vi.advanceTimersByTimeAsync(0);
    expect(component.error).toBe('CLI binary not found');
  });

  it('calls open_auth_terminal with correct project', () => {
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    mockTauri.invokeHandler = async () => undefined;
    component.openTerminal();
    expect(invokeSpy).toHaveBeenCalledWith('open_auth_terminal', { project: 'test-project' });
  });

  it('renders error banner when error is set', async () => {
    mockTauri.invokeHandler = async () => {
      throw 'CLI not found at ~/.local/bin/speedwave';
    };
    component.openTerminal();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    const banner = (fixture.nativeElement as HTMLElement).querySelector('.error-banner');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('CLI not found');
  });

  it('does not render error banner when error is empty', () => {
    component.error = '';
    fixture.detectChanges();
    const banner = (fixture.nativeElement as HTMLElement).querySelector('.error-banner');
    expect(banner).toBeNull();
  });

  it('starts polling on init', () => {
    fixture.detectChanges(); // triggers ngOnInit
    vi.advanceTimersByTime(3000);
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    mockTauri.invokeHandler = async () => ({ oauth_authenticated: false });
    vi.advanceTimersByTime(3000);
    expect(invokeSpy).toHaveBeenCalledWith('get_auth_status', { project: 'test-project' });
  });

  it('cleans up polling timer on destroy', () => {
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    fixture.detectChanges(); // starts polling
    component.ngOnDestroy();
    // Clear existing call count
    invokeSpy.mockClear();
    // Advance timers — polling should not fire after destroy
    vi.advanceTimersByTime(10000);
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});
