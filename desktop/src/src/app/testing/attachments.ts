import { vi } from 'vitest';
import type { StagedAttachment } from '../models/chat';
import type { PreprocessedImage } from '../services/image-preprocessor.service';

/**
 * A staged image as the image pipeline resolves it.
 * @param filename - Name the image was attached under.
 * @param overrides - Fields to replace.
 */
export function makeStagedImage(
  filename = 'img.png',
  overrides: Partial<PreprocessedImage> = {}
): PreprocessedImage {
  return {
    attachment: {
      kind: 'image',
      filename,
      mediaType: 'image/png',
      containerPath: '/workspace/.speedwave/pastes/paste-1-0001.png',
    },
    previewUrl: `blob:${filename}`,
    width: 1,
    height: 1,
    sizeBytes: 1,
    discard: vi.fn(),
    ...overrides,
  };
}

/**
 * A staged file as the upload pipeline resolves it.
 * @param filename - Name the file was attached under.
 * @param overrides - Fields to replace.
 */
export function makeStagedFile(
  filename = 'notes.pdf',
  overrides: Partial<StagedAttachment<'file'>> = {}
): StagedAttachment<'file'> {
  return {
    attachment: {
      kind: 'file',
      filename,
      sizeBytes: 2048,
      containerPath: `/workspace/.speedwave/pastes/paste-1-0001-${filename}`,
    },
    sizeBytes: 2048,
    discard: vi.fn(),
    ...overrides,
  };
}
