import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterModule } from '@angular/router';
import { CommandPaletteComponent } from './command-palette.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { ThemeService } from '../../services/theme.service';
import { UiStateService } from '../../services/ui-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

describe('CommandPaletteComponent', () => {
  let component: CommandPaletteComponent;
  let fixture: ComponentFixture<CommandPaletteComponent>;
  let mockTauri: MockTauriService;
  let ui: UiStateService;
  let theme: ThemeService;
  let projectState: ProjectStateService;
  let router: Router;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_projects')
        return {
          projects: [
            { name: 'speedwave', dir: '/tmp/sw' },
            { name: 'speedwave-plugins', dir: '/tmp/sw-plugins' },
            { name: 'experiments', dir: '/tmp/exp' },
          ],
          active_project: 'speedwave',
        };
      return undefined;
    };

    await TestBed.configureTestingModule({
      imports: [
        CommandPaletteComponent,
        RouterModule.forRoot([
          { path: 'chat', component: CommandPaletteComponent },
          { path: 'integrations', component: CommandPaletteComponent },
          { path: 'plugins', component: CommandPaletteComponent },
          { path: 'settings', component: CommandPaletteComponent },
          { path: 'logs', component: CommandPaletteComponent },
        ]),
      ],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(CommandPaletteComponent);
    component = fixture.componentInstance;
    ui = TestBed.inject(UiStateService);
    theme = TestBed.inject(ThemeService);
    projectState = TestBed.inject(ProjectStateService);
    router = TestBed.inject(Router);
    ui.closePalette();
    fixture.detectChanges();
  });

  describe('visibility binding', () => {
    it('renders nothing when paletteOpen() is false', () => {
      expect(fixture.nativeElement.querySelector('[data-testid="command-palette"]')).toBeNull();
    });

    it('renders the modal when paletteOpen() is true', () => {
      ui.togglePalette();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="command-palette"]')).not.toBeNull();
    });

    it('clicking the backdrop closes the palette', () => {
      ui.togglePalette();
      fixture.detectChanges();
      const backdrop = fixture.nativeElement.querySelector(
        '[data-testid="command-palette-backdrop"]'
      ) as HTMLDivElement;
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      expect(ui.paletteOpen()).toBe(false);
    });

    it('clicking inside the modal does NOT close the palette', () => {
      ui.togglePalette();
      fixture.detectChanges();
      const inner = fixture.nativeElement.querySelector(
        '[data-testid="command-palette"]'
      ) as HTMLElement;
      inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Backdrop click handler ignores clicks where target !== currentTarget.
      expect(ui.paletteOpen()).toBe(true);
    });
  });

  describe('items + sections', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      ui.togglePalette();
      fixture.detectChanges();
    });

    it('renders the navigate section header and 5 routes', () => {
      const section = fixture.nativeElement.querySelector(
        '[data-testid="palette-section-navigate"]'
      );
      expect(section).not.toBeNull();
      expect(section.textContent).toContain('navigate');
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-nav-chat"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-nav-integrations"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-nav-plugins"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-nav-settings"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-nav-logs"]')
      ).not.toBeNull();
    });

    it('renders the actions section with 6 actions', () => {
      const section = fixture.nativeElement.querySelector(
        '[data-testid="palette-section-actions"]'
      );
      expect(section).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-action-new-conversation"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-action-install-plugin"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector(
          '[data-testid="palette-item-action-restart-containers"]'
        )
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-action-check-updates"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-action-toggle-sidebar"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-action-change-accent"]')
      ).not.toBeNull();
    });

    it('renders dynamic projects section excluding the active project', () => {
      const section = fixture.nativeElement.querySelector(
        '[data-testid="palette-section-projects"]'
      );
      expect(section).not.toBeNull();
      // Active project ("speedwave") should be excluded.
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-project-speedwave"]')
      ).toBeNull();
      expect(
        fixture.nativeElement.querySelector(
          '[data-testid="palette-item-project-speedwave-plugins"]'
        )
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-project-experiments"]')
      ).not.toBeNull();
    });

    it('renders the navigation hint footer', () => {
      const root = fixture.nativeElement.querySelector('[data-testid="command-palette"]');
      expect(root.textContent).toContain('navigate');
      expect(root.textContent).toContain('select');
      expect(root.textContent).toContain('close');
    });
  });

  describe('filter', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      ui.togglePalette();
      fixture.detectChanges();
    });

    it('narrows the visible items by case-insensitive substring', () => {
      const input = fixture.nativeElement.querySelector(
        '[data-testid="palette-input"]'
      ) as HTMLInputElement;
      input.value = 'SETT';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      // Only the settings nav row should remain (label: "go to settings").
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-nav-settings"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-nav-chat"]')
      ).toBeNull();
    });

    it('shows the empty placeholder when nothing matches', () => {
      const input = fixture.nativeElement.querySelector(
        '[data-testid="palette-input"]'
      ) as HTMLInputElement;
      input.value = 'zzznosuchthing';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="palette-empty"]')).not.toBeNull();
    });

    it('resets the highlight index on filter change', () => {
      // Move the highlight forward, then narrow the list.
      component.setHighlight(4);
      const input = fixture.nativeElement.querySelector(
        '[data-testid="palette-input"]'
      ) as HTMLInputElement;
      input.value = 'sett';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(component.highlightedIndex()).toBe(0);
    });
  });

  describe('keyboard navigation', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      ui.togglePalette();
      fixture.detectChanges();
    });

    it('arrow down advances the highlight index', () => {
      const start = component.highlightedIndex();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(component.highlightedIndex()).toBe(start + 1);
    });

    it('arrow up wraps to the last item from index 0', () => {
      component.setHighlight(0);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      expect(component.highlightedIndex()).toBe(component.filteredItems().length - 1);
    });

    it('enter invokes the highlighted item', async () => {
      // Highlight "go to settings" (index 3 in the navigate section).
      component.setHighlight(3);
      const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await fixture.whenStable();
      expect(navSpy).toHaveBeenCalledWith('/settings');
      navSpy.mockRestore();
    });

    it('arrow keys are no-ops when the palette is closed', () => {
      ui.closePalette();
      fixture.detectChanges();
      component.setHighlight(0);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      // Still 0 — handler short-circuits when paletteOpen() is false.
      expect(component.highlightedIndex()).toBe(0);
    });
  });

  describe('actions', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      ui.togglePalette();
      fixture.detectChanges();
    });

    it('clicking a nav item routes to the target URL and closes the palette', async () => {
      const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="palette-item-nav-integrations"]'
      ) as HTMLButtonElement;
      btn.click();
      await fixture.whenStable();
      expect(navSpy).toHaveBeenCalledWith('/integrations');
      expect(ui.paletteOpen()).toBe(false);
      navSpy.mockRestore();
    });

    it('clicking "change accent color" cycles ThemeService', async () => {
      const before = theme.theme();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="palette-item-action-change-accent"]'
      ) as HTMLButtonElement;
      btn.click();
      await fixture.whenStable();
      expect(theme.theme()).not.toBe(before);
    });

    it('clicking "restart containers" requests a restart', async () => {
      const spy = vi.spyOn(projectState, 'requestRestart');
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="palette-item-action-restart-containers"]'
      ) as HTMLButtonElement;
      btn.click();
      await fixture.whenStable();
      expect(spy).toHaveBeenCalled();
      expect(ui.paletteOpen()).toBe(false);
      spy.mockRestore();
    });

    it('clicking "toggle sidebar" toggles UiState', async () => {
      const before = ui.sidebarOpen();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="palette-item-action-toggle-sidebar"]'
      ) as HTMLButtonElement;
      btn.click();
      await fixture.whenStable();
      expect(ui.sidebarOpen()).toBe(!before);
    });

    it('clicking a project row calls projectState.switchProject', async () => {
      const spy = vi.spyOn(projectState, 'switchProject').mockResolvedValue();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="palette-item-project-experiments"]'
      ) as HTMLButtonElement;
      btn.click();
      await fixture.whenStable();
      expect(spy).toHaveBeenCalledWith('experiments');
      expect(ui.paletteOpen()).toBe(false);
      spy.mockRestore();
    });
  });

  describe('lifecycle', () => {
    it('cleans up the project settled listener on destroy', async () => {
      await component.ngOnInit();
      expect(
        (component as unknown as { unsubProjectSettled: unknown })['unsubProjectSettled']
      ).not.toBeNull();
      component.ngOnDestroy();
      expect(
        (component as unknown as { unsubProjectSettled: unknown })['unsubProjectSettled']
      ).toBeNull();
    });

    it('refreshes the project list on project_switch_succeeded events', async () => {
      await projectState.init();
      await component.ngOnInit();

      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_projects')
          return {
            projects: [
              { name: 'alpha', dir: '/tmp/alpha' },
              { name: 'beta', dir: '/tmp/beta' },
            ],
            active_project: 'alpha',
          };
        return undefined;
      };

      mockTauri.dispatchEvent('project_switch_succeeded', { project: 'alpha' });
      await fixture.whenStable();

      ui.togglePalette();
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('[data-testid="palette-item-project-beta"]')
      ).not.toBeNull();
    });
  });
});
