import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { IntegrationAccessComponent } from './integration-access.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { LoggerService } from '../../services/logger.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { makeMockLogger } from '../../testing/mock-logger';
import { createDeferred } from '../../testing/deferred';
import type { IntegrationAccessView } from '../../models/access';

function view(overrides?: Partial<IntegrationAccessView>): IntegrationAccessView {
  return { mode: 'full', global_read_only: false, global_locked: false, ...overrides };
}

describe('IntegrationAccessComponent', () => {
  let fixture: ComponentFixture<IntegrationAccessComponent>;
  let tauri: MockTauriService;
  let logger: ReturnType<typeof makeMockLogger>;
  let projectState: {
    isSettledOn: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    requestRestartFor: ReturnType<typeof vi.fn>;
  };
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let responses: Record<string, () => Promise<unknown>>;

  const el = (id: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
  const button = (id: string): HTMLButtonElement => el(id) as HTMLButtonElement;
  const invoked = (cmd: string) => calls.filter((c) => c.cmd === cmd);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };

  async function create(service = 'slack', explainGlobal = false): Promise<void> {
    fixture = TestBed.createComponent(IntegrationAccessComponent);
    fixture.componentRef.setInput('project', 'proj');
    fixture.componentRef.setInput('service', service);
    fixture.componentRef.setInput('explainGlobal', explainGlobal);
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    calls = [];
    responses = {
      get_integration_access: async () => view(),
      set_integration_access_mode: async () => view({ mode: 'read_only' }),
      restart_hub: async () => undefined,
      restart_llm_proxy: async () => undefined,
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
      imports: [IntegrationAccessComponent],
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: LoggerService, useValue: logger },
        { provide: ProjectStateService, useValue: projectState },
      ],
    });
  });

  it('shows Access with Full selected by default', async () => {
    await create();

    expect(el('integration-access')?.textContent).toContain('Access');
    expect(button('integration-access-full').getAttribute('aria-checked')).toBe('true');
    expect(button('integration-access-read-only').getAttribute('aria-checked')).toBe('false');
    expect(button('integration-access-full').disabled).toBe(false);
    expect(invoked('get_integration_access')[0].args).toEqual({
      project: 'proj',
      service: 'slack',
    });
  });

  it('shows a stored Read-only mode', async () => {
    responses['get_integration_access'] = async () => view({ mode: 'read_only' });
    await create();

    expect(button('integration-access-read-only').getAttribute('aria-checked')).toBe('true');
  });

  it('shows nothing until the stored mode arrives', async () => {
    const pending = createDeferred<IntegrationAccessView>();
    responses['get_integration_access'] = () => pending.promise;
    await create();
    expect(el('integration-access-full')).toBeNull();

    pending.resolve(view({ mode: 'read_only' }));
    await settle();
    expect(button('integration-access-read-only').getAttribute('aria-checked')).toBe('true');
  });

  it('stores the mode of the integration and restarts the hub and the proxy', async () => {
    await create('mail');

    button('integration-access-read-only').click();
    await settle();

    expect(invoked('set_integration_access_mode')[0].args).toEqual({
      project: 'proj',
      service: 'mail',
      mode: 'read_only',
    });
    expect(invoked('restart_hub')[0].args).toEqual({ project: 'proj' });
    expect(invoked('restart_llm_proxy')[0].args).toEqual({ project: 'proj' });
    expect(projectState.requestRestartFor).not.toHaveBeenCalled();
    expect(button('integration-access-read-only').getAttribute('aria-checked')).toBe('true');
  });

  it('stores Full when the user switches back', async () => {
    responses['get_integration_access'] = async () => view({ mode: 'read_only' });
    responses['set_integration_access_mode'] = async () => view();
    await create();

    button('integration-access-full').click();
    await settle();

    expect(invoked('set_integration_access_mode')[0].args).toMatchObject({ mode: 'full' });
    expect(button('integration-access-full').getAttribute('aria-checked')).toBe('true');
  });

  it('does not save when the clicked mode is already the stored one', async () => {
    await create();

    button('integration-access-full').click();
    await settle();

    expect(invoked('set_integration_access_mode')).toHaveLength(0);
    expect(invoked('restart_hub')).toHaveLength(0);
  });

  it('asks for a restart of the project when it is not ready to restart the hub alone', async () => {
    projectState.status.mockReturnValue('loading');
    await create();

    button('integration-access-read-only').click();
    await settle();

    expect(invoked('restart_hub')).toHaveLength(0);
    expect(invoked('restart_llm_proxy')).toHaveLength(0);
    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
  });

  it('falls back to a full restart when the hub restart fails', async () => {
    responses['restart_hub'] = async () => {
      throw new Error('hub down');
    };
    await create();

    button('integration-access-read-only').click();
    await settle();

    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
  });

  it('falls back to a full restart when the proxy restart fails', async () => {
    responses['restart_llm_proxy'] = async () => {
      throw new Error('proxy down');
    };
    await create();

    button('integration-access-read-only').click();
    await settle();

    expect(invoked('restart_hub')).toHaveLength(1);
    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
  });

  it('shows Read-only and disables the control while the project is in read-only mode', async () => {
    responses['get_integration_access'] = async () => view({ global_read_only: true });
    await create();

    expect(button('integration-access-read-only').getAttribute('aria-checked')).toBe('true');
    expect(button('integration-access-full').getAttribute('aria-checked')).toBe('false');
    expect(button('integration-access-full').disabled).toBe(true);
    expect(button('integration-access-read-only').disabled).toBe(true);
  });

  it('leaves the reason to the screen banner and puts a hint on the buttons', async () => {
    responses['get_integration_access'] = async () => view({ global_read_only: true });
    await create();

    expect(el('integration-access-reason')).toBeNull();
    expect(button('integration-access-full').title).toBe(
      'Set for all integrations and plugins in Settings, Integration access'
    );
    expect(button('integration-access-read-only').title).toBe(
      'Set for all integrations and plugins in Settings, Integration access'
    );
  });

  it('names the organization in the hint when MDM forces the mode', async () => {
    responses['get_integration_access'] = async () =>
      view({ global_read_only: true, global_locked: true });
    await create();

    expect(button('integration-access-full').disabled).toBe(true);
    expect(button('integration-access-full').title).toBe(
      'Set for all integrations and plugins by your organization'
    );
  });

  it('explains the global mode in place when asked to, without a hint', async () => {
    responses['get_integration_access'] = async () => view({ global_read_only: true });
    await create('example-plugin', true);

    expect(el('integration-access-reason')?.textContent).toContain(
      'All integrations and plugins are read-only (Settings, Integration access)'
    );
    expect(el('integration-access-reason')?.textContent).not.toContain('organization');
    expect(button('integration-access-full').hasAttribute('title')).toBe(false);
  });

  it('says in place that the organization set it when asked to explain', async () => {
    responses['get_integration_access'] = async () =>
      view({ global_read_only: true, global_locked: true });
    await create('example-plugin', true);

    expect(el('integration-access-reason')?.textContent).toContain('Set by your organization');
  });

  it('shows no reason and no hint while the control is editable', async () => {
    await create('slack', true);

    expect(el('integration-access-reason')).toBeNull();
    expect(button('integration-access-full').hasAttribute('title')).toBe(false);
  });

  it('reports a rejected save in place and shows the stored mode', async () => {
    responses['set_integration_access_mode'] = async () => {
      throw new Error('unknown integration: slack');
    };
    await create();

    button('integration-access-read-only').click();
    await settle();

    expect(el('integration-access-error')?.textContent).toContain('unknown integration: slack');
    expect(invoked('restart_hub')).toHaveLength(0);
    expect(button('integration-access-full').getAttribute('aria-checked')).toBe('true');
  });

  it('reports a mode it cannot read', async () => {
    responses['get_integration_access'] = async () => {
      throw new Error('config.json is not valid JSON');
    };
    await create();

    expect(el('integration-access-error')?.textContent).toContain('config.json is not valid JSON');
    expect(el('integration-access-full')).toBeNull();
  });

  it('blocks a second change while a save is running', async () => {
    const pending = createDeferred<IntegrationAccessView>();
    responses['set_integration_access_mode'] = () => pending.promise;
    await create();

    button('integration-access-read-only').click();
    fixture.detectChanges();
    expect(button('integration-access-full').disabled).toBe(true);

    pending.resolve(view({ mode: 'read_only' }));
    await settle();
    expect(button('integration-access-full').disabled).toBe(false);
  });

  it('says what read-only blocks', async () => {
    await create();

    expect(el('integration-access-help')?.textContent).toContain('send, create, edit or delete');
  });

  it.each(['github', 'gitlab'])(
    'says that read-only also blocks git push for %s',
    async (service) => {
      await create(service);

      expect(el('integration-access-help')?.textContent).toContain('git push');
    }
  );

  it('says that read-only stops the browser for playwright', async () => {
    await create('playwright');

    expect(el('integration-access-help')?.textContent).toContain(
      'the browser does not work in this mode'
    );
    expect(el('integration-access-help')?.textContent).not.toContain('git push');
  });

  it('does not mention git push for a service without git', async () => {
    await create('slack');

    expect(el('integration-access-help')?.textContent).not.toContain('git push');
  });
});
