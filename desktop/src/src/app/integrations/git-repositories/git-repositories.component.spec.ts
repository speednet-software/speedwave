import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GitRepositoriesComponent } from './git-repositories.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { LoggerService } from '../../services/logger.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { makeMockLogger } from '../../testing/mock-logger';
import { createDeferred } from '../../testing/deferred';
import type { GitForgeService, GitRepositoriesView } from '../../models/integration';

function view(overrides?: Partial<GitRepositoriesView>): GitRepositoriesView {
  return { host: 'https://github.com', repositories: [], suggestions: [], ...overrides };
}

describe('GitRepositoriesComponent', () => {
  let fixture: ComponentFixture<GitRepositoriesComponent>;
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
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };
  const click = async (id: string): Promise<void> => {
    (el(id) as HTMLElement).click();
    await settle();
  };
  const type = async (value: string): Promise<void> => {
    const input = el('git-repositories-input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const invoked = (cmd: string) => calls.filter((c) => c.cmd === cmd);

  async function create(enabled = true, service: GitForgeService = 'github'): Promise<void> {
    fixture = TestBed.createComponent(GitRepositoriesComponent);
    fixture.componentRef.setInput('project', 'proj');
    fixture.componentRef.setInput('service', service);
    fixture.componentRef.setInput('enabled', enabled);
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    calls = [];
    responses = {
      get_git_repositories: async () => view(),
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
      imports: [GitRepositoriesComponent],
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: LoggerService, useValue: logger },
        { provide: ProjectStateService, useValue: projectState },
      ],
    });
  });

  it('loads and renders the list and the suggestions', async () => {
    responses['get_git_repositories'] = async () =>
      view({
        repositories: ['acme/api'],
        suggestions: [
          { entry: 'acme/web', source_dir: 'web' },
          { entry: 'acme/root', source_dir: '.' },
        ],
      });
    await create();
    expect(invoked('get_git_repositories')[0].args).toEqual({ project: 'proj', service: 'github' });
    expect(el('git-repositories-row-acme/api')).not.toBeNull();
    expect(el('git-repositories-suggestion-dir-acme/web')?.textContent).toContain('web');
    expect(el('git-repositories-suggestion-dir-acme/root')?.textContent).toContain('project root');
    expect(el('git-repositories-empty-notice')).toBeNull();
  });

  it('hides the suggestions block when there are none', async () => {
    await create();
    expect(el('git-repositories-suggestions')).toBeNull();
  });

  it('shows the empty-list notice only when enabled and empty', async () => {
    await create(true);
    expect(el('git-repositories-empty-notice')).not.toBeNull();
  });

  it('does not show the empty-list notice while the integration is disabled', async () => {
    await create(false);
    expect(el('git-repositories-empty-notice')).toBeNull();
  });

  it('adds the trimmed entry, renders the returned list and restarts the proxy', async () => {
    responses['add_git_repository'] = async () => view({ repositories: ['acme/api'] });
    await create();
    await type('  acme/api  ');
    await click('git-repositories-add');
    expect(invoked('add_git_repository')[0].args).toEqual({
      project: 'proj',
      service: 'github',
      entry: 'acme/api',
    });
    expect(el('git-repositories-row-acme/api')).not.toBeNull();
    expect((el('git-repositories-input') as HTMLInputElement).value).toBe('');
    expect(invoked('restart_llm_proxy')[0].args).toEqual({ project: 'proj' });
    expect(projectState.requestRestartFor).not.toHaveBeenCalled();
  });

  it('does not touch the proxy while the integration is disabled', async () => {
    responses['add_git_repository'] = async () => view({ repositories: ['acme/api'] });
    await create(false);
    await type('acme/api');
    await click('git-repositories-add');
    expect(invoked('add_git_repository')).toHaveLength(1);
    expect(invoked('restart_llm_proxy')).toHaveLength(0);
    expect(projectState.requestRestartFor).not.toHaveBeenCalled();
  });

  it('shows the error of a rejected add and keeps the input', async () => {
    responses['add_git_repository'] = async () => {
      throw 'A bare * is not allowed';
    };
    await create();
    await type('*');
    await click('git-repositories-add');
    expect(el('git-repositories-error')?.textContent).toContain('A bare * is not allowed');
    expect((el('git-repositories-input') as HTMLInputElement).value).toBe('*');
    expect(invoked('restart_llm_proxy')).toHaveLength(0);
  });

  it('adds with Enter in the field', async () => {
    responses['add_git_repository'] = async () => view({ repositories: ['acme/api'] });
    await create();
    await type('acme/api');
    el('git-repositories-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    expect(invoked('add_git_repository')).toHaveLength(1);
  });

  it('sends the entry of a suggestion', async () => {
    responses['get_git_repositories'] = async () =>
      view({ suggestions: [{ entry: 'acme/web', source_dir: 'web' }] });
    responses['add_git_repository'] = async () => view({ repositories: ['acme/web'] });
    await create();
    await click('git-repositories-suggestion-add-acme/web');
    expect(invoked('add_git_repository')[0].args).toEqual({
      project: 'proj',
      service: 'github',
      entry: 'acme/web',
    });
    expect(el('git-repositories-suggestions')).toBeNull();
  });

  it('removes an entry and restarts the proxy', async () => {
    responses['get_git_repositories'] = async () => view({ repositories: ['acme/api'] });
    responses['remove_git_repository'] = async () => view();
    await create();
    await click('git-repositories-remove-acme/api');
    expect(invoked('remove_git_repository')[0].args).toEqual({
      project: 'proj',
      service: 'github',
      entry: 'acme/api',
    });
    expect(el('git-repositories-row-acme/api')).toBeNull();
    expect(invoked('restart_llm_proxy')).toHaveLength(1);
  });

  it('falls back to requestRestartFor when restart_llm_proxy fails', async () => {
    responses['add_git_repository'] = async () => view({ repositories: ['acme/api'] });
    responses['restart_llm_proxy'] = async () => {
      throw new Error('proxy down');
    };
    await create();
    await type('acme/api');
    await click('git-repositories-add');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('proxy down'));
    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
  });

  it('requests a restart without hot-reload when the project is not settled', async () => {
    projectState.isSettledOn.mockReturnValue(false);
    responses['add_git_repository'] = async () => view({ repositories: ['acme/api'] });
    await create();
    await type('acme/api');
    await click('git-repositories-add');
    expect(invoked('restart_llm_proxy')).toHaveLength(0);
    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
  });

  it('requests a restart without hot-reload when the project is not ready', async () => {
    projectState.status.mockReturnValue('starting');
    responses['add_git_repository'] = async () => view({ repositories: ['acme/api'] });
    await create();
    await type('acme/api');
    await click('git-repositories-add');
    expect(invoked('restart_llm_proxy')).toHaveLength(0);
    expect(projectState.requestRestartFor).toHaveBeenCalledWith('proj');
  });

  it('disables Add and explains when the host is unusable', async () => {
    responses['get_git_repositories'] = async () => view({ host: null });
    await create(true, 'gitlab');
    expect(el('git-repositories-host-unusable')).not.toBeNull();
    expect(el('git-repositories-empty-notice')).toBeNull();
    expect((el('git-repositories-add') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables the controls while a write is in flight', async () => {
    const pending = createDeferred<GitRepositoriesView>();
    responses['add_git_repository'] = () => pending.promise;
    await create();
    await type('acme/api');
    (el('git-repositories-add') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect((el('git-repositories-add') as HTMLButtonElement).disabled).toBe(true);
    expect((el('git-repositories-input') as HTMLInputElement).disabled).toBe(true);
    pending.resolve(view({ repositories: ['acme/api'] }));
    await settle();
    expect((el('git-repositories-add') as HTMLButtonElement).disabled).toBe(false);
  });

  it('drops a load response for a project that is no longer shown', async () => {
    const first = createDeferred<GitRepositoriesView>();
    let n = 0;
    responses['get_git_repositories'] = () =>
      ++n === 1 ? first.promise : Promise.resolve(view({ repositories: ['b/repo'] }));
    fixture = TestBed.createComponent(GitRepositoriesComponent);
    fixture.componentRef.setInput('project', 'a');
    fixture.componentRef.setInput('service', 'github');
    fixture.componentRef.setInput('enabled', true);
    fixture.detectChanges();
    fixture.componentRef.setInput('project', 'b');
    fixture.detectChanges();
    await fixture.whenStable();
    first.resolve(view({ repositories: ['a/repo'] }));
    await settle();
    expect(el('git-repositories-row-b/repo')).not.toBeNull();
    expect(el('git-repositories-row-a/repo')).toBeNull();
  });
});
