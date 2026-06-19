import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionListComponent } from './session-list.component';
import { TranscriptionService } from '../../services/transcription.service';
import type { TranscriptSession } from '../../models/transcript';

function session(id: string, createdAt: string, audioKept: boolean): TranscriptSession {
  return {
    id,
    created_at: createdAt,
    language: 'pl',
    audio_source: { source: { kind: 'system_wide' }, label: 'System', app_id: null },
    status: { state: 'done' },
    live_segments: [],
    final_segments: null,
    audio_path: audioKept ? `/t/${id}/audio.wav` : null,
    models_used: {
      live: null,
      finalize: null,
    },
    last_seq: 0,
  } as TranscriptSession;
}

describe('SessionListComponent', () => {
  let component: SessionListComponent;
  let fixture: ComponentFixture<SessionListComponent>;
  let svc: {
    list: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    discardAudio: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    svc = {
      list: vi.fn(async () => [
        session('a', '2026-05-10T00:00:00Z', true),
        session('b', '2026-05-12T00:00:00Z', false),
      ]),
      delete: vi.fn(async () => undefined),
      discardAudio: vi.fn(async () => undefined),
    };
    await TestBed.configureTestingModule({
      imports: [SessionListComponent],
      providers: [{ provide: TranscriptionService, useValue: svc }],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionListComponent);
    component = fixture.componentInstance;
  });

  it('lists sessions newest-first', async () => {
    await component.ngOnInit();
    expect(component.sessions().map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('emits the opened session and highlights it', async () => {
    await component.ngOnInit();
    const spy = vi.fn();
    component.opened.subscribe(spy);
    const s = component.sessions()[0];
    component.open(s);
    expect(spy).toHaveBeenCalledWith(s);
    expect(component.selectedId()).toBe(s.id);
  });

  it('deletes a session and clears the highlight if it was selected', async () => {
    await component.ngOnInit();
    component.markSelected('a');
    await component.remove('a');
    expect(svc.delete).toHaveBeenCalledWith('a');
    expect(component.selectedId()).toBeNull();
    expect(svc.list).toHaveBeenCalledTimes(2); // refreshed
  });

  it("discards a session's audio and refreshes", async () => {
    await component.ngOnInit();
    await component.discardAudio('a');
    expect(svc.discardAudio).toHaveBeenCalledWith('a');
    expect(svc.list).toHaveBeenCalledTimes(2);
  });

  it('shows audio-kept vs audio-discarded labels', async () => {
    await component.ngOnInit();
    fixture.detectChanges();
    const body: string = fixture.nativeElement.textContent ?? '';
    expect(body).toContain('audio kept');
    expect(body).toContain('audio discarded');
  });

  it('surfaces a backend error', async () => {
    svc.list.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.fn();
    component.errorOccurred.subscribe(errSpy);
    await component.ngOnInit();
    expect(component.error()).toBe('boom');
    expect(errSpy).toHaveBeenCalledWith('boom');
  });
});
