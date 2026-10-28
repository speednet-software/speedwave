import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatHeaderTerminalComponent } from './chat-header-terminal.component';
import { ProjectStateService } from '../../services/project-state.service';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { createDeferred } from '../../testing/deferred';

const TERMINAL = '[data-testid="chat-header-terminal"]';
const NOTICE = '[data-testid="chat-header-terminal-notice"]';
const COPY_ITEM = '[data-testid="chat-header-terminal-copy"]';

describe('ChatHeaderTerminalComponent', () => {
  let fixture: ComponentFixture<ChatHeaderTerminalComponent>;
  let tauri: MockTauriService;
  let projectState: ProjectStateService;
  let calls: { cmd: string; args?: Record<string, unknown> }[];

  const button = (): HTMLButtonElement =>
    fixture.nativeElement.querySelector(TERMINAL) as HTMLButtonElement;
  const notice = (): HTMLElement | null => fixture.nativeElement.querySelector(NOTICE);
  const copyItem = (): HTMLElement | null => document.querySelector(COPY_ITEM);

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  }

  function openMenu(): void {
    button().dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    );
    fixture.detectChanges();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    tauri = new MockTauriService();
    calls = [];
    tauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      return undefined;
    };
    await TestBed.configureTestingModule({
      imports: [ChatHeaderTerminalComponent],
      providers: [{ provide: TauriService, useValue: tauri }],
    }).compileComponents();

    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set('alpha');
    projectState.status.set('ready');
    fixture = TestBed.createComponent(ChatHeaderTerminalComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('renders an enabled button with its tooltip label and no popup attribute', () => {
    expect(button().disabled).toBe(false);
    expect(button().getAttribute('aria-label')).toBe('Open project in terminal');
    expect(button().hasAttribute('aria-haspopup')).toBe(false);
  });

  it('is disabled without an active project', () => {
    projectState.activeProject.set(null);
    fixture.detectChanges();
    expect(button().disabled).toBe(true);
  });

  it('is disabled while the status is switching', () => {
    projectState.status.set('switching');
    fixture.detectChanges();
    expect(button().disabled).toBe(true);
  });

  it('opens the terminal for the active project on click', async () => {
    button().click();
    await settle();
    expect(calls).toEqual([{ cmd: 'open_project_terminal', args: { project: 'alpha' } }]);
    expect(notice()).toBeNull();
  });

  it('shows the rejection of the open command', async () => {
    tauri.invokeHandler = () => Promise.reject('no terminal found');
    button().click();
    await settle();
    expect(notice()?.textContent?.trim()).toBe('no terminal found');
    expect(notice()?.getAttribute('role')).toBe('status');
  });

  it('shows the message of an Error rejection', async () => {
    tauri.invokeHandler = () => Promise.reject(new Error('boom'));
    button().click();
    await settle();
    expect(notice()?.textContent?.trim()).toBe('boom');
  });

  it('shows nothing when the project changed during a failing open', async () => {
    const pending = createDeferred<void>();
    tauri.invokeHandler = () => pending.promise;
    button().click();
    await settle();
    projectState.activeProject.set('beta');
    pending.reject('late failure');
    await settle();
    expect(notice()).toBeNull();
  });

  it('opens the context menu with a Copy command item on contextmenu', () => {
    expect(copyItem()).toBeNull();
    openMenu();
    expect(copyItem()?.textContent?.trim()).toBe('Copy command');
  });

  it('does not open the context menu while disabled', () => {
    projectState.status.set('switching');
    fixture.detectChanges();
    openMenu();
    expect(copyItem()).toBeNull();
  });

  it('copies the command through the backend and shows "Command copied" for 2 seconds', async () => {
    openMenu();
    copyItem()?.click();
    await settle();
    expect(calls).toEqual([{ cmd: 'copy_project_terminal_command', args: { project: 'alpha' } }]);
    expect(notice()?.textContent?.trim()).toBe('Command copied');

    await vi.advanceTimersByTimeAsync(1999);
    fixture.detectChanges();
    expect(notice()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    fixture.detectChanges();
    expect(notice()).toBeNull();
  });

  it('shows the error when copying fails', async () => {
    tauri.invokeHandler = () => Promise.reject('clipboard unavailable');
    openMenu();
    copyItem()?.click();
    await settle();
    expect(notice()?.textContent?.trim()).toBe('clipboard unavailable');
  });

  it('shows no notice when the project changed during a successful copy', async () => {
    const pending = createDeferred<void>();
    tauri.invokeHandler = () => pending.promise;
    openMenu();
    copyItem()?.click();
    await settle();
    projectState.activeProject.set('beta');
    pending.resolve();
    await settle();
    expect(notice()).toBeNull();
  });

  it('replaces an older notice with a newer one and restarts the timer', async () => {
    tauri.invokeHandler = () => Promise.reject('first');
    button().click();
    await settle();
    expect(notice()?.textContent?.trim()).toBe('first');

    tauri.invokeHandler = async () => undefined;
    openMenu();
    copyItem()?.click();
    await settle();
    expect(notice()?.textContent?.trim()).toBe('Command copied');
    await vi.advanceTimersByTimeAsync(2000);
    fixture.detectChanges();
    expect(notice()).toBeNull();
  });

  it('clears its timer on destroy', async () => {
    openMenu();
    copyItem()?.click();
    await settle();
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
