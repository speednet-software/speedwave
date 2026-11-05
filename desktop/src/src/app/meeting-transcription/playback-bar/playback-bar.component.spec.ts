import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PlaybackBarComponent, type PlaybackSpeaker } from './playback-bar.component';
import { RecordingPlaybackService, type Playback } from '../../services/recording-playback.service';
import { BetaService } from '../../services/beta.service';

class FakePlayback {
  current = signal<Playback | null>(null);
  position = signal(0);
  duration = signal(0);
  toggle = vi.fn(async () => undefined);
  replay = vi.fn(async () => undefined);
  stop = vi.fn(() => this.current.set(null));
}

const playing = (overrides: Partial<Playback> = {}): Playback => ({
  sessionId: 'sess-1',
  key: 'line:4',
  startSecs: 65.2,
  endSecs: 71.9,
  source: 'system',
  speaker: 2,
  state: 'playing',
  ...overrides,
});

const speaker2: PlaybackSpeaker = {
  label: 'Speaker 2',
  speaker: { id: 2, color: '#123456', mark: null },
};

describe('PlaybackBarComponent', () => {
  let fixture: ComponentFixture<PlaybackBarComponent>;
  let playback: FakePlayback;
  let named: { id: number; trigger: HTMLElement | null }[];
  let failures: string[];
  const betaEnabled = signal(false);

  const q = (id: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`);

  beforeEach(async () => {
    playback = new FakePlayback();
    betaEnabled.set(false);
    await TestBed.configureTestingModule({
      imports: [PlaybackBarComponent],
      providers: [
        { provide: RecordingPlaybackService, useValue: playback },
        { provide: BetaService, useValue: { enabled: betaEnabled.asReadonly() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PlaybackBarComponent);
    named = [];
    failures = [];
    fixture.componentInstance.name.subscribe((r) => named.push(r));
    fixture.componentInstance.failed.subscribe((m) => failures.push(m));
  });

  function render(who: PlaybackSpeaker | null = speaker2, nameable = true) {
    fixture.componentRef.setInput('who', who);
    fixture.componentRef.setInput('nameable', nameable);
    fixture.detectChanges();
  }

  it('draws nothing while nothing plays', () => {
    render();
    expect(q('playback-bar')).toBeNull();
  });

  it('shows who speaks and the span of the recording that plays', () => {
    playback.current.set(playing());
    render();

    expect(q('playback-bar')?.getAttribute('role')).toBe('region');
    expect(q('playback-what')?.textContent).toContain('Speaker 2');
    expect(q('playback-what')?.textContent).toContain('01:05–01:11');
    expect(q('playback-what')?.querySelector('app-speaker-mark')).not.toBeNull();
  });

  it('labels the toggle Pause while it plays and Play while it waits', () => {
    playback.current.set(playing());
    render();
    expect(q('playback-toggle')?.getAttribute('aria-label')).toBe('Pause');

    playback.current.set(playing({ state: 'paused' }));
    fixture.detectChanges();
    expect(q('playback-toggle')?.getAttribute('aria-label')).toBe('Play');
  });

  it('disables the toggle and replay while the span loads', () => {
    playback.current.set(playing({ state: 'loading' }));
    render();

    expect((q('playback-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect((q('playback-replay') as HTMLButtonElement).disabled).toBe(true);
  });

  it('toggles the playing span, replays it and stops it', async () => {
    playback.current.set(playing());
    render();

    q('playback-toggle')?.click();
    q('playback-replay')?.click();
    await fixture.whenStable();

    expect(playback.toggle).toHaveBeenCalledWith(playing());
    expect(playback.replay).toHaveBeenCalled();

    q('playback-stop')?.click();
    fixture.detectChanges();
    expect(playback.stop).toHaveBeenCalled();
    expect(q('playback-bar')).toBeNull();
  });

  it('reports a resume or replay the webview refused', async () => {
    playback.current.set(playing({ state: 'paused' }));
    playback.toggle.mockRejectedValueOnce(new Error('The recording could not be played: x'));
    playback.replay.mockRejectedValueOnce('denied');
    render();

    q('playback-toggle')?.click();
    q('playback-replay')?.click();
    await fixture.whenStable();

    expect(failures).toEqual(['The recording could not be played: x', 'denied']);
  });

  it('shows how much of the span has played', () => {
    playback.current.set(playing());
    playback.duration.set(4);
    playback.position.set(1);
    render();

    const bar = q('playback-progress');
    expect(bar?.getAttribute('aria-valuenow')).toBe('25');
    expect((bar?.firstElementChild as HTMLElement).style.width).toBe('25%');
  });

  it('shows no progress before the span loaded', () => {
    playback.current.set(playing({ state: 'loading' }));
    playback.position.set(3);
    render();

    expect(q('playback-progress')?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('asks to name the diarized speaker with Name as the focus target', () => {
    playback.current.set(playing());
    render();

    q('playback-name')?.click();

    expect(named).toEqual([{ id: 2, trigger: q('playback-name') }]);
  });

  it('offers no Name for You, Meeting, or while names cannot be saved', () => {
    playback.current.set(playing({ speaker: null, source: 'mic' }));
    render({ label: 'You', speaker: null });
    expect(q('playback-name')).toBeNull();
    expect(q('playback-what')?.textContent).toContain('You');

    fixture.componentRef.setInput('who', speaker2);
    fixture.componentRef.setInput('nameable', false);
    fixture.detectChanges();
    expect(q('playback-name')).toBeNull();
  });

  it('keeps stop clear of the Beta badge in the corner while beta is on', () => {
    playback.current.set(playing());
    render();
    expect(q('playback-bar')?.classList).toContain('pr-8');
    expect(q('playback-bar')?.classList).not.toContain('pr-16');

    betaEnabled.set(true);
    fixture.detectChanges();

    expect(q('playback-bar')?.classList).toContain('pr-16');
    expect(q('playback-bar')?.classList).not.toContain('pr-8');
  });
});
