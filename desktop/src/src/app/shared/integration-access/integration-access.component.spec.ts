import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { IntegrationAccessComponent } from './integration-access.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { createDeferred } from '../../testing/deferred';
import type { IntegrationAccessView } from '../../models/access';

function view(overrides?: Partial<IntegrationAccessView>): IntegrationAccessView {
  return { mode: 'full', global_read_only: false, global_locked: false, ...overrides };
}

describe('IntegrationAccessComponent', () => {
  let fixture: ComponentFixture<IntegrationAccessComponent>;
  let tauri: MockTauriService;
  let projectState: {
    requestRestartFor: ReturnType<typeof vi.fn>;
  };
  let router: { navigate: ReturnType<typeof vi.fn> };
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let responses: Record<string, () => Promise<unknown>>;

  const el = (id: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
  const toggle = (): HTMLInputElement => el('integration-access-always') as HTMLInputElement;
  const flip = (on: boolean): void => {
    toggle().checked = on;
    toggle().dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };
  const invoked = (cmd: string) => calls.filter((c) => c.cmd === cmd);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };

  async function create(service = 'slack', name = ''): Promise<void> {
    fixture = TestBed.createComponent(IntegrationAccessComponent);
    fixture.componentRef.setInput('project', 'proj');
    fixture.componentRef.setInput('service', service);
    fixture.componentRef.setInput('displayName', name);
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    calls = [];
    responses = {
      get_integration_access: async () => view(),
      set_integration_access_mode: async () => view({ mode: 'read_only' }),
    };
    tauri = new MockTauriService();
    tauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      const handler = responses[cmd];
      if (!handler) throw new Error(`unexpected ${cmd}`);
      return handler();
    };
    router = { navigate: vi.fn().mockResolvedValue(true) };
    projectState = {
      requestRestartFor: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [IntegrationAccessComponent],
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: ProjectStateService, useValue: projectState },
        { provide: Router, useValue: router },
      ],
    });
  });

  it('follows the project setting by default and says the access is full', async () => {
    await create();

    expect(el('integration-access')?.textContent).toContain('Always read-only');
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(el('integration-access-status')?.textContent).toContain(
      'Currently full. Follows the project setting.'
    );
    expect(invoked('get_integration_access')[0].args).toEqual({
      project: 'proj',
      service: 'slack',
    });
  });

  it('names the integration in the accessible name of the switch', async () => {
    await create('slack', 'Slack');

    expect(toggle().getAttribute('aria-label')).toBe('Always read-only for Slack');
  });

  it('falls back to the service id when no name is given', async () => {
    await create('reminders');

    expect(toggle().getAttribute('aria-label')).toBe('Always read-only for reminders');
  });

  it('shows a stored always read-only mode', async () => {
    responses['get_integration_access'] = async () => view({ mode: 'read_only' });
    await create();

    expect(toggle().checked).toBe(true);
    expect(el('integration-access-status')?.textContent).toContain('Currently read-only.');
  });

  it('shows nothing until the stored mode arrives', async () => {
    const pending = createDeferred<IntegrationAccessView>();
    responses['get_integration_access'] = () => pending.promise;
    await create();
    expect(el('integration-access-always')).toBeNull();

    pending.resolve(view({ mode: 'read_only' }));
    await settle();
    expect(toggle().checked).toBe(true);
  });

  it('stores always read-only and asks for a restart of the project', async () => {
    await create('mail');

    flip(true);
    await settle();

    expect(invoked('set_integration_access_mode')[0].args).toEqual({
      project: 'proj',
      service: 'mail',
      mode: 'read_only',
    });
    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
    expect(toggle().checked).toBe(true);
  });

  it('stores the follow mode when the user turns the switch off', async () => {
    responses['get_integration_access'] = async () => view({ mode: 'read_only' });
    responses['set_integration_access_mode'] = async () => view();
    await create();

    flip(false);
    await settle();

    expect(invoked('set_integration_access_mode')[0].args).toMatchObject({ mode: 'full' });
    expect(toggle().checked).toBe(false);
  });

  it('keeps the switch editable and says the project setting makes it read-only', async () => {
    responses['get_integration_access'] = async () => view({ global_read_only: true });
    await create();

    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(el('integration-access-status')?.textContent).toContain(
      'Currently read-only, from the project setting in Settings.'
    );
  });

  it('opens the switch in Settings from the status link', async () => {
    responses['get_integration_access'] = async () => view({ global_read_only: true });
    await create();

    const click = new MouseEvent('click', { cancelable: true });
    el('integration-access-settings-link')?.dispatchEvent(click);

    expect(el('integration-access-settings-link')?.getAttribute('href')).toBe(
      '/settings#section-access'
    );
    expect(click.defaultPrevented).toBe(true);
    expect(router.navigate).toHaveBeenCalledWith(['/settings'], { fragment: 'section-access' });
  });

  it('names the organization and offers no link when MDM forces the project setting', async () => {
    responses['get_integration_access'] = async () =>
      view({ global_read_only: true, global_locked: true });
    await create();

    expect(el('integration-access-status')?.textContent).toContain(
      'Currently read-only, set by your organization for all integrations.'
    );
    expect(el('integration-access-settings-link')).toBeNull();
    expect(toggle().disabled).toBe(false);
  });

  it('says the integration is read-only by its own choice whatever the project setting', async () => {
    responses['get_integration_access'] = async () =>
      view({ mode: 'read_only', global_read_only: true });
    await create();

    expect(el('integration-access-status')?.textContent).toContain('Currently read-only.');
    expect(el('integration-access-settings-link')).toBeNull();
  });

  it('stores always read-only while the project setting is on', async () => {
    responses['get_integration_access'] = async () => view({ global_read_only: true });
    responses['set_integration_access_mode'] = async () =>
      view({ mode: 'read_only', global_read_only: true });
    await create();

    flip(true);
    await settle();

    expect(invoked('set_integration_access_mode')[0].args).toMatchObject({ mode: 'read_only' });
    expect(toggle().checked).toBe(true);
  });

  it('reports a rejected save in place and shows the stored mode', async () => {
    responses['set_integration_access_mode'] = async () => {
      throw new Error('unknown integration: slack');
    };
    await create();

    flip(true);
    await settle();

    expect(el('integration-access-error')?.textContent).toContain('unknown integration: slack');
    expect(projectState.requestRestartFor).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(false);
  });

  it('reports a mode it cannot read', async () => {
    responses['get_integration_access'] = async () => {
      throw new Error('config.json is not valid JSON');
    };
    await create();

    expect(el('integration-access-error')?.textContent).toContain('config.json is not valid JSON');
    expect(el('integration-access-always')).toBeNull();
  });

  it('blocks a second change while a save is running', async () => {
    const pending = createDeferred<IntegrationAccessView>();
    responses['set_integration_access_mode'] = () => pending.promise;
    await create();

    flip(true);
    expect(toggle().disabled).toBe(true);
    expect(toggle().checked).toBe(true);

    pending.resolve(view({ mode: 'read_only' }));
    await settle();
    expect(toggle().disabled).toBe(false);
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
