import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpdateSectionComponent } from './update-section/update-section.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('UpdateSectionComponent — update settings (compat)', () => {
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
    it('calls install_update_and_reconcile with expectedVersion', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      component.updateAvailableVersion = '2.0.0';
      component.updateResult = 'available';
      await component.installUpdate();
      expect(invokeSpy).toHaveBeenCalledWith('install_update_and_reconcile', {
        expectedVersion: '2.0.0',
      });
    });

    it('sets updateInstalling to true during install', async () => {
      let resolveFn!: () => void;
      mockTauri.invokeHandler = (cmd: string) =>
        new Promise<void>((resolve) => {
          if (cmd === 'install_update_and_reconcile') resolveFn = resolve;
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
        if (cmd === 'install_update_and_reconcile') throw new Error('download failed');
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
      expect(invokeSpy).not.toHaveBeenCalledWith(
        'install_update_and_reconcile',
        expect.anything(),
      );
    });

    it('does not invoke a restart command if install_update_and_reconcile fails', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('network error');
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

    it('sets error on failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_for_update') throw new Error('network failed');
        return undefined;
      };
      await component.checkForUpdate();
      expect(component.error).toBe('network failed');
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
});
