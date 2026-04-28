import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, RouterModule } from '@angular/router';
import { CommandPaletteComponent } from './command-palette.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { ThemeService } from '../../services/theme.service';
import { UiStateService } from '../../services/ui-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

/**
 * The palette renders through CDK Dialog into the document-level overlay
 * container, so tests must query the global `document` rather than the
 * fixture's native element.
 * @param selector CSS selector to look up in the document root.
 */
function q(selector: string): HTMLElement | null {
  return document.querySelector(selector) as HTMLElement | null;
}

describe('CommandPaletteComponent', () => {
  // CdkListbox calls `Element.scrollIntoView()` in `setActiveStyles()` when an
  // option is clicked — jsdom does not implement it, which surfaces as an
  // unhandled exception that pollutes the test report. Stub it for this suite.
  beforeAll(() => {
    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    if (typeof proto.scrollIntoView !== 'function') {
      proto.scrollIntoView = () => {
        // jsdom shim — intentional no-op.
      };
    }
  });

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

  afterEach(() => {
    // CDK Dialog leaves its overlay container attached to the document body.
    // Closing via the signal lets the next test start with a clean DOM.
    ui.closePalette();
    fixture.detectChanges();
  });

  describe('visibility binding', () => {
    it('renders nothing when paletteOpen() is false', () => {
      expect(q('[data-testid="command-palette"]')).toBeNull();
    });

    it('renders the modal when paletteOpen() is true', () => {
      ui.togglePalette();
      fixture.detectChanges();
      expect(q('[data-testid="command-palette"]')).not.toBeNull();
    });

    it('clicking the CDK backdrop closes the palette', () => {
      ui.togglePalette();
      fixture.detectChanges();
      const backdrop = q('.cdk-overlay-backdrop') as HTMLElement;
      expect(backdrop).not.toBeNull();
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      expect(ui.paletteOpen()).toBe(false);
    });

    it('clicking inside the modal does NOT close the palette', () => {
      ui.togglePalette();
      fixture.detectChanges();
      const inner = q('[data-testid="command-palette"]') as HTMLElement;
      inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Clicks inside the overlay panel must not bubble to the backdrop.
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
      const section = q('[data-testid="palette-section-navigate"]');
      expect(section).not.toBeNull();
      expect(section?.textContent).toContain('navigate');
      expect(q('[data-testid="palette-item-nav-chat"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-nav-integrations"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-nav-plugins"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-nav-settings"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-nav-logs"]')).not.toBeNull();
    });

    it('renders the actions section with 6 actions', () => {
      const section = q('[data-testid="palette-section-actions"]');
      expect(section).not.toBeNull();
      expect(q('[data-testid="palette-item-action-new-conversation"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-action-install-plugin"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-action-restart-containers"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-action-check-updates"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-action-toggle-sidebar"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-action-change-accent"]')).not.toBeNull();
    });

    it('renders dynamic projects section excluding the active project', () => {
      const section = q('[data-testid="palette-section-projects"]');
      expect(section).not.toBeNull();
      // Active project ("speedwave") should be excluded.
      expect(q('[data-testid="palette-item-project-speedwave"]')).toBeNull();
      expect(q('[data-testid="palette-item-project-speedwave-plugins"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-project-experiments"]')).not.toBeNull();
    });

    it('renders the navigation hint footer', () => {
      const root = q('[data-testid="command-palette"]');
      expect(root?.textContent).toContain('navigate');
      expect(root?.textContent).toContain('select');
      expect(root?.textContent).toContain('close');
    });
  });

  describe('filter', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      ui.togglePalette();
      fixture.detectChanges();
    });

    it('narrows the visible items by case-insensitive substring', () => {
      const input = q('[data-testid="palette-input"]') as HTMLInputElement;
      input.value = 'SETT';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      // Only the settings nav row should remain (label: "go to settings").
      expect(q('[data-testid="palette-item-nav-settings"]')).not.toBeNull();
      expect(q('[data-testid="palette-item-nav-chat"]')).toBeNull();
    });

    it('shows the empty placeholder when nothing matches', () => {
      const input = q('[data-testid="palette-input"]') as HTMLInputElement;
      input.value = 'zzznosuchthing';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(q('[data-testid="palette-empty"]')).not.toBeNull();
    });

    it('resets the active index on filter change', () => {
      // Move the active index forward, then narrow the list.
      component.activeIndex.set(4);
      const input = q('[data-testid="palette-input"]') as HTMLInputElement;
      input.value = 'sett';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(component.activeIndex()).toBe(0);
    });
  });

  describe('keyboard navigation', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      ui.togglePalette();
      fixture.detectChanges();
    });

    it('arrow down advances the active index', () => {
      const input = q('[data-testid="palette-input"]') as HTMLInputElement;
      const start = component.activeIndex();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(component.activeIndex()).toBe(start + 1);
    });

    it('arrow up wraps to the last item from index 0', () => {
      const input = q('[data-testid="palette-input"]') as HTMLInputElement;
      component.activeIndex.set(0);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(component.activeIndex()).toBe(component.filteredItems().length - 1);
    });

    it('enter invokes the active item', async () => {
      const input = q('[data-testid="palette-input"]') as HTMLInputElement;
      // Active "go to settings" (index 3 in the navigate section).
      component.activeIndex.set(3);
      const navSpy = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await fixture.whenStable();
      expect(navSpy).toHaveBeenCalledWith('/settings');
      navSpy.mockRestore();
    });

    it('home key moves the active index to 0', () => {
      const input = q('[data-testid="palette-input"]') as HTMLInputElement;
      component.activeIndex.set(4);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      expect(component.activeIndex()).toBe(0);
    });

    it('end key moves the active index to the last item', () => {
      const input = q('[data-testid="palette-input"]') as HTMLInputElement;
      component.activeIndex.set(0);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      expect(component.activeIndex()).toBe(component.filteredItems().length - 1);
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
      const btn = q('[data-testid="palette-item-nav-integrations"]') as HTMLElement;
      btn.click();
      await fixture.whenStable();
      expect(navSpy).toHaveBeenCalledWith('/integrations');
      expect(ui.paletteOpen()).toBe(false);
      navSpy.mockRestore();
    });

    it('clicking "change accent color" cycles ThemeService', async () => {
      const before = theme.theme();
      const btn = q('[data-testid="palette-item-action-change-accent"]') as HTMLElement;
      btn.click();
      await fixture.whenStable();
      expect(theme.theme()).not.toBe(before);
    });

    it('clicking "restart containers" requests a restart', async () => {
      const spy = vi.spyOn(projectState, 'requestRestart');
      const btn = q('[data-testid="palette-item-action-restart-containers"]') as HTMLElement;
      btn.click();
      await fixture.whenStable();
      expect(spy).toHaveBeenCalled();
      expect(ui.paletteOpen()).toBe(false);
      spy.mockRestore();
    });

    it('clicking "toggle sidebar" toggles UiState', async () => {
      const before = ui.sidebarOpen();
      const btn = q('[data-testid="palette-item-action-toggle-sidebar"]') as HTMLElement;
      btn.click();
      await fixture.whenStable();
      expect(ui.sidebarOpen()).toBe(!before);
    });

    it('clicking a project row calls projectState.switchProject', async () => {
      const spy = vi.spyOn(projectState, 'switchProject').mockResolvedValue();
      const btn = q('[data-testid="palette-item-project-experiments"]') as HTMLElement;
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

      expect(q('[data-testid="palette-item-project-beta"]')).not.toBeNull();
    });
  });
});
