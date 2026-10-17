import { describe, it, expect, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  MAX_IMAGE_BYTES,
  NATIVE_LONG_EDGE,
  ERROR_TOO_LARGE,
  ERROR_UNSUPPORTED_TYPE,
  ImagePreprocessorService,
  isSupportedImageType,
} from './image-preprocessor.service';
import { IMAGE_MEDIA_TYPES } from '../models/chat';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { makeMockLogger } from '../testing/mock-logger';

describe('isSupportedImageType', () => {
  it('accepts every type of the image pipeline', () => {
    for (const type of IMAGE_MEDIA_TYPES) {
      expect(isSupportedImageType(type)).toBe(true);
    }
  });

  it('routes every other type to the file pipeline, image-flavoured or not', () => {
    for (const type of ['image/svg+xml', 'image/tiff', 'image/bmp', 'application/pdf', '']) {
      expect(isSupportedImageType(type)).toBe(false);
    }
  });
});

describe('NATIVE_LONG_EDGE', () => {
  it('mirrors Anthropic Vision docs (Opus 4.7 = 2576, Sonnet/Haiku = 1568)', () => {
    expect(NATIVE_LONG_EDGE.opus).toBe(2576);
    expect(NATIVE_LONG_EDGE.sonnet).toBe(1568);
    expect(NATIVE_LONG_EDGE.haiku).toBe(1568);
  });
});

describe('limit constants', () => {
  it('per-image binary cap is 3 MiB (tidy + fast file read; ADR-065)', () => {
    expect(MAX_IMAGE_BYTES).toBe(3 * 1024 * 1024);
  });
});

describe('error message constants', () => {
  it('ERROR_TOO_LARGE references the 3 MB threshold so the toast tells the user what to do', () => {
    expect(ERROR_TOO_LARGE).toContain('3 MB');
  });

  it('ERROR_UNSUPPORTED_TYPE lists the four supported formats', () => {
    expect(ERROR_UNSUPPORTED_TYPE).toMatch(/JPEG.*PNG.*GIF.*WebP/);
  });
});

describe('ImagePreprocessorService.preprocess', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves a GIF byte for byte under its original name and discards it by its paste id', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 3, height: 2, close: () => undefined }))
    );
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const tauri = new MockTauriService();
    tauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'save_pasted_image') {
        return {
          paste_id: 11,
          container_path: '/workspace/.speedwave/pastes/paste-1-0001.gif',
          filename: 'paste-1-0001.gif',
        };
      }
      return undefined;
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: LoggerService, useValue: makeMockLogger() },
      ],
    });
    const service = TestBed.inject(ImagePreprocessorService);
    const gif = new File([new Uint8Array([71, 73, 70, 56, 57, 97, 1])], 'anim.gif', {
      type: 'image/gif',
    });

    const staged = await service.preprocess(gif, 'sonnet', 'acme');
    staged.discard();

    expect(calls[0]).toEqual({
      cmd: 'save_pasted_image',
      args: { project: 'acme', mediaType: 'image/gif', bytes: [71, 73, 70, 56, 57, 97, 1] },
    });
    expect(staged.attachment).toEqual({
      kind: 'image',
      filename: 'anim.gif',
      mediaType: 'image/gif',
      containerPath: '/workspace/.speedwave/pastes/paste-1-0001.gif',
    });
    expect(staged.width).toBe(3);
    expect(staged.sizeBytes).toBe(7);
    expect(calls[1]).toEqual({ cmd: 'discard_paste', args: { pasteId: 11 } });
  });
});
