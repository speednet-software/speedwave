import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpdateSectionComponent } from './update-section.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import { createDeferred } from '../../testing/deferred';

type ChannelTestAccess = { channelLabel(): string; setChannel(channel: string): Promise<void> };

function channelAccess(component: UpdateSectionComponent): ChannelTestAccess {
  return component as unknown as ChannelTestAccess;
}

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
      const pendingInstall = createDeferred();
      mockTauri.invokeHandler = (cmd: string) =>
        cmd === 'install_update_and_reconcile' ? pendingInstall.promise : Promise.resolve();
      component.updateAvailableVersion = '2.0.0';
      const promise = component.installUpdate();
      expect(component.updateInstalling).toBe(true);
      pendingInstall.resolve();
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

    it('switches to the newer version when the server changed it mid-install', async () => {
      component.updateAvailableVersion = '2.0.0';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') {
          throw new Error('Version mismatch: expected 2.0.0 but server returned 2.0.1');
        }
        if (cmd === 'check_for_update') {
          return {
            kind: 'update_available',
            version: '2.0.1',
            body: null,
            date: null,
            is_critical: false,
          };
        }
        return undefined;
      };

      await component.installUpdate();

      expect(component.updateAvailableVersion).toBe('2.0.1');
      expect(component.updateInstallError).toBe('');
      expect(component.updateInstallNotice).toBe('A newer version v2.0.1 is available');
    });

    it('passes the newer version to a subsequent install call', async () => {
      component.updateAvailableVersion = '2.0.0';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('version mismatch');
        if (cmd === 'check_for_update') {
          return {
            kind: 'update_available',
            version: '2.0.1',
            body: null,
            date: null,
            is_critical: false,
          };
        }
        return undefined;
      };
      await component.installUpdate();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => undefined;
      await component.installUpdate();

      expect(invokeSpy).toHaveBeenCalledWith('install_update_and_reconcile', {
        expectedVersion: '2.0.1',
      });
    });

    it('keeps the original error when the re-check reports the same version', async () => {
      component.updateAvailableVersion = '2.0.0';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('download failed');
        if (cmd === 'check_for_update') {
          return {
            kind: 'update_available',
            version: '2.0.0',
            body: null,
            date: null,
            is_critical: false,
          };
        }
        return undefined;
      };

      await component.installUpdate();

      expect(component.updateAvailableVersion).toBe('2.0.0');
      expect(component.updateInstallError).toBe('download failed');
      expect(component.updateInstallNotice).toBe(null);
    });

    it('keeps the original error when the re-check reports up to date', async () => {
      component.updateAvailableVersion = '2.0.0';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('download failed');
        if (cmd === 'check_for_update') return { kind: 'up_to_date' };
        return undefined;
      };

      await component.installUpdate();

      expect(component.updateInstallError).toBe('download failed');
      expect(component.updateInstallNotice).toBe(null);
    });

    it('keeps the original error when the re-check itself fails', async () => {
      component.updateAvailableVersion = '2.0.0';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('download failed');
        if (cmd === 'check_for_update') throw new Error('network failed');
        return undefined;
      };

      await component.installUpdate();

      expect(component.updateInstallError).toBe('download failed');
      expect(component.updateInstallNotice).toBe(null);
    });
  });

  describe('checkForUpdate()', () => {
    it('sets updateResult to available when update found', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_for_update')
          return {
            kind: 'update_available',
            version: '3.0.0',
            body: null,
            date: null,
            is_critical: false,
          };
        return undefined;
      };
      await component.checkForUpdate();
      expect(component.updateResult).toBe('available');
      expect(component.updateAvailableVersion).toBe('3.0.0');
    });

    it('sets updateResult to up-to-date when no update', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'check_for_update') return { kind: 'up_to_date' };
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
      const pendingCheck = createDeferred();
      mockTauri.invokeHandler = (cmd: string) =>
        cmd === 'check_for_update' ? pendingCheck.promise : Promise.resolve();
      const promise = component.checkForUpdate();
      expect(component.updateChecking).toBe(true);
      pendingCheck.resolve();
      await promise;
      expect(component.updateChecking).toBe(false);
    });
  });

  describe('update channel', () => {
    it('shows stable when the settings carry no channel field', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_update_settings') return { auto_check: true, check_interval_hours: 12 };
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(channelAccess(component).channelLabel()).toBe('stable');
    });

    it('loads the persisted channel', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_update_settings') {
          return { auto_check: true, check_interval_hours: 12, channel: 'beta' };
        }
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(channelAccess(component).channelLabel()).toBe('beta');
    });

    it('opening the section does not add a channel key when the file never had one', async () => {
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

    it('opening the section does not reset a persisted beta channel', async () => {
      const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'get_update_settings') {
          return { auto_check: false, check_interval_hours: 24, channel: 'beta' };
        }
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      const setCall = calls.find((c) => c.cmd === 'set_update_settings');
      expect(setCall?.args).toEqual({
        settings: { auto_check: true, check_interval_hours: 12, channel: 'beta' },
      });
    });

    it('switching channel saves it and triggers a check', async () => {
      const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'get_update_settings') return { auto_check: true, check_interval_hours: 12 };
        if (cmd === 'check_for_update') return { kind: 'up_to_date' };
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      calls.length = 0;

      await channelAccess(component).setChannel('beta');

      expect(channelAccess(component).channelLabel()).toBe('beta');
      const setCall = calls.find((c) => c.cmd === 'set_update_settings');
      expect(setCall?.args).toEqual({
        settings: { auto_check: true, check_interval_hours: 12, channel: 'beta' },
      });
      expect(calls.some((c) => c.cmd === 'check_for_update')).toBe(true);
    });

    it('does nothing when switching to the already-active channel', async () => {
      const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'get_update_settings') return { auto_check: true, check_interval_hours: 12 };
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      calls.length = 0;

      await channelAccess(component).setChannel('stable');

      expect(calls.some((c) => c.cmd === 'set_update_settings')).toBe(false);
      expect(calls.some((c) => c.cmd === 'check_for_update')).toBe(false);
    });

    it('is disabled while an update is installing', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_update_settings') return { auto_check: true, check_interval_hours: 12 };
        return undefined;
      };
      await component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      component.updateInstalling = true;

      const calls: string[] = [];
      mockTauri.invokeHandler = async (cmd: string) => {
        calls.push(cmd);
        return undefined;
      };
      await channelAccess(component).setChannel('beta');

      expect(channelAccess(component).channelLabel()).toBe('stable');
      expect(calls).toEqual([]);
    });
  });

  describe('channel indicator', () => {
    async function renderWith(settings: Record<string, unknown>): Promise<HTMLElement> {
      mockTauri.invokeHandler = async (cmd: string) =>
        cmd === 'get_update_settings' ? settings : undefined;
      fixture.detectChanges();
      await new Promise<void>((r) => setTimeout(r, 0));
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    }

    function channelButton(root: HTMLElement, channel: string): HTMLButtonElement {
      const button = root.querySelector<HTMLButtonElement>(
        `[data-testid="settings-channel-${channel}"]`
      );
      if (!button) throw new Error(`missing ${channel} button`);
      return button;
    }

    it('marks stable as the selected channel when the settings carry no channel field', async () => {
      const root = await renderWith({ auto_check: true, check_interval_hours: 12 });

      expect(channelButton(root, 'stable').classList).toContain('active');
      expect(channelButton(root, 'stable').getAttribute('aria-pressed')).toBe('true');
      expect(channelButton(root, 'beta').classList).not.toContain('active');
      expect(channelButton(root, 'beta').getAttribute('aria-pressed')).toBe('false');
    });

    it('marks beta as the selected channel when it is persisted', async () => {
      const root = await renderWith({
        auto_check: true,
        check_interval_hours: 12,
        channel: 'beta',
      });

      expect(channelButton(root, 'beta').classList).toContain('active');
      expect(channelButton(root, 'beta').getAttribute('aria-pressed')).toBe('true');
      expect(channelButton(root, 'stable').classList).not.toContain('active');
      expect(channelButton(root, 'stable').getAttribute('aria-pressed')).toBe('false');
    });

    it('moves the indicator to the clicked channel', async () => {
      const root = await renderWith({ auto_check: true, check_interval_hours: 12 });

      channelButton(root, 'beta').click();
      await new Promise<void>((r) => setTimeout(r, 0));
      fixture.detectChanges();

      expect(channelButton(root, 'beta').classList).toContain('active');
      expect(channelButton(root, 'stable').classList).not.toContain('active');
    });
  });
});
