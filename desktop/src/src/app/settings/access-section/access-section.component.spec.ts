import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AccessSectionComponent } from './access-section.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { LoggerService } from '../../services/logger.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { makeMockLogger } from '../../testing/mock-logger';
import { createDeferred } from '../../testing/deferred';
import type { AccessSettingsView } from '../../models/access';

function view(overrides?: Partial<AccessSettingsView>): AccessSettingsView {
  return { read_only: false, read_only_locked: false, ...overrides };
}

describe('AccessSectionComponent', () => {
  let fixture: ComponentFixture<AccessSectionComponent>;
  let tauri: MockTauriService;
  let logger: ReturnType<typeof makeMockLogger>;
  let projectState: {
    isSettledOn: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    requestRestartFor: ReturnType<typeof vi.fn>;
  };
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let responses: Record<string, () => Promise<unknown>>;
  let errors: string[];

  const el = (id: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
  const toggle = (): HTMLInputElement => el('read-only-toggle') as HTMLInputElement;
  const invoked = (cmd: string) => calls.filter((c) => c.cmd === cmd);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };
  const flip = async (on: boolean): Promise<void> => {
    toggle().checked = on;
    toggle().dispatchEvent(new Event('change'));
    await settle();
  };

  async function create(): Promise<void> {
    fixture = TestBed.createComponent(AccessSectionComponent);
    fixture.componentRef.setInput('project', 'proj');
    fixture.componentInstance.errorOccurred.subscribe((m) => errors.push(m));
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    calls = [];
    errors = [];
    responses = {
      get_access_settings: async () => view(),
      set_read_only_mode: async () => view({ read_only: true }),
      restart_hub: async () => undefined,
    };
    tauri = new MockTauriService();
    tauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      const handler = responses[cmd];
      if (!handler) throw new Error(`unexpected ${cmd}`);
      return handler();
    };
    logger = makeMockLogger();
    projectState = {
      isSettledOn: vi.fn().mockReturnValue(true),
      status: vi.fn().mockReturnValue('ready'),
      requestRestartFor: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [AccessSectionComponent],
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: LoggerService, useValue: logger },
        { provide: ProjectStateService, useValue: projectState },
      ],
    });
  });

  it('shows the Agent access section with the read-only switch off by default', async () => {
    await create();

    expect(el('settings-section-access')?.textContent).toContain('Agent access');
    expect(el('settings-section-access')?.textContent).toContain('Read-only mode');
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(invoked('get_access_settings')[0].args).toEqual({ project: 'proj' });
  });

  it('shows a switch that is already on', async () => {
    responses['get_access_settings'] = async () => view({ read_only: true });
    await create();

    expect(toggle().checked).toBe(true);
  });

  it('shows no switch until the stored mode arrives', async () => {
    const pending = createDeferred<AccessSettingsView>();
    responses['get_access_settings'] = () => pending.promise;
    await create();
    expect(el('read-only-toggle')).toBeNull();

    pending.resolve(view({ read_only: true }));
    await settle();
    expect(toggle().checked).toBe(true);
  });

  it('stores the mode and restarts the hub without asking for a full restart', async () => {
    await create();

    await flip(true);

    expect(invoked('set_read_only_mode')[0].args).toEqual({ project: 'proj', enabled: true });
    expect(invoked('restart_hub')[0].args).toEqual({ project: 'proj' });
    expect(projectState.requestRestartFor).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(true);
  });

  it('asks for a restart of the project when it is not ready to restart the hub alone', async () => {
    projectState.status.mockReturnValue('loading');
    await create();

    await flip(true);

    expect(invoked('restart_hub')).toHaveLength(0);
    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
  });

  it('falls back to a full restart when the hub restart fails', async () => {
    responses['restart_hub'] = async () => {
      throw new Error('hub down');
    };
    await create();

    await flip(true);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hub down'));
    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
  });

  it('disables the switch and says the organization set it when MDM forces the mode', async () => {
    responses['get_access_settings'] = async () =>
      view({ read_only: true, read_only_locked: true });
    await create();

    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(true);
    expect(el('read-only-locked-note')?.textContent).toContain('Set by your organization');
  });

  it('shows no organization note when the mode is not locked', async () => {
    await create();

    expect(el('read-only-locked-note')).toBeNull();
  });

  it('lists what read-only mode does not cover', async () => {
    await create();

    const help = el('read-only-help')?.textContent ?? '';
    expect(help).toContain('Write, Edit, Bash and WebFetch');
    expect(help).toContain('Internet access from the container');
    expect(help).toContain('Credentials you put into the container by hand');
  });

  it('reports a rejected save, restarts nothing and shows the stored mode', async () => {
    const pending = createDeferred<AccessSettingsView>();
    responses['set_read_only_mode'] = () => pending.promise;
    await create();

    toggle().checked = true;
    toggle().dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(toggle().checked).toBe(true);
    pending.reject('Read-only mode is set by your organization and cannot be changed here.');
    await settle();

    expect(errors).toEqual([
      'Read-only mode is set by your organization and cannot be changed here.',
    ]);
    expect(invoked('restart_hub')).toHaveLength(0);
    expect(invoked('get_access_settings')).toHaveLength(2);
    expect(toggle().checked).toBe(false);
  });

  it('reports a mode it cannot read', async () => {
    responses['get_access_settings'] = async () => {
      throw new Error('config.json is not valid JSON');
    };
    await create();

    expect(errors).toEqual(['config.json is not valid JSON']);
    expect(el('read-only-toggle')).toBeNull();
  });

  it('blocks a second change while a save is running', async () => {
    const pending = createDeferred<AccessSettingsView>();
    responses['set_read_only_mode'] = () => pending.promise;
    await create();

    await flip(true);
    expect(toggle().disabled).toBe(true);

    pending.resolve(view({ read_only: true }));
    await settle();
    expect(toggle().disabled).toBe(false);
  });
});
