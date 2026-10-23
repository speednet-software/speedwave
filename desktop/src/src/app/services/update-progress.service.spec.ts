import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UpdateProgressService } from './update-progress.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { UPDATE_DOWNLOAD_PROGRESS_EVENT, UpdateDownloadProgress } from '../models/update';

const EVENT: UpdateDownloadProgress = { downloaded: 1024, total: 4096, phase: 'downloading' };

describe('UpdateProgressService', () => {
  let mockTauri: MockTauriService;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: mockTauri }],
    });
  });

  it('holds no progress before the backend reports any', () => {
    const service = TestBed.inject(UpdateProgressService);
    expect(service.progress()).toBeNull();
  });

  it('exposes the latest progress event', async () => {
    const service = TestBed.inject(UpdateProgressService);
    await Promise.resolve();

    mockTauri.dispatchEvent(UPDATE_DOWNLOAD_PROGRESS_EVENT, EVENT);
    expect(service.progress()).toEqual(EVENT);

    const later: UpdateDownloadProgress = { downloaded: 4096, total: 4096, phase: 'installing' };
    mockTauri.dispatchEvent(UPDATE_DOWNLOAD_PROGRESS_EVENT, later);
    expect(service.progress()).toEqual(later);
  });

  it('a null payload, sent when the install fails, clears the progress', async () => {
    const service = TestBed.inject(UpdateProgressService);
    await Promise.resolve();
    mockTauri.dispatchEvent(UPDATE_DOWNLOAD_PROGRESS_EVENT, EVENT);

    mockTauri.dispatchEvent(UPDATE_DOWNLOAD_PROGRESS_EVENT, null);

    expect(service.progress()).toBeNull();
  });

  it('swallows a listener that cannot be registered and then never receives events', async () => {
    let listenAttempts = 0;
    mockTauri.listen = async () => {
      listenAttempts += 1;
      throw new Error('no tauri');
    };
    const service = TestBed.inject(UpdateProgressService);
    await Promise.resolve();
    await Promise.resolve();

    expect(listenAttempts).toBe(1);
    mockTauri.dispatchEvent(UPDATE_DOWNLOAD_PROGRESS_EVENT, EVENT);
    expect(service.progress()).toBeNull();
  });
});
