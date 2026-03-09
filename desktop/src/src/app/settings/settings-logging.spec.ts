import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SettingsComponent } from './settings.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { RouterModule } from '@angular/router';

describe('SettingsComponent — logging settings', () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_projects':
          return { projects: [{ name: 'test', dir: '/tmp/test' }], active_project: 'test' };
        case 'get_llm_config':
          return { provider: 'anthropic', model: null, base_url: null, api_key_env: null };
        case 'get_update_settings':
          return { auto_check: true, check_interval_hours: 24 };
        case 'get_log_level':
          return 'INFO';
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: false };
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

  describe('loadLogLevel()', () => {
    it('loads the current log level on init', async () => {
      await component.ngOnInit();
      // Allow async calls to settle
      await new Promise((r) => setTimeout(r, 50));
      expect(component.logLevel).toBe('info');
    });

    it('normalizes log level to lowercase', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'get_log_level') return 'DEBUG';
        if (cmd === 'list_projects') return { projects: [], active_project: null };
        if (cmd === 'get_llm_config')
          return { provider: 'anthropic', model: null, base_url: null, api_key_env: null };
        if (cmd === 'get_update_settings') return { auto_check: true, check_interval_hours: 24 };
        if (cmd === 'get_health')
          return {
            containers: [],
            vm: { running: false, vm_type: 'lima' },
            mcp_os: { running: false },
            ide_bridge: { running: false, port: null, ws_url: null, detected_ides: [] },
            overall_healthy: false,
          };
        if (cmd === 'get_bridge_status') return null;
        return undefined;
      };
      await component.ngOnInit();
      await new Promise((r) => setTimeout(r, 50));
      expect(component.logLevel).toBe('debug');
    });
  });

  describe('setLogLevel()', () => {
    it('calls set_log_level with the selected level', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.setLogLevel('debug');
      expect(invokeSpy).toHaveBeenCalledWith('set_log_level', { level: 'debug' });
    });

    it('updates logLevel property', async () => {
      await component.setLogLevel('trace');
      expect(component.logLevel).toBe('trace');
    });

    it('sets error on failure', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_log_level') throw new Error('invalid level');
        return undefined;
      };
      await component.setLogLevel('bad');
      expect(component.error).toBe('invalid level');
    });
  });

  describe('exportDiagnostics()', () => {
    it('calls export_diagnostics with active project', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'export_diagnostics') return '/Users/user/Downloads/speedwave-diagnostics.zip';
        return undefined;
      };
      await component.exportDiagnostics();
      expect(invokeSpy).toHaveBeenCalledWith('export_diagnostics', { project: 'test' });
      expect(component.diagnosticsPath).toBe('/Users/user/Downloads/speedwave-diagnostics.zip');
    });

    it('sets diagnosticsExporting during export', async () => {
      component.activeProject = 'test';
      let resolveFn!: (v: string) => void;
      mockTauri.invokeHandler = (cmd: string) =>
        new Promise<string>((resolve) => {
          if (cmd === 'export_diagnostics') resolveFn = resolve;
          else resolve('');
        });
      const promise = component.exportDiagnostics();
      expect(component.diagnosticsExporting).toBe(true);
      resolveFn('/tmp/test.zip');
      await promise;
      expect(component.diagnosticsExporting).toBe(false);
    });

    it('does nothing without activeProject', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.activeProject = null;
      await component.exportDiagnostics();
      expect(invokeSpy).not.toHaveBeenCalledWith('export_diagnostics', expect.anything());
    });

    it('sets error on failure', async () => {
      component.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'export_diagnostics') throw new Error('zip failed');
        return undefined;
      };
      await component.exportDiagnostics();
      expect(component.error).toBe('zip failed');
      expect(component.diagnosticsExporting).toBe(false);
    });
  });
});
