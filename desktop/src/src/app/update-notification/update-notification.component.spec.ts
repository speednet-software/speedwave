import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpdateNotificationComponent } from './update-notification.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { createDeferred } from '../testing/deferred';

describe('UpdateNotificationComponent', () => {
  let component: UpdateNotificationComponent;
  let fixture: ComponentFixture<UpdateNotificationComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_platform':
          return 'macos';
        case 'check_for_update':
          return { kind: 'up_to_date' };
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'check_containers_running':
          return false;
        default:
          return undefined;
      }
    };

    await TestBed.configureTestingModule({
      imports: [UpdateNotificationComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(UpdateNotificationComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  describe('dismiss()', () => {
    it('sets dismissed to true', () => {
      component.dismissed = false;
      component.dismiss();
      expect(component.dismissed).toBe(true);
    });

    it('resets confirmUpdate to false', () => {
      component.confirmUpdate = true;
      component.dismiss();
      expect(component.confirmUpdate).toBe(false);
    });
  });

  describe('installAndRestart()', () => {
    it('sets installing to true while invoking', async () => {
      component.updateInfo = { version: '1.0.0', body: null, date: null, is_critical: false };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const pendingInstall = createDeferred();
      mockTauri.invokeHandler = (cmd: string) =>
        cmd === 'install_update_and_reconcile' ? pendingInstall.promise : Promise.resolve();

      const promise = component.installAndRestart();
      expect(component.installing).toBe(true);
      pendingInstall.resolve();
      await promise;
      expect(invokeSpy).toHaveBeenCalledWith('install_update_and_reconcile', {
        expectedVersion: '1.0.0',
      });
      expect(component.installing).toBe(false);
    });

    it('clears error before invoking the update flow', async () => {
      component.updateInfo = { version: '1.0.0', body: null, date: null, is_critical: false };
      component.error = 'previous error';
      mockTauri.invokeHandler = async () => undefined;

      await component.installAndRestart();

      expect(component.error).toBe('');
    });

    it('sets error and resets confirmUpdate on failure', async () => {
      component.updateInfo = { version: '1.0.0', body: null, date: null, is_critical: false };
      component.confirmUpdate = true;
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('install failed');
        return null;
      };

      await component.installAndRestart();

      expect(component.installing).toBe(false);
      expect(component.error).toBe('install failed');
      expect(component.confirmUpdate).toBe(false);
    });

    it('passes expectedVersion to install_update_and_reconcile', async () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => undefined;
      await component.installAndRestart();
      expect(invokeSpy).toHaveBeenCalledWith('install_update_and_reconcile', {
        expectedVersion: '1.2.3',
      });
    });

    it('switches to the newer version when the server changed it mid-install', async () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') {
          throw new Error('Version mismatch: expected 1.2.3 but server returned 1.2.4');
        }
        if (cmd === 'check_for_update') {
          return {
            kind: 'update_available',
            version: '1.2.4',
            body: null,
            date: null,
            is_critical: false,
          };
        }
        return undefined;
      };

      await component.installAndRestart();

      expect(component.updateInfo?.version).toBe('1.2.4');
      expect(component.confirmUpdate).toBe(false);
      expect(component.error).toBe('');
      expect(component.newerVersionNotice).toBe('A newer version v1.2.4 is available');
    });

    it('passes the newer version to a subsequent Confirm Update', async () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('version mismatch');
        if (cmd === 'check_for_update') {
          return {
            kind: 'update_available',
            version: '1.2.4',
            body: null,
            date: null,
            is_critical: false,
          };
        }
        return undefined;
      };
      await component.installAndRestart();

      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => undefined;
      await component.installAndRestart();

      expect(invokeSpy).toHaveBeenCalledWith('install_update_and_reconcile', {
        expectedVersion: '1.2.4',
      });
    });

    it('keeps the original error when the re-check reports the same version', async () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('install failed');
        if (cmd === 'check_for_update') {
          return {
            kind: 'update_available',
            version: '1.2.3',
            body: null,
            date: null,
            is_critical: false,
          };
        }
        return undefined;
      };

      await component.installAndRestart();

      expect(component.updateInfo?.version).toBe('1.2.3');
      expect(component.error).toBe('install failed');
      expect(component.newerVersionNotice).toBe('');
    });

    it('keeps the original error when the re-check reports up to date', async () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('install failed');
        if (cmd === 'check_for_update') return { kind: 'up_to_date' };
        return undefined;
      };

      await component.installAndRestart();

      expect(component.error).toBe('install failed');
      expect(component.newerVersionNotice).toBe('');
    });

    it('keeps the original error when the re-check itself fails', async () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') throw new Error('install failed');
        if (cmd === 'check_for_update') throw new Error('network failed');
        return undefined;
      };

      await component.installAndRestart();

      expect(component.error).toBe('install failed');
      expect(component.newerVersionNotice).toBe('');
    });
  });

  describe('setupListeners() via the update_available event', () => {
    it('keeps the failing install error and does not flip confirmUpdate when the listener repeats the same version mid-install', async () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      component.confirmUpdate = true;
      const pendingInstall = createDeferred();
      mockTauri.invokeHandler = (cmd: string) => {
        if (cmd === 'install_update_and_reconcile') return pendingInstall.promise;
        if (cmd === 'check_for_update') return Promise.resolve({ kind: 'up_to_date' });
        return Promise.resolve(undefined);
      };

      const installPromise = component.installAndRestart();

      mockTauri.dispatchEvent('update_available', {
        version: '1.2.3',
        body: null,
        date: null,
        is_critical: false,
      });

      expect(component.confirmUpdate).toBe(true);
      expect(component.dismissed).toBe(false);

      pendingInstall.reject(new Error('install failed'));
      await installPromise;

      expect(component.error).toBe('install failed');
    });

    it('clears the notice and un-dismisses when the listener reports a different version while idle', () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      component.installing = false;
      component.dismissed = true;
      component.newerVersionNotice = 'A newer version v1.2.4 is available';
      component.error = 'stale error';
      component.confirmUpdate = true;

      mockTauri.dispatchEvent('update_available', {
        version: '1.3.0',
        body: null,
        date: null,
        is_critical: false,
      });

      expect(component.updateInfo?.version).toBe('1.3.0');
      expect(component.dismissed).toBe(false);
      expect(component.error).toBe('');
      expect(component.confirmUpdate).toBe(false);
      expect(component.newerVersionNotice).toBe('');
    });

    it('stays dismissed when the listener repeats the same version after Later', () => {
      component.updateInfo = { version: '1.2.3', body: null, date: null, is_critical: false };
      component.dismiss();

      mockTauri.dispatchEvent('update_available', {
        version: '1.2.3',
        body: null,
        date: null,
        is_critical: false,
      });

      expect(component.dismissed).toBe(true);
    });
  });
});
