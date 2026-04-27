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

  describe('auto-check defaults (no UI)', () => {
    // The toggle + frequency dropdown were removed — auto-check is always on
    // with a fixed 12 h interval. The component rewrites persisted settings
    // on init when they drift from those defaults.
    it('rewrites backend settings when persisted state has auto_check=false', async () => {
      const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'get_update_settings') return { auto_check: false, check_interval_hours: 24 };
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      const setCall = calls.find((c) => c.cmd === 'set_update_settings');
      expect(setCall?.args).toEqual({
        settings: { auto_check: true, check_interval_hours: 12 },
      });
    });

    it('rewrites backend settings when interval drifts from 12 h', async () => {
      const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'get_update_settings') return { auto_check: true, check_interval_hours: 168 };
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      const setCall = calls.find((c) => c.cmd === 'set_update_settings');
      expect(setCall?.args).toEqual({
        settings: { auto_check: true, check_interval_hours: 12 },
      });
    });

    it('does not rewrite when persisted state already matches the defaults', async () => {
      const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'get_update_settings') return { auto_check: true, check_interval_hours: 12 };
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      const setCall = calls.find((c) => c.cmd === 'set_update_settings');
      expect(setCall).toBeUndefined();
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
      expect(invokeSpy).not.toHaveBeenCalledWith('install_update_and_reconcile', expect.anything());
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
});
