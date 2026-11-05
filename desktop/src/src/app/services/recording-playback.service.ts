import { Injectable, InjectionToken, inject, signal } from '@angular/core';

import type { TranscriptSource } from '../models/transcript';
import { TauriService } from './tauri.service';

/** A span of a recording to play: one transcript line, or a sample of one speaker. */
export interface PlaybackRequest {
  sessionId: string;
  key: string;
  startSecs: number;
  endSecs: number;
  source: TranscriptSource | null;
  speaker: number | null;
}

type PlaybackState = 'loading' | 'playing' | 'paused';

/** The span that plays or waits paused, with its state. */
export interface Playback extends PlaybackRequest {
  state: PlaybackState;
}

/** The browser pieces playback needs, swapped for fakes in tests. */
export interface AudioOutput {
  createAudio(): HTMLAudioElement;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

/** The {@link AudioOutput} of the running webview. */
export const AUDIO_OUTPUT = new InjectionToken<AudioOutput>('AUDIO_OUTPUT', {
  providedIn: 'root',
  factory: () => ({
    createAudio: () => new Audio(),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
  }),
});

/**
 * Plays spans of a recording through one audio element, one span at a time: a new span stops the
 * one before it, and the blob URL of a span is revoked as soon as it stops playing.
 */
@Injectable({ providedIn: 'root' })
export class RecordingPlaybackService {
  readonly current = signal<Playback | null>(null);
  readonly position = signal(0);
  readonly duration = signal(0);

  private readonly tauri = inject(TauriService);
  private readonly output = inject(AUDIO_OUTPUT);
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private generation = 0;

  /**
   * Plays the span, or pauses and resumes it when it is the one already playing.
   * @param request - the span to play.
   */
  async toggle(request: PlaybackRequest): Promise<void> {
    const now = this.current();
    if (now && now.sessionId === request.sessionId && now.key === request.key) {
      if (now.state === 'playing') this.pause();
      else if (now.state === 'paused') await this.resume();
      return;
    }
    await this.play(request);
  }

  /**
   * Stops whatever plays and plays the span from its start. Rejects with the backend's message
   * when the span cannot be read; nothing plays then.
   * @param request - the span to play.
   */
  async play(request: PlaybackRequest): Promise<void> {
    this.release();
    const generation = ++this.generation;
    this.current.set({ ...request, state: 'loading' });
    let bytes: ArrayBuffer;
    try {
      bytes = await this.tauri.invoke<ArrayBuffer>('transcript_audio_clip', {
        sessionId: request.sessionId,
        startSecs: request.startSecs,
        endSecs: request.endSecs,
        source: request.source,
      });
    } catch (e) {
      if (generation === this.generation) this.current.set(null);
      throw new Error(String(e), { cause: e });
    }
    if (generation !== this.generation) return;
    const audio = this.element();
    this.url = this.output.createUrl(new Blob([bytes], { type: 'audio/wav' }));
    audio.src = this.url;
    audio.currentTime = 0;
    try {
      await audio.play();
    } catch (e) {
      if (generation !== this.generation) return;
      this.stop();
      throw new Error(`The recording could not be played: ${String(e)}`, { cause: e });
    }
    if (generation === this.generation) this.setState('playing');
  }

  /** Pauses the playing span; the bar stays until {@link stop}. */
  pause(): void {
    if (this.current()?.state !== 'playing') return;
    this.audio?.pause();
    this.setState('paused');
  }

  /** Resumes the paused span, from its start when it had played to its end. */
  async resume(): Promise<void> {
    const audio = this.audio;
    if (this.current()?.state !== 'paused' || !audio) return;
    if (audio.ended) audio.currentTime = 0;
    await this.playCurrent(audio);
  }

  /** Plays the current span again from its start. */
  async replay(): Promise<void> {
    const audio = this.audio;
    if (!audio || !this.current() || this.current()?.state === 'loading') return;
    audio.currentTime = 0;
    this.position.set(0);
    await this.playCurrent(audio);
  }

  /** Stops playback and forgets the span. */
  stop(): void {
    this.generation++;
    this.release();
    this.current.set(null);
  }

  /**
   * Seconds of the session's recording that can be played from its start; 0 when it is gone.
   * @param sessionId - the session to ask about.
   */
  playableSecs(sessionId: string): Promise<number> {
    return this.tauri.invoke<number>('transcript_playable_secs', { sessionId });
  }

  private async playCurrent(audio: HTMLAudioElement): Promise<void> {
    const generation = this.generation;
    try {
      await audio.play();
    } catch (e) {
      if (generation !== this.generation) return;
      throw e;
    }
    if (generation === this.generation) this.setState('playing');
  }

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = this.output.createAudio();
    audio.addEventListener('timeupdate', () => this.position.set(audio.currentTime));
    audio.addEventListener('loadedmetadata', () =>
      this.duration.set(Number.isFinite(audio.duration) ? audio.duration : 0)
    );
    audio.addEventListener('ended', () => this.setState('paused'));
    this.audio = audio;
    return audio;
  }

  private setState(state: PlaybackState): void {
    const now = this.current();
    if (now) this.current.set({ ...now, state });
  }

  private release(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
    }
    if (this.url) {
      this.output.revokeUrl(this.url);
      this.url = null;
    }
    this.position.set(0);
    this.duration.set(0);
  }
}
