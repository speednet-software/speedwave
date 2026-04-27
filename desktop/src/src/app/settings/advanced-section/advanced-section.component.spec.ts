import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AdvancedSectionComponent } from './advanced-section.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

describe('AdvancedSectionComponent', () => {
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

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders Diagnostics and Danger Zone sections', () => {
    fixture.detectChanges();
    const headings = fixture.nativeElement.querySelectorAll('h2') as NodeListOf<Element>;
    const texts = Array.from(headings).map((h) => h.textContent?.trim());
    expect(texts).toContain('Diagnostics');
    expect(texts).toContain('Danger Zone');
  });

  describe('forced log level on init', () => {
    // The user-facing log-level dropdown was removed — every install now
    // logs at `trace` so exported diagnostics always carry full context.
    it('invokes set_log_level("trace") when the component initialises', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(invokeSpy).toHaveBeenCalledWith('set_log_level', { level: 'trace' });
    });

    it('does not surface backend failures to the user', async () => {
      const errorSpy = vi.fn();
      component.errorOccurred.subscribe(errorSpy);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'set_log_level') throw new Error('not in tauri');
        return undefined;
      };
      component.ngOnInit();
      await new Promise<void>((r) => setTimeout(r, 0));
      // Forced log-level write is fire-and-forget — failures stay silent
      // so a missing backend doesn't block the rest of the settings page.
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('exportDiagnostics()', () => {
    it('calls export_diagnostics with active project', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      fixture.componentRef.setInput('activeProject', 'test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'export_diagnostics') return '/tmp/diag.zip';
        return undefined;
      };
      await component.exportDiagnostics();
      expect(invokeSpy).toHaveBeenCalledWith('export_diagnostics', { project: 'test' });
      expect(component.diagnosticsPath).toBe('/tmp/diag.zip');
    });

    it('sets diagnosticsExporting during export', async () => {
      fixture.componentRef.setInput('activeProject', 'test');
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
      fixture.componentRef.setInput('activeProject', null);
      await component.exportDiagnostics();
      expect(invokeSpy).not.toHaveBeenCalledWith('export_diagnostics', expect.anything());
    });

    it('emits errorOccurred on failure', async () => {
      const errorSpy = vi.fn();
      component.errorOccurred.subscribe(errorSpy);
      fixture.componentRef.setInput('activeProject', 'test');
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'export_diagnostics') throw new Error('zip failed');
        return undefined;
      };
      await component.exportDiagnostics();
      expect(errorSpy).toHaveBeenCalledWith('zip failed');
      expect(component.diagnosticsExporting).toBe(false);
    });
  });

  describe('resetEnvironment()', () => {
    it('calls factory_reset and emits resetCompleted', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const resetSpy = vi.fn();
      component.resetCompleted.subscribe(resetSpy);
      await component.resetEnvironment();
      expect(invokeSpy).toHaveBeenCalledWith('factory_reset');
      expect(resetSpy).toHaveBeenCalled();
    });

    it('sets resetting during reset', async () => {
      let resolveFn!: () => void;
      mockTauri.invokeHandler = (cmd: string) =>
        new Promise<void>((resolve) => {
          if (cmd === 'factory_reset') resolveFn = resolve;
          else resolve();
        });
      const promise = component.resetEnvironment();
      expect(component.resetting).toBe(true);
      resolveFn();
      await promise;
      expect(component.resetting).toBe(false);
      expect(component.confirmReset).toBe(false);
    });

    it('emits errorOccurred on failure', async () => {
      const errorSpy = vi.fn();
      component.errorOccurred.subscribe(errorSpy);
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'factory_reset') throw new Error('reset failed');
        return undefined;
      };
      await component.resetEnvironment();
      expect(errorSpy).toHaveBeenCalledWith('reset failed');
      expect(component.resetting).toBe(false);
    });
  });

  describe('template interaction', () => {
    it('shows confirm buttons after clicking Reset', () => {
      fixture.detectChanges();
      const resetBtn: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="settings-reset-btn"]'
      );
      expect(resetBtn).not.toBeNull();
      resetBtn.click();
      fixture.detectChanges();
      const confirmBtn = fixture.nativeElement.querySelector(
        '[data-testid="settings-confirm-reset"]'
      );
      expect(confirmBtn).not.toBeNull();
    });

    it('hides confirm buttons after clicking Cancel', () => {
      component.confirmReset = true;
      fixture.detectChanges();
      const cancelBtn: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="settings-cancel-reset"]'
      );
      cancelBtn.click();
      fixture.detectChanges();
      expect(component.confirmReset).toBe(false);
      const resetBtn = fixture.nativeElement.querySelector('[data-testid="settings-reset-btn"]');
      expect(resetBtn).not.toBeNull();
    });

    it('disables Export Diagnostics when no activeProject', () => {
      fixture.componentRef.setInput('activeProject', null);
      fixture.detectChanges();
      const btn: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="settings-export-diagnostics"]'
      );
      expect(btn.disabled).toBe(true);
    });

    it('enables Export Diagnostics when activeProject is set', () => {
      fixture.componentRef.setInput('activeProject', 'test');
      fixture.detectChanges();
      const btn: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="settings-export-diagnostics"]'
      );
      expect(btn.disabled).toBe(false);
    });
  });
});
