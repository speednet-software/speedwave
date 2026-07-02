import { Injectable, inject } from '@angular/core';
// pica v10 ESM ships `pica` as default — namespace import from @types/pica is wrong.
import pica, { type Pica } from 'pica';
import { TauriService } from './tauri.service';
import type { ChatAttachment } from '../models/chat';

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Native long edge per model (Anthropic Vision docs). */
export const NATIVE_LONG_EDGE: Record<ModelClass, number> = {
  opus: 2576,
  sonnet: 1568,
  haiku: 1568,
};

const MAX_DIMENSION = 8000;
const PASS_THROUGH_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY = 0.92;

/** Vision-capable Anthropic model family. */
export type ModelClass = 'opus' | 'sonnet' | 'haiku';
/** MIME of a supported image attachment. */
export type SupportedMediaType = ChatAttachment['mediaType'];

const ACCEPTED_TYPES: ReadonlyArray<string> = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

export const ERROR_TOO_LARGE =
  'Image too large — shrink it before pasting (>3 MB after double reduction).';

export const ERROR_UNSUPPORTED_TYPE = 'Supported image formats: JPEG, PNG, GIF, WebP.';

/** Result of preprocessing — saved to disk and ready to ship as `ChatAttachment`. */
export interface PreprocessedImage {
  attachment: ChatAttachment;
  /** Blob URL for thumbnail; composer revokes on cleanup. */
  previewUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/** Resamples paste/drop bytes via pica and persists them through `save_pasted_image`. */
@Injectable({ providedIn: 'root' })
export class ImagePreprocessorService {
  private readonly pica: Pica = pica();
  private readonly tauri = inject(TauriService);

  /**
   * Preprocess a user image and persist it to the project paste directory.
   * @param file - Pasted/dropped image File.
   * @param modelClass - Active model family — sets native long edge target.
   * @param project - Active project name (paths resolved Tauri-side).
   */
  async preprocess(
    file: File,
    modelClass: ModelClass,
    project: string
  ): Promise<PreprocessedImage> {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      throw new Error(ERROR_UNSUPPORTED_TYPE);
    }
    const mediaType = file.type as SupportedMediaType;

    if (file.type === 'image/gif') {
      // GIFs are not resampled; size guard before host `MAX_PASTE_BYTES`.
      if (file.size > MAX_IMAGE_BYTES) {
        throw new Error(ERROR_TOO_LARGE);
      }
      return this.persist(file, mediaType, project, file.size, undefined);
    }

    const dims = await readImageDimensions(file);
    const longEdge = NATIVE_LONG_EDGE[modelClass];
    const withinNative = dims.width <= longEdge && dims.height <= longEdge;
    if (withinNative && file.size <= PASS_THROUGH_BYTES) {
      return this.persist(file, mediaType, project, file.size, dims);
    }

    const targetLongEdge = Math.min(longEdge, MAX_DIMENSION);
    let blob = await this.resample(file, dims, targetLongEdge);
    if (blob.size > MAX_IMAGE_BYTES && targetLongEdge !== NATIVE_LONG_EDGE.sonnet) {
      blob = await this.resample(file, dims, NATIVE_LONG_EDGE.sonnet);
    }
    if (blob.size > MAX_IMAGE_BYTES) {
      throw new Error(ERROR_TOO_LARGE);
    }
    const outMime: SupportedMediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return this.persist(blob, outMime, project, blob.size, undefined);
  }

  private async persist(
    source: Blob,
    mediaType: SupportedMediaType,
    project: string,
    sizeBytes: number,
    knownDims: { width: number; height: number } | undefined
  ): Promise<PreprocessedImage> {
    const dims =
      knownDims ?? (await readImageDimensions(source).catch(() => ({ width: 0, height: 0 })));
    const bytes = new Uint8Array(await source.arrayBuffer());
    const saved = await this.tauri.invoke<{
      container_path: string;
      host_path: string;
      filename: string;
    }>('save_pasted_image', {
      project,
      mediaType,
      bytes: Array.from(bytes),
    });
    const previewUrl = URL.createObjectURL(source);
    return {
      attachment: {
        filename: saved.filename,
        mediaType,
        containerPath: saved.container_path,
        hostPath: saved.host_path,
      },
      previewUrl,
      width: dims.width,
      height: dims.height,
      sizeBytes,
    };
  }

  private async resample(
    file: File,
    dims: { width: number; height: number },
    longEdge: number
  ): Promise<Blob> {
    const scale = Math.min(1, longEdge / Math.max(dims.width, dims.height));
    const targetW = Math.max(1, Math.round(dims.width * scale));
    const targetH = Math.max(1, Math.round(dims.height * scale));

    const source = await createImageBitmap(file);
    try {
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = dims.width;
      srcCanvas.height = dims.height;
      const srcCtx = srcCanvas.getContext('2d');
      if (!srcCtx) {
        throw new Error('Canvas 2D context unavailable');
      }
      srcCtx.drawImage(source, 0, 0);

      const dstCanvas = document.createElement('canvas');
      dstCanvas.width = targetW;
      dstCanvas.height = targetH;
      await this.pica.resize(srcCanvas, dstCanvas);

      // PNG → PNG (transparency). JPEG/WebP → JPEG re-encode.
      const outMime: SupportedMediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const blob: Blob | null = await this.pica.toBlob(
        dstCanvas,
        outMime,
        outMime === 'image/jpeg' ? JPEG_QUALITY : undefined
      );
      if (!blob) {
        throw new Error('Canvas toBlob returned null');
      }
      return blob;
    } finally {
      source.close?.();
    }
  }
}

async function readImageDimensions(file: Blob): Promise<{ width: number; height: number }> {
  // createImageBitmap decodes off-thread; falls back to Image() for older webviews.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close?.();
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image dimensions'));
    };
    img.src = url;
  });
}
