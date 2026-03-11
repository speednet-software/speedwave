import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpdateSectionComponent } from './update-section/update-section.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('UpdateSectionComponent — container updates (compat)', () => {
  let component: UpdateSectionComponent;
  let fixture: ComponentFixture<UpdateSectionComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_update_settings':
          return { auto_check: true, check_interval_hours: 24 };
        case 'get_platform':
          return 'darwin';
        case 'update_containers':
          return { success: true, images_rebuilt: 3, containers_recreated: 2, error: null };
        case 'rollback_containers':
          return undefined;
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

  describe('hidden sections', () => {
    it('hides Container Updates by default', async () => {
      component.showAdvancedSections = false;
      component.ngOnInit();
      await fixture.whenStable();
      fixture.detectChanges();
      const headings = fixture.nativeElement.querySelectorAll('h2');
      const texts = Array.from(headings).map((h: Element) => h.textContent?.trim());
      expect(texts).not.toContain('Container Updates');
      expect(texts).toContain('Updates');
    });

    it('shows Container Updates when showAdvancedSections is true', async () => {
      component.showAdvancedSections = true;
      component.ngOnInit();
      await fixture.whenStable();
      fixture.detectChanges();
      const headings = fixture.nativeElement.querySelectorAll('h2');
      const texts = Array.from(headings).map((h: Element) => h.textContent?.trim());
      expect(texts).toContain('Container Updates');
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
