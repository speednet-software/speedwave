import { describe, it, expect, vi } from 'vitest';
import { ComposerAttachments, ERROR_ATTACH_FAILED } from './composer-attachments';
import type { PreprocessedImage } from '../../services/image-preprocessor.service';
import type { StagedAttachment } from '../../services/file-attachment.service';

function makeFile(name = 'img.png', type = 'image/png'): File {
  return new File(['x'], name, { type });
}

function makePreprocessed(overrides: Partial<PreprocessedImage> = {}): PreprocessedImage {
  return {
    attachment: {
      kind: 'image',
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

function makeStagedFile(overrides: Partial<StagedAttachment> = {}): StagedAttachment {
  return {
    attachment: {
      kind: 'file',
      filename: 'notes.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 2048,
      containerPath: '/workspace/.speedwave/pastes/paste-1-0001-notes.pdf',
      hostPath: '/tmp/paste-1-0001-notes.pdf',
    },
    previewUrl: '',
    sizeBytes: 2048,
    ...overrides,
  };
}

/** Never-resolving stage step, paired with a manual `resolve`/`reject` call and the signal it saw. */
function deferredStage(): {
  run: (file: File, signal: AbortSignal) => Promise<StagedAttachment>;
  resolve: (value: StagedAttachment) => void;
  reject: (err: unknown) => void;
  signal: () => AbortSignal | undefined;
} {
  let resolve!: (value: StagedAttachment) => void;
  let reject!: (err: unknown) => void;
  let seen: AbortSignal | undefined;
  const promise = new Promise<StagedAttachment>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    run: (_file, signal) => {
      seen = signal;
      return promise;
    },
    resolve,
    reject,
    signal: () => seen,
  };
}

describe('ComposerAttachments', () => {
  describe('add — happy path', () => {
    it('stages a pending record immediately, then resolves it with the preprocessed result', async () => {
      const draft = new ComposerAttachments();
      const out = makePreprocessed();

      const promise = draft.add(makeFile(), 'image', async () => out);
      expect(draft.records()).toHaveLength(1);
      expect(draft.records()[0].staged).toBeNull();
      expect(draft.records()[0].kind).toBe('image');
      expect(draft.anyPreprocessing()).toBe(true);

      await promise;

      expect(draft.records()).toHaveLength(1);
      expect(draft.records()[0].staged).toBe(out);
      expect(draft.records()[0].previewUrl).toBe(out.previewUrl);
      expect(draft.records()[0].sizeBytes).toBe(100);
      expect(draft.anyPreprocessing()).toBe(false);
      expect(draft.ready()).toEqual([out.attachment]);
      expect(draft.announcement()).toBe('Image attached: img.png');
    });

    it('revokes the placeholder preview URL once the final preview takes over', async () => {
      const draft = new ComposerAttachments();
      const out = makePreprocessed({ previewUrl: 'blob:final-distinct' });

      const promise = draft.add(makeFile(), 'image', async () => out);
      const placeholderUrl = draft.records()[0].previewUrl;
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      await promise;

      expect(revokeSpy).toHaveBeenCalledWith(placeholderUrl);
      expect(draft.records()[0].previewUrl).toBe('blob:final-distinct');
      revokeSpy.mockRestore();
    });

    it('assigns unique ids across successive adds', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile('a.png'), 'image', async () => makePreprocessed());
      await draft.add(makeFile('b.png'), 'image', async () => makePreprocessed());

      const ids = draft.records().map((r) => r.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('add — file kind', () => {
    it('stages a file record without a preview URL and announces it as a file', async () => {
      const draft = new ComposerAttachments();
      const createSpy = vi.spyOn(URL, 'createObjectURL');
      const file = new File([new Uint8Array(2048)], 'notes.pdf', { type: 'application/pdf' });
      const out = makeStagedFile();

      const promise = draft.add(file, 'file', async () => out);
      expect(draft.records()[0]).toMatchObject({
        kind: 'file',
        filename: 'notes.pdf',
        previewUrl: '',
        sizeBytes: 2048,
        staged: null,
      });

      await promise;

      expect(createSpy).not.toHaveBeenCalled();
      expect(draft.records()[0].staged).toBe(out);
      expect(draft.ready()).toEqual([out.attachment]);
      expect(draft.announcement()).toBe('File attached: notes.pdf');
      createSpy.mockRestore();
    });

    it('hands the stage step a signal that is not aborted while the record is listed', async () => {
      const draft = new ComposerAttachments();
      const deferred = deferredStage();

      const pending = draft.add(makeFile('a.bin', ''), 'file', deferred.run);

      expect(deferred.signal()?.aborted).toBe(false);
      deferred.resolve(makeStagedFile());
      await pending;
    });

    it('mixes image and file attachments in ready() in insertion order', async () => {
      const draft = new ComposerAttachments();
      const image = makePreprocessed();
      const file = makeStagedFile();
      await draft.add(makeFile(), 'image', async () => image);
      await draft.add(makeFile('notes.pdf', 'application/pdf'), 'file', async () => file);

      expect(draft.ready()).toEqual([image.attachment, file.attachment]);
    });
  });

  describe('add — failure path', () => {
    it('removes the pending record and sets the error message on rejection', async () => {
      const draft = new ComposerAttachments();

      await draft.add(makeFile(), 'image', async () => {
        throw new Error('bad image');
      });

      expect(draft.records()).toHaveLength(0);
      expect(draft.error()).toBe('bad image');
    });

    it('surfaces a failed upload with the backend message', async () => {
      const draft = new ComposerAttachments();

      await draft.add(makeFile('big.iso', ''), 'file', async () => {
        throw new Error('failed to write /proj/.speedwave/pastes/x.part: No space left on device');
      });

      expect(draft.records()).toHaveLength(0);
      expect(draft.error()).toContain('No space left on device');
    });

    it('falls back to the shared attach-failed message for a non-Error rejection', async () => {
      const draft = new ComposerAttachments();

      await draft.add(makeFile(), 'image', async () => {
        throw 'not an Error instance';
      });

      expect(draft.error()).toBe(ERROR_ATTACH_FAILED);
    });

    it('a later successful add clears an earlier error', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), 'image', async () => {
        throw new Error('first one failed');
      });
      expect(draft.error()).toBe('first one failed');

      await draft.add(makeFile(), 'image', async () => makePreprocessed());
      expect(draft.error()).toBe('');
    });
  });

  describe('remove', () => {
    it('removes the matching record, revokes its preview, and returns it', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), 'image', async () => makePreprocessed());
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
      await draft.add(makeFile(), 'image', async () => makePreprocessed());

      expect(draft.remove('does-not-exist')).toBeUndefined();
      expect(draft.records()).toHaveLength(1);
    });

    it('removing a still-pending record makes its eventual resolution revoke the final preview instead of reappearing', async () => {
      const draft = new ComposerAttachments();
      const deferred = deferredStage();
      const pending = draft.add(makeFile(), 'image', deferred.run);
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

    it('removing a still-uploading file aborts its signal, and the cancellation rejection sets no error', async () => {
      const draft = new ComposerAttachments();
      const deferred = deferredStage();
      const pending = draft.add(makeFile('big.iso', ''), 'file', deferred.run);
      const [record] = draft.records();

      draft.remove(record.id);

      expect(deferred.signal()?.aborted).toBe(true);
      deferred.reject(new Error('Attachment cancelled.'));
      await pending;
      expect(draft.records()).toHaveLength(0);
      expect(draft.error()).toBe('');
    });

    it('does not revoke an empty preview URL of a file record', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile('notes.pdf', 'application/pdf'), 'file', async () =>
        makeStagedFile()
      );
      const [record] = draft.records();
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      draft.remove(record.id);

      expect(revokeSpy).not.toHaveBeenCalled();
      revokeSpy.mockRestore();
    });
  });

  describe('clear', () => {
    it('revokes every preview and empties the record list', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile('a.png'), 'image', async () =>
        makePreprocessed({ previewUrl: 'blob:a' })
      );
      await draft.add(makeFile('b.png'), 'image', async () =>
        makePreprocessed({ previewUrl: 'blob:b' })
      );
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      draft.clear();

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:a');
      expect(revokeSpy).toHaveBeenCalledWith('blob:b');
      revokeSpy.mockRestore();
    });

    it('clears a standing error too', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), 'image', async () => {
        throw new Error('broken');
      });

      draft.clear();

      expect(draft.error()).toBe('');
    });

    it('aborts an upload still in flight', async () => {
      const draft = new ComposerAttachments();
      const deferred = deferredStage();
      const pending = draft.add(makeFile('big.iso', ''), 'file', deferred.run);

      draft.clear();

      expect(deferred.signal()?.aborted).toBe(true);
      deferred.reject(new Error('Attachment cancelled.'));
      await pending;
      expect(draft.records()).toHaveLength(0);
      expect(draft.error()).toBe('');
    });
  });

  describe('dispose', () => {
    it('revokes every held preview and empties the records', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), 'image', async () =>
        makePreprocessed({ previewUrl: 'blob:held' })
      );
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      draft.dispose();

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:held');
      revokeSpy.mockRestore();
    });

    it('a resolution landing after dispose revokes the final preview without reviving the record', async () => {
      const draft = new ComposerAttachments();
      const deferred = deferredStage();
      const pending = draft.add(makeFile(), 'image', deferred.run);

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
      const deferred = deferredStage();
      const pending = draft.add(makeFile(), 'image', deferred.run);

      draft.dispose();
      deferred.reject(new Error('too late to matter'));
      await pending;

      expect(draft.error()).toBe('');
    });

    it('aborts every upload still in flight', async () => {
      const draft = new ComposerAttachments();
      const first = deferredStage();
      const second = deferredStage();
      const pendingA = draft.add(makeFile('a.bin', ''), 'file', first.run);
      const pendingB = draft.add(makeFile('b.bin', ''), 'file', second.run);

      draft.dispose();

      expect(first.signal()?.aborted).toBe(true);
      expect(second.signal()?.aborted).toBe(true);
      first.reject(new Error('Attachment cancelled.'));
      second.reject(new Error('Attachment cancelled.'));
      await Promise.all([pendingA, pendingB]);
    });

    it('is idempotent', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), 'image', async () => makePreprocessed());

      expect(() => {
        draft.dispose();
        draft.dispose();
      }).not.toThrow();
    });
  });
});
