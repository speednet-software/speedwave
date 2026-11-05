import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { createDeferred } from '../testing/deferred';
import {
  AUDIO_OUTPUT,
  RecordingPlaybackService,
  type AudioOutput,
  type PlaybackRequest,
} from './recording-playback.service';

class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  ended = false;
  play = vi.fn(async () => {
    this.ended = false;
  });
  pause = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
  });

  finish(): void {
    this.ended = true;
    this.dispatchEvent(new Event('ended'));
  }
}

const line = (key: string, overrides: Partial<PlaybackRequest> = {}): PlaybackRequest => ({
  sessionId: 'sess-1',
  key,
  startSecs: 3,
  endSecs: 5.5,
  source: 'system',
  speaker: 2,
  ...overrides,
});

describe('RecordingPlaybackService', () => {
  let svc: RecordingPlaybackService;
  let tauri: MockTauriService;
  let audio: FakeAudio;
  let output: AudioOutput & { created: Blob[]; revoked: string[] };

  beforeEach(() => {
    tauri = new MockTauriService();
    tauri.invokeHandler = async () => new Uint8Array([1, 2, 3]).buffer;
    audio = new FakeAudio();
    let n = 0;
    output = {
      created: [],
      revoked: [],
      createAudio: () => audio as unknown as HTMLAudioElement,
      createUrl(blob) {
        this.created.push(blob);
        return `blob:clip-${++n}`;
      },
      revokeUrl(url) {
        this.revoked.push(url);
      },
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: AUDIO_OUTPUT, useValue: output },
      ],
    });
    svc = TestBed.inject(RecordingPlaybackService);
  });

  it('asks the backend for the span and plays its WAV from the start', async () => {
    const calls: [string, unknown][] = [];
    tauri.invokeHandler = async (cmd, args) => {
      calls.push([cmd, args]);
      return new Uint8Array([1, 2, 3]).buffer;
    };
    audio.currentTime = 9;

    await svc.play(line('line:0'));

    expect(calls).toEqual([
      [
        'transcript_audio_clip',
        { sessionId: 'sess-1', startSecs: 3, endSecs: 5.5, source: 'system' },
      ],
    ]);
    expect(output.created[0].type).toBe('audio/wav');
    expect(output.created[0].size).toBe(3);
    expect(audio.src).toBe('blob:clip-1');
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(svc.current()).toMatchObject({ key: 'line:0', state: 'playing', speaker: 2 });
  });

  it('shows the span as loading until the backend answers', async () => {
    const answer = createDeferred<ArrayBuffer>();
    tauri.invokeHandler = () => answer.promise;

    const playing = svc.play(line('line:0'));
    expect(svc.current()?.state).toBe('loading');
    answer.resolve(new Uint8Array([1]).buffer);
    await playing;

    expect(svc.current()?.state).toBe('playing');
  });

  it('a second toggle on the playing span pauses it and a third resumes it', async () => {
    await svc.toggle(line('line:0'));
    await svc.toggle(line('line:0'));

    expect(audio.pause).toHaveBeenCalled();
    expect(svc.current()?.state).toBe('paused');

    await svc.toggle(line('line:0'));

    expect(svc.current()?.state).toBe('playing');
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('a toggle on another span stops the first and revokes its URL', async () => {
    await svc.toggle(line('line:0'));
    await svc.toggle(line('line:1', { startSecs: 8, endSecs: 9 }));

    expect(output.revoked).toEqual(['blob:clip-1']);
    expect(audio.src).toBe('blob:clip-2');
    expect(svc.current()).toMatchObject({ key: 'line:1', state: 'playing' });
  });

  it('a span of another session with the same key is a new span, not a pause', async () => {
    await svc.toggle(line('line:0'));
    await svc.toggle(line('line:0', { sessionId: 'sess-2' }));

    expect(svc.current()).toMatchObject({ sessionId: 'sess-2', state: 'playing' });
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('an answer for a span the user already left is dropped', async () => {
    const first = createDeferred<ArrayBuffer>();
    const answers = [first.promise, Promise.resolve(new Uint8Array([7]).buffer)];
    tauri.invokeHandler = () => answers.shift() as Promise<unknown>;

    const slow = svc.play(line('line:0'));
    await svc.play(line('line:1'));
    first.resolve(new Uint8Array([1]).buffer);
    await slow;

    expect(svc.current()?.key).toBe('line:1');
    expect(output.created).toHaveLength(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('a span the backend cannot read rejects with its message and leaves nothing playing', async () => {
    tauri.invokeHandler = async () => {
      throw "Recording file not found. It was moved or deleted, so lines can't be played.";
    };

    await expect(svc.play(line('line:0'))).rejects.toThrow('Recording file not found');

    expect(svc.current()).toBeNull();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('a clip the webview cannot play stops and rejects', async () => {
    audio.play.mockRejectedValueOnce(new Error('NotSupportedError'));

    await expect(svc.play(line('line:0'))).rejects.toThrow('could not be played');

    expect(svc.current()).toBeNull();
    expect(output.revoked).toEqual(['blob:clip-1']);
  });

  it('a span that played to its end stays paused and plays again from its start', async () => {
    await svc.play(line('line:0'));
    audio.currentTime = 2.5;
    audio.finish();

    expect(svc.current()?.state).toBe('paused');

    await svc.toggle(line('line:0'));

    expect(audio.currentTime).toBe(0);
    expect(svc.current()?.state).toBe('playing');
  });

  it('replay starts the span over from its start', async () => {
    await svc.play(line('line:0'));
    audio.currentTime = 1.2;
    svc.pause();

    await svc.replay();

    expect(audio.currentTime).toBe(0);
    expect(svc.position()).toBe(0);
    expect(svc.current()?.state).toBe('playing');
  });

  it('follows the position and the length of the span', async () => {
    await svc.play(line('line:0'));
    audio.duration = 2.75;
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.currentTime = 1.5;
    audio.dispatchEvent(new Event('timeupdate'));

    expect(svc.duration()).toBe(2.75);
    expect(svc.position()).toBe(1.5);
  });

  it('stop forgets the span, revokes its URL and drops an answer still on its way', async () => {
    await svc.play(line('line:0'));
    svc.stop();

    expect(svc.current()).toBeNull();
    expect(audio.pause).toHaveBeenCalled();
    expect(output.revoked).toEqual(['blob:clip-1']);

    const late = createDeferred<ArrayBuffer>();
    tauri.invokeHandler = () => late.promise;
    const pending = svc.play(line('line:1'));
    svc.stop();
    late.resolve(new Uint8Array([1]).buffer);
    await pending;

    expect(svc.current()).toBeNull();
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('a play the next span interrupted is no error', async () => {
    const first = createDeferred<void>();
    audio.play.mockImplementationOnce(() => first.promise);

    const interrupted = svc.play(line('line:0'));
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    await svc.play(line('line:1'));
    first.reject(new DOMException('interrupted by a new load request', 'AbortError'));

    await expect(interrupted).resolves.toBeUndefined();
    expect(svc.current()).toMatchObject({ key: 'line:1', state: 'playing' });
  });

  it('a resume the next span interrupted is no error', async () => {
    await svc.play(line('line:0'));
    svc.pause();
    const resumed = createDeferred<void>();
    audio.play.mockImplementationOnce(() => resumed.promise);

    const resuming = svc.resume();
    await svc.play(line('line:1'));
    resumed.reject(new DOMException('interrupted', 'AbortError'));

    await expect(resuming).resolves.toBeUndefined();
    expect(svc.current()).toMatchObject({ key: 'line:1', state: 'playing' });
  });

  it('a resume the webview refuses rejects and keeps the span paused', async () => {
    await svc.play(line('line:0'));
    svc.pause();
    audio.play.mockRejectedValueOnce(new Error('NotAllowedError'));

    await expect(svc.resume()).rejects.toThrow('NotAllowedError');
    expect(svc.current()?.state).toBe('paused');
  });

  it('pause, resume and replay do nothing while nothing plays', async () => {
    svc.pause();
    await svc.resume();
    await svc.replay();

    expect(svc.current()).toBeNull();
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('playableSecs asks the backend by session id', async () => {
    tauri.invokeHandler = async (cmd, args) => {
      expect(cmd).toBe('transcript_playable_secs');
      expect(args).toEqual({ sessionId: 'sess-1' });
      return 312.5;
    };

    expect(await svc.playableSecs('sess-1')).toBe(312.5);
  });
});
