import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SettingsComponent } from './settings.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { RouterModule } from '@angular/router';

describe('SettingsComponent — container updates', () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'acme', dir: '/tmp/acme' }], active_project: 'acme' };
        case 'get_llm_config':
          return { provider: 'anthropic', model: null, base_url: null, api_key_env: null };
        case 'get_update_settings':
          return { auto_check: true, check_interval_hours: 24 };
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: false };
        case 'update_containers':
          return { success: true, images_rebuilt: 3, containers_recreated: 2, error: null };
        case 'rollback_containers':
          return undefined;
        case 'get_health':
          return {
            containers: [],
            vm: { running: false, vm_type: 'lima' },
            mcp_os: { running: false },
            ide_bridge: { running: false, port: null, ws_url: null, detected_ides: [] },
            overall_healthy: false,
          };
        case 'get_bridge_status':
          return null;
        default:
          return undefined;
      }
    };

    await TestBed.configureTestingModule({
      imports: [SettingsComponent, RouterModule.forRoot([])],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
  });

  describe('updateContainers()', () => {
    it('calls update_containers with active project', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.activeProject = 'acme';
      await component.updateContainers();
      expect(invokeSpy).toHaveBeenCalledWith('update_containers', { project: 'acme' });
    });

    it('sets containerUpdating during update', async () => {
      component.activeProject = 'acme';
      const promise = component.updateContainers();
      expect(component.containerUpdating).toBe(true);
      await promise;
      expect(component.containerUpdating).toBe(false);
    });

    it('sets containerUpdateResult on success', async () => {
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

    it('handles update failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'update_containers') throw new Error('pull failed');
        if (cmd === 'list_projects')
          return { projects: [{ name: 'acme', dir: '/tmp/acme' }], active_project: 'acme' };
        if (cmd === 'get_llm_config')
          return { provider: 'anthropic', model: null, base_url: null, api_key_env: null };
        if (cmd === 'get_update_settings') return { auto_check: true, check_interval_hours: 24 };
        if (cmd === 'get_auth_status')
          return { api_key_configured: false, oauth_authenticated: false };
        return undefined;
      };
      component.activeProject = 'acme';
      await component.updateContainers();
      expect(component.error).toBe('pull failed');
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
