import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, RouterModule, UrlTree } from '@angular/router';

import { transcriptionRouteGuard } from './transcription-route.guard';
import { TauriService } from '../services/tauri.service';
import { TranscriptionService } from '../services/transcription.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('transcriptionRouteGuard', () => {
  let mockTauri: MockTauriService;
  let router: Router;
  const recording = signal(false);

  beforeEach(async () => {
    recording.set(false);
    mockTauri = new MockTauriService();

    await TestBed.configureTestingModule({
      imports: [RouterModule.forRoot([])],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: TranscriptionService, useValue: { recording: recording.asReadonly() } },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
  });

  function activate(): Promise<boolean | UrlTree> | boolean | UrlTree {
    return TestBed.runInInjectionContext(() =>
      transcriptionRouteGuard({} as never, {} as never)
    ) as Promise<boolean | UrlTree> | boolean | UrlTree;
  }

  it('allows access when beta is enabled', async () => {
    mockTauri.invokeHandler = async () => true;
    expect(await activate()).toBe(true);
  });

  it('allows access during a recording with beta disabled', async () => {
    mockTauri.invokeHandler = async () => false;
    recording.set(true);
    expect(await activate()).toBe(true);
  });

  it('redirects to /chat when beta is disabled and nothing is recording', async () => {
    mockTauri.invokeHandler = async () => false;
    const result = await activate();
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/chat');
  });

  it('allows access during a recording even when the beta probe throws', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('not running in tauri');
    };
    recording.set(true);
    expect(await activate()).toBe(true);
  });
});
