import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpdateNotificationComponent } from './update-notification.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { BundleReconcileStatus } from '../models/update';

describe('UpdateNotificationComponent', () => {
  let component: UpdateNotificationComponent;
  let fixture: ComponentFixture<UpdateNotificationComponent>;
  let mockTauri: MockTauriService;

  const defaultBundleStatus: BundleReconcileStatus = {
    phase: 'done',
    in_progress: false,
    last_error: null,
    pending_running_projects: [],
    applied_bundle_id: null,
  };

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_platform':
          return 'macos';
        case 'get_bundle_reconcile_state':
          return defaultBundleStatus;
        case 'check_for_update':
          return null;
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
      let resolveFn!: () => void;
      mockTauri.invokeHandler = (cmd: string) =>
        new Promise<void>((resolve) => {
          if (cmd === 'install_update_and_reconcile') {
            resolveFn = resolve;
          } else {
            resolve();
          }
        });

      const promise = component.installAndRestart();
      expect(component.installing).toBe(true);
      resolveFn();
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
  });

  describe('bundle reconcile status', () => {
    it('updates bundle status from backend events', () => {
      const payload: BundleReconcileStatus = {
        phase: 'images_built',
        in_progress: true,
        last_error: null,
        pending_running_projects: ['alpha'],
        applied_bundle_id: 'prev-bundle',
      };

      mockTauri.dispatchEvent('bundle_reconcile_status', payload);

      expect(component.bundleStatus).toEqual(payload);
      expect(component.showBundleBanner).toBe(true);
      expect(component.bundleStatusMessage).toBe('Rebuilding containers');
    });

    it('calls retry_bundle_reconcile and clears the previous error', async () => {
      component.bundleStatus = {
        phase: 'images_built',
        in_progress: false,
        last_error: 'Image rebuild failed',
        pending_running_projects: ['alpha'],
        applied_bundle_id: 'prev-bundle',
      };
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);

      await component.retryBundleReconcile();

      expect(invokeSpy).toHaveBeenCalledWith('retry_bundle_reconcile');
      expect(component.bundleStatus?.last_error).toBeNull();
      expect(component.bundleStatus?.in_progress).toBe(true);
    });

    it('stores the retry error when retry_bundle_reconcile fails', async () => {
      component.bundleStatus = {
        phase: 'pending',
        in_progress: false,
        last_error: 'Previous failure',
        pending_running_projects: [],
        applied_bundle_id: null,
      };
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'retry_bundle_reconcile') throw new Error('retry failed');
        return defaultBundleStatus;
      };

      await component.retryBundleReconcile();

      expect(component.bundleStatus?.last_error).toBe('retry failed');
      expect(component.bundleStatus?.in_progress).toBe(false);
    });
  });

  describe('isLinux', () => {
    it('defaults to false', () => {
      expect(component.isLinux).toBe(false);
    });

    it('is set to true when platform is linux', async () => {
      const linuxMock = new MockTauriService();
      linuxMock.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'get_platform':
            return 'linux';
          case 'get_bundle_reconcile_state':
            return defaultBundleStatus;
          case 'check_for_update':
            return null;
          case 'list_projects':
            return { projects: [], active_project: null };
          case 'check_containers_running':
            return false;
          default:
            return undefined;
        }
      };

      await TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [UpdateNotificationComponent],
        providers: [{ provide: TauriService, useValue: linuxMock }],
      }).compileComponents();

      const linuxFixture = TestBed.createComponent(UpdateNotificationComponent);
      const linuxComponent = linuxFixture.componentInstance;
      await linuxFixture.whenStable();
      expect(linuxComponent.isLinux).toBe(true);
    });
  });

  describe('openReleasesPage()', () => {
    it('invokes open_url with GitHub Releases URL', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => undefined;
      await component.openReleasesPage();
      expect(invokeSpy).toHaveBeenCalledWith('open_url', {
        url: 'https://github.com/speednet-software/speedwave/releases',
      });
    });

    it('does not throw when invoke fails', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in Tauri');
      };
      await expect(component.openReleasesPage()).resolves.toBeUndefined();
    });
  });

  describe('isLinux', () => {
    it('defaults to false', () => {
      expect(component.isLinux).toBe(false);
    });

    it('is set to true when platform is linux', async () => {
      const linuxMock = new MockTauriService();
      linuxMock.invokeHandler = async (cmd: string) => {
        switch (cmd) {
          case 'get_platform':
            return 'linux';
          case 'check_for_update':
            return null;
          case 'list_projects':
            return { projects: [], active_project: null };
          case 'check_containers_running':
            return false;
          default:
            return undefined;
        }
      };

      await TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [UpdateNotificationComponent],
        providers: [{ provide: TauriService, useValue: linuxMock }],
      }).compileComponents();

      const linuxFixture = TestBed.createComponent(UpdateNotificationComponent);
      const linuxComponent = linuxFixture.componentInstance;
      // Wait for setupListeners to complete
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(linuxComponent.isLinux).toBe(true);
    });
  });

  describe('openReleasesPage()', () => {
    it('invokes open_url with GitHub Releases URL', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => undefined;
      await component.openReleasesPage();
      expect(invokeSpy).toHaveBeenCalledWith('open_url', {
        url: 'https://github.com/speednet-software/speedwave/releases',
      });
    });

    it('does not throw when invoke fails', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('not in Tauri');
      };
      await expect(component.openReleasesPage()).resolves.not.toThrow();
    });
  });
});
