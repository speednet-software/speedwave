import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpdateSectionComponent } from './update-section.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

describe('UpdateSectionComponent', () => {
  let component: UpdateSectionComponent;
  let fixture: ComponentFixture<UpdateSectionComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_update_settings':
          return { auto_check: true, check_interval_hours: 24 };
        case 'set_update_settings':
          return undefined;
        case 'check_for_update':
          return null;
        case 'get_platform':
          return 'macos';
        default:
          return undefined;
      }
    };

    await TestBed.configureTestingModule({
      imports: [UpdateSectionComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(UpdateSectionComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('loads version on init', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    expect(component.currentVersion).toBe('1.0.0');
  });

  describe('toggleAutoCheck()', () => {
    it('flips updateAutoCheck from true to false', async () => {
      component.updateAutoCheck = true;
      await component.toggleAutoCheck();
      expect(component.updateAutoCheck).toBe(false);
    });

    it('flips updateAutoCheck from false to true', async () => {
      component.updateAutoCheck = false;
      await component.toggleAutoCheck();
      expect(component.updateAutoCheck).toBe(true);
    });

    it('awaits saveUpdateSettings (invokes set_update_settings)', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.updateAutoCheck = true;
      await component.toggleAutoCheck();
      expect(invokeSpy).toHaveBeenCalledWith('set_update_settings', {
        settings: { auto_check: false, check_interval_hours: component.updateIntervalHours },
      });
    });
  });

  describe('setCheckInterval()', () => {
    it('updates updateIntervalHours to the given value', async () => {
      component.updateIntervalHours = 24;
      await component.setCheckInterval(168);
      expect(component.updateIntervalHours).toBe(168);
    });

    it('awaits saveUpdateSettings (invokes set_update_settings)', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.updateAutoCheck = true;
      await component.setCheckInterval(12);
      expect(invokeSpy).toHaveBeenCalledWith('set_update_settings', {
        settings: { auto_check: true, check_interval_hours: 12 },
      });
    });
  });

  describe('installUpdate()', () => {
    it('calls install_update with expectedVersion and restart_app with force', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      component.updateAvailableVersion = '2.0.0';
      component.updateResult = 'available';
      await component.installUpdate();
      expect(invokeSpy).toHaveBeenCalledWith('install_update', { expectedVersion: '2.0.0' });
      expect(invokeSpy).toHaveBeenCalledWith('restart_app', { force: true });
    });

    it('sets updateInstalling to true during install', async () => {
      let resolveFn!: () => void;
      mockTauri.invokeHandler = (cmd: string) =>
        new Promise<void>((resolve) => {
          if (cmd === 'install_update') resolveFn = resolve;
          else resolve();
        });
      component.updateAvailableVersion = '2.0.0';
      const promise = component.installUpdate();
      expect(component.updateInstalling).toBe(true);
      resolveFn();
      await promise;
      expect(component.updateInstalling).toBe(false);
    });

    it('sets updateInstallError on failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update') throw new Error('download failed');
        return undefined;
      };
      component.updateAvailableVersion = '2.0.0';
      await component.installUpdate();
      expect(component.updateInstallError).toBe('download failed');
      expect(component.updateInstalling).toBe(false);
    });

    it('does nothing without updateAvailableVersion', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.updateAvailableVersion = '';
      await component.installUpdate();
      expect(invokeSpy).not.toHaveBeenCalledWith('install_update', expect.anything());
    });

    it('does not call restart_app if install_update fails', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update') throw new Error('network error');
        return undefined;
      };
      component.updateAvailableVersion = '2.0.0';
      await component.installUpdate();
      expect(invokeSpy).not.toHaveBeenCalledWith('restart_app', expect.anything());
    });

    it('clears previous error before starting install', async () => {
      vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      component.updateAvailableVersion = '2.0.0';
      component.updateInstallError = 'old error';
      await component.installUpdate();
      expect(component.updateInstallError).toBe('');
    });
  });

  describe('checkForUpdate()', () => {
    it('sets updateResult to available when update found', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_for_update') return { version: '3.0.0', body: null, date: null };
        return undefined;
      };
      await component.checkForUpdate();
      expect(component.updateResult).toBe('available');
      expect(component.updateAvailableVersion).toBe('3.0.0');
    });

    it('sets updateResult to up-to-date when no update', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_for_update') return null;
        return undefined;
      };
      await component.checkForUpdate();
      expect(component.updateResult).toBe('up-to-date');
    });

    it('sets error on failure and emits errorOccurred', async () => {
      const errorSpy = vi.fn();
      component.errorOccurred.subscribe(errorSpy);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_for_update') throw new Error('network failed');
        return undefined;
      };
      await component.checkForUpdate();
      expect(component.error).toBe('network failed');
      expect(errorSpy).toHaveBeenCalledWith('network failed');
    });

    it('sets updateChecking during check', async () => {
      let resolveFn!: () => void;
      mockTauri.invokeHandler = (cmd: string) =>
        new Promise<void>((resolve) => {
          if (cmd === 'check_for_update') resolveFn = resolve;
          else resolve();
        });
      const promise = component.checkForUpdate();
      expect(component.updateChecking).toBe(true);
      resolveFn();
      await promise;
      expect(component.updateChecking).toBe(false);
    });
  });

  describe('isLinux platform detection', () => {
    it('defaults to false', () => {
      expect(component.isLinux).toBe(false);
    });

    it('is set to true when platform is linux', async () => {
      const linuxMock = new MockTauriService();
      linuxMock.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'get_platform':
            return 'linux';
          case 'get_update_settings':
            return { auto_check: true, check_interval_hours: 24 };
          default:
            return undefined;
        }
      };

      await TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [UpdateSectionComponent],
        providers: [{ provide: TauriService, useValue: linuxMock }],
      }).compileComponents();

      const linuxFixture = TestBed.createComponent(UpdateSectionComponent);
      const linuxComponent = linuxFixture.componentInstance;
      linuxComponent.ngOnInit();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(linuxComponent.isLinux).toBe(true);
    });
  });

  describe('openReleasesPage()', () => {
    it('invokes open_url with GitHub Releases URL', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      await component.openReleasesPage();
      expect(invokeSpy).toHaveBeenCalledWith('open_url', {
        url: 'https://github.com/speednet-software/speedwave/releases',
      });
    });

    it('does not throw when invoke fails', async () => {
      vi.spyOn(mockTauri, 'invoke').mockRejectedValue(new Error('not in tauri'));
      await expect(component.openReleasesPage()).resolves.toBeUndefined();
    });
  });

  describe('updateContainers()', () => {
    it('calls update_containers with active project', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'update_containers')
          return { success: true, images_rebuilt: 3, containers_recreated: 2, error: null };
        return undefined;
      };
      component.activeProject = 'acme';
      await component.updateContainers();
      expect(invokeSpy).toHaveBeenCalledWith('update_containers', { project: 'acme' });
    });

    it('sets containerUpdating during update', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'update_containers')
          return { success: true, images_rebuilt: 3, containers_recreated: 2, error: null };
        return undefined;
      };
      component.activeProject = 'acme';
      const promise = component.updateContainers();
      expect(component.containerUpdating).toBe(true);
      await promise;
      expect(component.containerUpdating).toBe(false);
    });

    it('sets containerUpdateResult on success', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'update_containers')
          return { success: true, images_rebuilt: 3, containers_recreated: 2, error: null };
        return undefined;
      };
      component.activeProject = 'acme';
      await component.updateContainers();
      expect(component.containerUpdateResult).toEqual({
        success: true,
        images_rebuilt: 3,
        containers_recreated: 2,
        error: null,
      });
      expect(component.containerUpdateDone).toBe(true);
    });

    it('handles update failure and emits errorOccurred', async () => {
      const errorSpy = vi.fn();
      component.errorOccurred.subscribe(errorSpy);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'update_containers') throw new Error('pull failed');
        return undefined;
      };
      component.activeProject = 'acme';
      await component.updateContainers();
      expect(component.error).toBe('pull failed');
      expect(errorSpy).toHaveBeenCalledWith('pull failed');
      expect(component.containerUpdating).toBe(false);
    });

    it('does nothing without active project', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.activeProject = null;
      await component.updateContainers();
      expect(invokeSpy).not.toHaveBeenCalledWith('update_containers', expect.anything());
    });
  });

  describe('rollbackContainers()', () => {
    it('calls rollback_containers on rollback', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.activeProject = 'acme';
      await component.rollbackContainers();
      expect(invokeSpy).toHaveBeenCalledWith('rollback_containers', { project: 'acme' });
    });

    it('clears containerUpdateResult after rollback', async () => {
      component.activeProject = 'acme';
      component.containerUpdateDone = true;
      component.containerUpdateResult = {
        success: true,
        images_rebuilt: 3,
        containers_recreated: 2,
        error: null,
      };
      await component.rollbackContainers();
      expect(component.containerUpdateResult).toBeNull();
      expect(component.containerUpdateDone).toBe(false);
    });
  });
});
