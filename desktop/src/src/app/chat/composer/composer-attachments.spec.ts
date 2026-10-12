import { describe, it, expect, vi } from 'vitest';
import { ComposerAttachments } from './composer-attachments';
import type { PreprocessedImage } from '../../services/image-preprocessor.service';

function makeFile(name = 'img.png'): File {
  return new File(['x'], name, { type: 'image/png' });
}

function makePreprocessed(overrides: Partial<PreprocessedImage> = {}): PreprocessedImage {
  return {
    attachment: {
      filename: 'img.png',
      mediaType: 'image/png',
      containerPath: '/workspace/.speedwave/pastes/img.png',
      hostPath: '/tmp/img.png',
    },
    previewUrl: 'blob:final',
    width: 10,
    height: 10,
    sizeBytes: 100,
    ...overrides,
  };
}

/** Never-resolving preprocess step, paired with a manual `resolve`/`reject` call. */
function deferredPreprocess(): {
  run: (file: File) => Promise<PreprocessedImage>;
  resolve: (value: PreprocessedImage) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: PreprocessedImage) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<PreprocessedImage>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { run: () => promise, resolve, reject };
}

describe('ComposerAttachments', () => {
  describe('add — happy path', () => {
    it('stages a pending record immediately, then resolves it with the preprocessed result', async () => {
      const draft = new ComposerAttachments();
      const out = makePreprocessed();

      const promise = draft.add(makeFile(), async () => out);
      expect(draft.records()).toHaveLength(1);
      expect(draft.records()[0].preprocessed).toBeNull();
      expect(draft.anyPreprocessing()).toBe(true);

      await promise;

      expect(draft.records()).toHaveLength(1);
      expect(draft.records()[0].preprocessed).toBe(out);
      expect(draft.records()[0].previewUrl).toBe(out.previewUrl);
      expect(draft.anyPreprocessing()).toBe(false);
      expect(draft.ready()).toEqual([out.attachment]);
      expect(draft.announcement()).toBe('Image attached: img.png');
    });

    it('revokes the placeholder preview URL once the final preview takes over', async () => {
      const draft = new ComposerAttachments();
      const out = makePreprocessed({ previewUrl: 'blob:final-distinct' });

      const promise = draft.add(makeFile(), async () => out);
      const placeholderUrl = draft.records()[0].previewUrl;
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      await promise;

      expect(revokeSpy).toHaveBeenCalledWith(placeholderUrl);
      expect(draft.records()[0].previewUrl).toBe('blob:final-distinct');
      revokeSpy.mockRestore();
    });

    it('assigns unique ids across successive adds', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile('a.png'), async () => makePreprocessed());
      await draft.add(makeFile('b.png'), async () => makePreprocessed());

      const ids = draft.records().map((r) => r.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('add — failure path', () => {
    it('removes the pending record and sets the error message on rejection', async () => {
      const draft = new ComposerAttachments();

      await draft.add(makeFile(), async () => {
        throw new Error('bad image');
      });

      expect(draft.records()).toHaveLength(0);
      expect(draft.error()).toBe('bad image');
    });

    it('falls back to the shared unsupported-type message for a non-Error rejection', async () => {
      const draft = new ComposerAttachments();

      await draft.add(makeFile(), async () => {
        throw 'not an Error instance';
      });

      expect(draft.error()).toBe('Supported image formats: JPEG, PNG, GIF, WebP.');
    });

    it('a later successful add clears an earlier error', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), async () => {
        throw new Error('first one failed');
      });
      expect(draft.error()).toBe('first one failed');

      await draft.add(makeFile(), async () => makePreprocessed());
      expect(draft.error()).toBe('');
    });
  });

  describe('remove', () => {
    it('removes the matching record, revokes its preview, and returns it', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), async () => makePreprocessed());
      const [record] = draft.records();
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      const removed = draft.remove(record.id);

      expect(removed).toBe(record);
      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith(record.previewUrl);
      revokeSpy.mockRestore();
    });

    it('returns undefined and does nothing for an unknown id', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), async () => makePreprocessed());

      expect(draft.remove('does-not-exist')).toBeUndefined();
      expect(draft.records()).toHaveLength(1);
    });

    it('removing a still-pending record makes its eventual resolution revoke the final preview instead of reappearing', async () => {
      const draft = new ComposerAttachments();
      const deferred = deferredPreprocess();
      const pending = draft.add(makeFile(), deferred.run);
      const [record] = draft.records();

      draft.remove(record.id);
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
      const out = makePreprocessed({ previewUrl: 'blob:orphaned-final' });
      deferred.resolve(out);
      await pending;

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:orphaned-final');
      revokeSpy.mockRestore();
    });
  });

  describe('clear', () => {
    it('revokes every preview and empties the record list', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile('a.png'), async () => makePreprocessed({ previewUrl: 'blob:a' }));
      await draft.add(makeFile('b.png'), async () => makePreprocessed({ previewUrl: 'blob:b' }));
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      draft.clear();

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:a');
      expect(revokeSpy).toHaveBeenCalledWith('blob:b');
      revokeSpy.mockRestore();
    });

    it('clears a standing error too', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), async () => {
        throw new Error('broken');
      });

      draft.clear();

      expect(draft.error()).toBe('');
    });
  });

  describe('dispose', () => {
    it('revokes every held preview and empties the records', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), async () => makePreprocessed({ previewUrl: 'blob:held' }));
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      draft.dispose();

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:held');
      revokeSpy.mockRestore();
    });

    it('a resolution landing after dispose revokes the final preview without reviving the record', async () => {
      const draft = new ComposerAttachments();
      const deferred = deferredPreprocess();
      const pending = draft.add(makeFile(), deferred.run);

      draft.dispose();
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
      const out = makePreprocessed({ previewUrl: 'blob:too-late' });
      deferred.resolve(out);
      await pending;

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:too-late');
      revokeSpy.mockRestore();
    });

    it('a rejection landing after dispose does not set an error', async () => {
      const draft = new ComposerAttachments();
      const deferred = deferredPreprocess();
      const pending = draft.add(makeFile(), deferred.run);

      draft.dispose();
      deferred.reject(new Error('too late to matter'));
      await pending;

      expect(draft.error()).toBe('');
    });

    it('is idempotent', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), async () => makePreprocessed());

      expect(() => {
        draft.dispose();
        draft.dispose();
      }).not.toThrow();
    });
  });
});
