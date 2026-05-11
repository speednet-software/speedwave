import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranscriptionSectionComponent } from './transcription-section.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

describe('TranscriptionSectionComponent', () => {
  let component: TranscriptionSectionComponent;
  let fixture: ComponentFixture<TranscriptionSectionComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async () => false;

    await TestBed.configureTestingModule({
      imports: [TranscriptionSectionComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        provideRouter([{ path: '**', children: [] }]),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TranscriptionSectionComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows the privacy disclaimer text', () => {
    fixture.detectChanges();
    const body: string = fixture.nativeElement.textContent ?? '';
    expect(body).toContain('record system audio');
    expect(body).toContain('runs locally');
    expect(body).toContain('use the network');
  });

  describe('ngOnInit()', () => {
    it('reads the toggle from the backend', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      mockTauri.invokeHandler = async () => true;
      await component.ngOnInit();
      expect(invokeSpy).toHaveBeenCalledWith('transcription_enabled');
      expect(component.enabled()).toBe(true);
    });

    it('falls back to false and emits the error when the backend fails', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('boom');
      };
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.ngOnInit();
      expect(component.enabled()).toBe(false);
      expect(errSpy).toHaveBeenCalledWith('boom');
    });
  });

  describe('toggle()', () => {
    it('flips OFF→ON and persists via set_transcription_enabled', async () => {
      mockTauri.invokeHandler = async () => false;
      await component.ngOnInit();
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.toggle();
      expect(invokeSpy).toHaveBeenCalledWith('set_transcription_enabled', { enabled: true });
      expect(component.enabled()).toBe(true);
    });

    it('flips ON→OFF', async () => {
      mockTauri.invokeHandler = async () => true;
      await component.ngOnInit();
      await component.toggle();
      expect(component.enabled()).toBe(false);
    });

    it('emits errors instead of swallowing them', async () => {
      mockTauri.invokeHandler = async () => false;
      await component.ngOnInit();
      mockTauri.invokeHandler = async () => {
        throw new Error('write failed');
      };
      const errSpy = vi.fn();
      component.errorOccurred.subscribe(errSpy);
      await component.toggle();
      expect(errSpy).toHaveBeenCalledWith('write failed');
      expect(component.enabled()).toBe(false); // unchanged on failure
    });

    it('ignores re-entrant clicks while a save is in flight', async () => {
      mockTauri.invokeHandler = async () => false;
      await component.ngOnInit();
      component.busy.set(true);
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      await component.toggle();
      expect(invokeSpy).not.toHaveBeenCalled();
    });
  });
});
