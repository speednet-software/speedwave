import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';

// `@tauri-apps/plugin-dialog`'s `open` has no Tauri context in unit tests.
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { open as openOsDialog } from '@tauri-apps/plugin-dialog';

import { HostExecConfigComponent } from './host-exec-config.component';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import type { HostExecCommand, HostExecStatus } from '../../models/host-exec';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * A `host_exec` status the `get_host_exec` mock returns.
 * @param over - Fields to override on the default `{ enabled: false, commands: [] }`.
 */
function makeStatus(over?: Partial<HostExecStatus>): HostExecStatus {
  return { enabled: false, commands: [], ...over };
}

/**
 * A fresh `gradle_test` recipe each call (never share a mutable object across
 * `it`s — a stray in-place edit would leak between tests).
 */
function testRecipe(): HostExecCommand {
  return { name: 'gradle_test', exec: './gradlew', args: ['test'], confirm: 'session' };
}

describe('HostExecConfigComponent', () => {
  let fixture: ComponentFixture<HostExecConfigComponent>;
  let component: HostExecConfigComponent;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;
  let invokeCalls: { cmd: string; args?: Record<string, unknown> }[];
  /** Overridable per-command responses for the invoke mock. */
  let responses: Record<string, unknown>;

  beforeEach(async () => {
    invokeCalls = [];
    responses = {};
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      if (cmd in responses) {
        const r = responses[cmd];
        if (r instanceof Error) throw r;
        return r;
      }
      if (cmd === 'get_host_exec') return makeStatus();
      return undefined;
    };
    vi.mocked(openOsDialog).mockReset();

    await TestBed.configureTestingModule({
      imports: [HostExecConfigComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: makeMockLogger() },
      ],
    }).compileComponents();

    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'proj-a';
    fixture = TestBed.createComponent(HostExecConfigComponent);
    component = fixture.componentInstance;
  });

  /**
   * Initialises the component (awaits the async `ngOnInit`, which does the
   * `get_host_exec` load) and renders.
   * @param status - Optional status the `get_host_exec` mock should return.
   */
  async function init(status?: HostExecStatus): Promise<void> {
    if (status) responses['get_host_exec'] = status;
    await component.ngOnInit();
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const q = (sel: string) => el().querySelector(sel) as HTMLElement | null;

  // -------------------------------------------------------------------------

  it('creates and renders the card header (disabled by default)', async () => {
    await init();
    expect(component).toBeTruthy();
    expect(q('[data-testid="host-exec-config"]')).not.toBeNull();
    expect(q('[data-testid="host-exec-name"]')?.textContent).toContain('host_exec');
    expect(q('[data-testid="host-exec-badge"]')?.textContent).toContain('disabled');
    // Recipe editor is hidden while disabled.
    expect(q('[data-testid="host-exec-recipes"]')).toBeNull();
    // It pulled status from the backend.
    expect(
      invokeCalls.some((c) => c.cmd === 'get_host_exec' && c.args?.['project'] === 'proj-a')
    ).toBe(true);
  });

  it('does NOT show the Windows-unavailable banner on a non-Windows platform', async () => {
    // The default invoke mock returns undefined for `get_platform` → not Windows.
    await init();
    expect(component.isWindows).toBe(false);
    expect(q('[data-testid="host-exec-windows-unavailable"]')).toBeNull();
  });

  it('shows the Windows-unavailable banner when get_platform === "windows"', async () => {
    responses['get_platform'] = 'windows';
    await init();
    expect(component.isWindows).toBe(true);
    const banner = q('[data-testid="host-exec-windows-unavailable"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('not yet available on Windows');
  });

  it('shows the recipe editor and the whitelist when enabled', async () => {
    await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
    expect(q('[data-testid="host-exec-badge"]')?.textContent).toContain('enabled');
    expect(q('[data-testid="host-exec-recipes"]')).not.toBeNull();
    const row = q('[data-testid="host-exec-recipe-gradle_test"]');
    expect(row).not.toBeNull();
    expect(q('[data-testid="host-exec-recipe-cmd"]')?.textContent).toContain('./gradlew test');
    expect(q('[data-testid="host-exec-recipe-confirm-gradle_test"]')?.textContent?.trim()).toBe(
      'session'
    );
  });

  it('shows the empty state when enabled with no recipes', async () => {
    await init(makeStatus({ enabled: true }));
    expect(q('[data-testid="host-exec-empty"]')).not.toBeNull();
  });

  // ---- enable danger modal -------------------------------------------------

  describe('enable toggle (danger modal)', () => {
    it('clicking the toggle while disabled opens the danger modal — does NOT enable yet', async () => {
      await init();
      q('[data-testid="host-exec-toggle"]')!.click();
      fixture.detectChanges();
      expect(component.showEnableDanger).toBe(true);
      // The modal renders via app-modal-overlay (CDK dialog) — check the flag &
      // that set_host_exec_enabled was NOT called.
      expect(invokeCalls.some((c) => c.cmd === 'set_host_exec_enabled')).toBe(false);
    });

    it('cancelling the danger modal leaves host_exec disabled', async () => {
      await init();
      q('[data-testid="host-exec-toggle"]')!.click();
      fixture.detectChanges();
      component.cancelEnable();
      fixture.detectChanges();
      expect(component.showEnableDanger).toBe(false);
      expect(component.enabled).toBe(false);
      expect(invokeCalls.some((c) => c.cmd === 'set_host_exec_enabled')).toBe(false);
    });

    it('confirming the danger modal calls set_host_exec_enabled(true) and enables', async () => {
      await init();
      responses['set_host_exec_enabled'] = undefined;
      // After enabling, the component re-loads status — return enabled now.
      let reloaded = false;
      mockTauri.invokeHandler = async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        if (cmd === 'set_host_exec_enabled') {
          reloaded = true;
          return undefined;
        }
        if (cmd === 'get_host_exec') return makeStatus({ enabled: reloaded, commands: [] });
        return undefined;
      };
      q('[data-testid="host-exec-toggle"]')!.click();
      fixture.detectChanges();
      const restartSpy = vi.spyOn(projectState, 'requestRestart');
      component.confirmEnable();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.enabled).toBe(true);
      const call = invokeCalls.find((c) => c.cmd === 'set_host_exec_enabled');
      expect(call?.args).toEqual({ project: 'proj-a', enabled: true });
      expect(restartSpy).toHaveBeenCalled();
    });

    it('disabling (toggle while enabled) needs NO modal — calls set_host_exec_enabled(false)', async () => {
      await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
      mockTauri.invokeHandler = async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        if (cmd === 'get_host_exec') return makeStatus({ enabled: false });
        return undefined;
      };
      q('[data-testid="host-exec-toggle"]')!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.showEnableDanger).toBe(false);
      expect(component.enabled).toBe(false);
      expect(invokeCalls.find((c) => c.cmd === 'set_host_exec_enabled')?.args).toEqual({
        project: 'proj-a',
        enabled: false,
      });
    });

    it('surfaces a set_host_exec_enabled failure in the error banner', async () => {
      await init();
      responses['set_host_exec_enabled'] = new Error('boom');
      q('[data-testid="host-exec-toggle"]')!.click();
      fixture.detectChanges();
      component.confirmEnable();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.enabled).toBe(false);
      expect(q('[data-testid="host-exec-error"]')?.textContent).toContain('boom');
    });
  });

  // ---- recipe list edits ---------------------------------------------------

  describe('recipe list', () => {
    it('deleting a recipe removes it from the working copy and marks dirty', async () => {
      await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
      expect(component.dirty).toBe(false);
      q('[data-testid="host-exec-delete-gradle_test"]')!.click();
      fixture.detectChanges();
      expect(component.commands).toHaveLength(0);
      expect(component.dirty).toBe(true);
      // Save button enabled now.
      expect((q('[data-testid="host-exec-save"]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('discard reverts to the persisted whitelist', async () => {
      await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
      q('[data-testid="host-exec-delete-gradle_test"]')!.click();
      fixture.detectChanges();
      q('[data-testid="host-exec-revert"]')!.click();
      fixture.detectChanges();
      expect(component.commands).toHaveLength(1);
      expect(component.dirty).toBe(false);
    });

    it('save calls host_exec_save_settings with the working copy', async () => {
      await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
      const extra: HostExecCommand = {
        name: 'lint',
        exec: './gradlew',
        args: ['lint'],
        confirm: 'ask',
      };
      component.commands = [testRecipe(), extra];
      fixture.detectChanges();
      responses['host_exec_save_settings'] = undefined;
      const restartSpy = vi.spyOn(projectState, 'requestRestart');
      await component.save();
      const call = invokeCalls.find((c) => c.cmd === 'host_exec_save_settings');
      expect(call?.args).toEqual({ project: 'proj-a', commands: [testRecipe(), extra] });
      expect(restartSpy).toHaveBeenCalled();
      expect(component.dirty).toBe(false);
    });

    it('save aborts (no backend call) when the working copy fails client-side validation', async () => {
      await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
      // A bad recipe: shell-launcher exec.
      component.commands = [
        { name: 'evil', exec: 'bash', args: ['-c', 'rm -rf /'], confirm: 'ask' },
      ];
      fixture.detectChanges();
      await component.save();
      expect(invokeCalls.some((c) => c.cmd === 'host_exec_save_settings')).toBe(false);
      expect(component.error).toContain('bash');
    });

    it('surfaces a host_exec_save_settings failure and does not persist', async () => {
      await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
      component.commands = [
        testRecipe(),
        { name: 'lint', exec: './gradlew', args: ['lint'], confirm: 'ask' },
      ];
      responses['host_exec_save_settings'] = new Error('backend rejected: duplicate');
      const restartSpy = vi.spyOn(projectState, 'requestRestart');
      await component.save();
      expect(component.error).toContain('backend rejected: duplicate');
      // The save did not take: the persisted whitelist is unchanged (still one
      // recipe), and no restart was requested.
      expect(component['persisted']).toHaveLength(1);
      expect(restartSpy).not.toHaveBeenCalled();
    });
  });

  // ---- add / edit dialog ---------------------------------------------------

  describe('add / edit dialog', () => {
    it('opening "add" shows the dialog with a blank draft and no "always" option', async () => {
      await init(makeStatus({ enabled: true }));
      q('[data-testid="host-exec-add"]')!.click();
      fixture.detectChanges();
      expect(q('[data-testid="host-exec-dialog"]')).not.toBeNull();
      expect(component.draft?.editing).toBe(false);
      // The confirm <select> in add-mode must NOT contain an "always" option.
      const sel = q('[data-testid="host-exec-d-confirm"]') as HTMLSelectElement;
      const values = Array.from(sel.options).map((o) => o.value);
      expect(values).toEqual(['ask', 'session']);
    });

    it('opening "edit" pre-fills the draft and DOES offer "always"', async () => {
      await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
      q('[data-testid="host-exec-edit-gradle_test"]')!.click();
      fixture.detectChanges();
      expect(component.draft?.editing).toBe(true);
      expect(component.draft?.name).toBe('gradle_test');
      expect((q('[data-testid="host-exec-d-exec"]') as HTMLInputElement).value).toBe('./gradlew');
      const sel = q('[data-testid="host-exec-d-confirm"]') as HTMLSelectElement;
      expect(Array.from(sel.options).map((o) => o.value)).toContain('always');
    });

    it('committing a valid new recipe adds it to the working copy', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'build_app';
      component.draft!.exec = './gradlew';
      component.draft!.args = ['assemble'];
      component.commitDraft();
      fixture.detectChanges();
      expect(component.draft).toBeNull();
      expect(component.commands).toEqual([
        { name: 'build_app', exec: './gradlew', args: ['assemble'], confirm: 'ask' },
      ]);
    });

    it('rejects a non-snake_case name', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'Build-App';
      component.draft!.exec = './gradlew';
      component.commitDraft();
      expect(component.draft).not.toBeNull(); // dialog stays open
      expect(component.draftError).toContain('snake_case');
    });

    it('rejects a shell-launcher exec', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'sh_cmd';
      component.draft!.exec = '/bin/bash';
      component.draft!.args = ['-c', 'whoami'];
      component.commitDraft();
      expect(component.draftError).toContain('shell / eval launcher');
    });

    it('rejects a meta-tool exec with a bare {param} argument', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'run_anything';
      component.draft!.exec = 'npm';
      component.draft!.args = ['run', '{script}'];
      component.draft!.params = [{ name: 'script', pattern: '^[a-z:-]+$', maxLen: '' }];
      component.commitDraft();
      expect(component.draftError).toContain('bare parameter');
    });

    it('allows a meta-tool exec with a LITERAL sub-command (npm run build)', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'npm_build';
      component.draft!.exec = 'npm';
      component.draft!.args = ['run', 'build'];
      component.commitDraft();
      expect(component.draftError).toBe('');
      expect(component.commands[0].name).toBe('npm_build');
    });

    it('rejects a {token} arg with no matching parameter', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'broken';
      component.draft!.exec = './gradlew';
      component.draft!.args = ['test', '--tests={class}'];
      component.commitDraft();
      expect(component.draftError).toContain('{class}');
    });

    it('rejects a non-compiling parameter regex', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'p';
      component.draft!.exec = './x';
      component.draft!.args = ['{v}'];
      component.draft!.params = [{ name: 'v', pattern: '([unclosed', maxLen: '' }];
      component.commitDraft();
      expect(component.draftError).toContain('does not compile');
    });

    it('rejects an out-of-range parameter maxLen', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'p';
      component.draft!.exec = './x';
      component.draft!.args = ['{v}'];
      component.draft!.params = [{ name: 'v', pattern: '.*', maxLen: '99999999' }];
      component.commitDraft();
      expect(component.draftError).toContain('max length');
    });

    it('rejects an absolute cwdSub', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'p';
      component.draft!.exec = './x';
      component.draft!.cwdSub = '/etc';
      component.commitDraft();
      expect(component.draftError).toContain('relative path');
    });

    it('rejects a cwdSub with ".."', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'p';
      component.draft!.exec = './x';
      component.draft!.cwdSub = '../sibling';
      component.commitDraft();
      expect(component.draftError).toContain('".."');
    });

    it('rejects a reserved env-var key', async () => {
      await init(makeStatus({ enabled: true }));
      component.openAdd();
      component.draft!.name = 'p';
      component.draft!.exec = './x';
      component.draft!.env = [{ key: 'LD_PRELOAD', value: '/tmp/evil.so' }];
      component.commitDraft();
      expect(component.draftError).toContain('reserved');
    });

    it('rejects a duplicate recipe name vs an existing recipe', async () => {
      await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
      component.openAdd();
      component.draft!.name = 'gradle_test';
      component.draft!.exec = './gradlew';
      component.commitDraft();
      expect(component.draftError).toContain('already exists');
    });

    it('editing a recipe in place keeps its position and updates it', async () => {
      const a: HostExecCommand = { name: 'a', exec: './a', args: [], confirm: 'ask' };
      const b: HostExecCommand = { name: 'b', exec: './b', args: [], confirm: 'ask' };
      await init(makeStatus({ enabled: true, commands: [a, b] }));
      component.openEdit(a);
      component.draft!.exec = './a-renamed';
      component.commitDraft();
      expect(component.commands.map((c) => c.name)).toEqual(['a', 'b']);
      expect(component.commands[0].exec).toBe('./a-renamed');
    });

    describe('confirm: always', () => {
      it('the "always" option is disabled for a state-changing recipe in edit mode', async () => {
        const dbRecipe: HostExecCommand = {
          name: 'db_shell',
          exec: 'psql',
          args: ['-c', 'SELECT 1'],
          confirm: 'ask',
        };
        await init(makeStatus({ enabled: true, commands: [dbRecipe] }));
        q('[data-testid="host-exec-edit-db_shell"]')!.click();
        fixture.detectChanges();
        expect(component.draftIsStateChanging()).toBe(true);
        const sel = q('[data-testid="host-exec-d-confirm"]') as HTMLSelectElement;
        const alwaysOpt = Array.from(sel.options).find((o) => o.value === 'always')!;
        expect(alwaysOpt.disabled).toBe(true);
        expect(q('[data-testid="host-exec-d-statechanging-hint"]')).not.toBeNull();
      });

      it('choosing "always" opens the second warning; confirming applies it', async () => {
        await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
        component.openEdit(testRecipe());
        fixture.detectChanges();
        // Simulate the <select> change to "always".
        const sel = q('[data-testid="host-exec-d-confirm"]') as HTMLSelectElement;
        sel.value = 'always';
        sel.dispatchEvent(new Event('change'));
        fixture.detectChanges();
        expect(component.showAlwaysWarn).toBe(true);
        // The draft is NOT yet "always" until confirmed.
        expect(component.draft?.confirm).not.toBe('always');
        component.confirmAlways();
        fixture.detectChanges();
        expect(component.draft?.confirm).toBe('always');
        expect(component.showAlwaysWarn).toBe(false);
      });

      it('declining the second warning leaves confirm unchanged', async () => {
        await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
        component.openEdit(testRecipe());
        fixture.detectChanges();
        const sel = q('[data-testid="host-exec-d-confirm"]') as HTMLSelectElement;
        sel.value = 'always';
        sel.dispatchEvent(new Event('change'));
        fixture.detectChanges();
        component.cancelAlways();
        fixture.detectChanges();
        expect(component.draft?.confirm).toBe('session'); // original
        expect(component.showAlwaysWarn).toBe(false);
      });

      it('committing a recipe with confirm: always is rejected if it is state-changing', async () => {
        await init(makeStatus({ enabled: true }));
        component.openAdd();
        component.draft!.editing = true; // pretend edit so the path is reachable
        component.draft!.name = 'migrate';
        component.draft!.exec = './gradlew';
        component.draft!.args = ['flywayMigrate'];
        component.draft!.confirm = 'always';
        component.commitDraft();
        expect(component.draftError).toContain('never ask');
      });
    });

    describe('exec picker', () => {
      it('"find on PATH" calls host_exec_resolve_executable and fills the resolved path', async () => {
        await init(makeStatus({ enabled: true }));
        component.openAdd();
        component.draft!.exec = 'docker';
        responses['host_exec_resolve_executable'] = '/opt/homebrew/bin/docker';
        await component.findExecOnPath();
        expect(invokeCalls.find((c) => c.cmd === 'host_exec_resolve_executable')?.args).toEqual({
          name: 'docker',
        });
        expect(component.draft?.exec).toBe('/opt/homebrew/bin/docker');
      });

      it('"find on PATH" shows a hint when the command is not found', async () => {
        await init(makeStatus({ enabled: true }));
        component.openAdd();
        component.draft!.exec = 'nope';
        responses['host_exec_resolve_executable'] = null;
        await component.findExecOnPath();
        expect(component.execHint).toContain('not found');
        expect(component.execHintWarn).toBe(true);
      });

      it('"find on PATH" refuses a path-ish input', async () => {
        await init(makeStatus({ enabled: true }));
        component.openAdd();
        component.draft!.exec = './gradlew';
        await component.findExecOnPath();
        expect(invokeCalls.some((c) => c.cmd === 'host_exec_resolve_executable')).toBe(false);
        expect(component.execHint).toContain('bare command name');
      });

      it('"browse…" sets exec from the OS dialog result', async () => {
        await init(makeStatus({ enabled: true }));
        component.openAdd();
        vi.mocked(openOsDialog).mockResolvedValueOnce(
          '/Applications/Docker.app/Contents/Resources/bin/docker'
        );
        await component.browseExec();
        expect(component.draft?.exec).toBe(
          '/Applications/Docker.app/Contents/Resources/bin/docker'
        );
        expect(component.execHint).toContain('absolute executable path');
      });

      it('typing a shell-launcher exec shows the warning hint', async () => {
        await init(makeStatus({ enabled: true }));
        component.openAdd();
        component.draft!.exec = 'bash';
        component.recomputeExecHint();
        expect(component.execHintWarn).toBe(true);
        expect(component.execHint).toContain('shell / eval launcher');
      });
    });
  });

  // ---- confirm prompt lives in the shell, not here -------------------------

  it('does NOT subscribe to host-exec://confirm-request (the prompt is shell-level)', async () => {
    await init();
    // The per-recipe confirm prompt is `app-host-exec-confirm-prompt` in the
    // shell so it works from the chat too — this card must not listen for it.
    expect(mockTauri.listenHandlers['host-exec://confirm-request']).toBeUndefined();
    expect(q('[data-testid="host-exec-confirm"]')).toBeNull();
  });

  // ---- project switch ------------------------------------------------------

  it('reloads status when the project changes (load() reflects the new project)', async () => {
    await init(makeStatus({ enabled: true, commands: [testRecipe()] }));
    expect(component.enabled).toBe(true);
    // Simulate the onProjectSettled path: new project has host_exec disabled.
    projectState.activeProject = 'proj-b';
    responses['get_host_exec'] = makeStatus({ enabled: false });
    component['project'] = 'proj-b';
    await component.load();
    fixture.detectChanges();
    expect(component.enabled).toBe(false);
    expect(q('[data-testid="host-exec-recipes"]')).toBeNull();
  });
});
