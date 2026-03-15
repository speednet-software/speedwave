import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AdvancedSectionComponent } from './advanced-section/advanced-section.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('AdvancedSectionComponent — logging settings', () => {
  let component: AdvancedSectionComponent;
  let fixture: ComponentFixture<AdvancedSectionComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async () => undefined;

    await TestBed.configureTestingModule({
      imports: [AdvancedSectionComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(AdvancedSectionComponent);
    component = fixture.componentInstance;
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

    it('emits errorOccurred on failure', async () => {
      const errorSpy = vi.fn();
      component.errorOccurred.subscribe(errorSpy);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_log_level') throw new Error('invalid level');
        return undefined;
      };
      await component.setLogLevel('bad');
      expect(errorSpy).toHaveBeenCalledWith('invalid level');
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

    it('emits errorOccurred on failure', async () => {
      const errorSpy = vi.fn();
      component.errorOccurred.subscribe(errorSpy);
      component.activeProject = 'test';
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'export_diagnostics') throw new Error('zip failed');
        return undefined;
      };
      await component.exportDiagnostics();
      expect(errorSpy).toHaveBeenCalledWith('zip failed');
      expect(component.diagnosticsExporting).toBe(false);
    });
  });
});
