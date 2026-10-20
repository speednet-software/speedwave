import { describe, it, expect, vi } from 'vitest';
import { ComposerAttachments, ERROR_ATTACH_FAILED } from './composer-attachments';
import type { AttachmentKind, StagedAttachment } from '../../models/chat';
import { createDeferred } from '../../testing/deferred';
import { makeStagedFile, makeStagedImage } from '../../testing/attachments';

function makeFile(name = 'img.png', type = 'image/png'): File {
  return new File(['x'], name, { type });
}

function deferredStage<K extends AttachmentKind>() {
  const deferred = createDeferred<StagedAttachment<K>>();
  let seen: AbortSignal | undefined;
  return {
    run: (_file: File, signal: AbortSignal) => {
      seen = signal;
      return deferred.promise;
    },
    resolve: deferred.resolve,
    reject: deferred.reject,
    signal: () => seen,
  };
}

describe('ComposerAttachments', () => {
  describe('add — happy path', () => {
    it('stages a pending record immediately, then resolves it with the staged result', async () => {
      const draft = new ComposerAttachments();
      const out = makeStagedImage('img.png', { previewUrl: 'blob:final', sizeBytes: 100 });

      const promise = draft.add(makeFile(), 'image', async () => out);
      expect(draft.records()).toHaveLength(1);
      expect(draft.records()[0].staged).toBeNull();
      expect(draft.records()[0].kind).toBe('image');
      expect(draft.anyStaging()).toBe(true);

      await promise;

      expect(draft.records()).toHaveLength(1);
      expect(draft.records()[0].staged).toBe(out);
      expect(draft.records()[0].previewUrl).toBe('blob:final');
      expect(draft.records()[0].sizeBytes).toBe(100);
      expect(draft.anyStaging()).toBe(false);
      expect(draft.ready()).toEqual([out.attachment]);
      expect(draft.announcement()).toBe('Image attached: img.png');
    });

    it('revokes the placeholder preview URL once the final preview takes over', async () => {
      const draft = new ComposerAttachments();
      const out = makeStagedImage('img.png', { previewUrl: 'blob:final-distinct' });

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
      await draft.add(makeFile('a.png'), 'image', async () => makeStagedImage('a.png'));
      await draft.add(makeFile('b.png'), 'image', async () => makeStagedImage('b.png'));

      const ids = draft.records().map((r) => r.id);
      expect(new Set(ids).size).toBe(2);
    });

    it('names a nameless file after its kind', async () => {
      const draft = new ComposerAttachments();

      await draft.add(new File(['x'], '', { type: 'image/png' }), 'image', async () =>
        makeStagedImage('')
      );

      expect(draft.records()[0].filename).toBe('image');
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
      expect(draft.records()[0].previewUrl).toBe('');
      expect(draft.ready()).toEqual([out.attachment]);
      expect(draft.announcement()).toBe('File attached: notes.pdf');
      createSpy.mockRestore();
    });

    it('hands the stage step a signal that is not aborted while the record is listed', async () => {
      const draft = new ComposerAttachments();
      const stage = deferredStage<'file'>();

      const pending = draft.add(makeFile('a.bin', ''), 'file', stage.run);

      expect(stage.signal()?.aborted).toBe(false);
      stage.resolve(makeStagedFile('a.bin'));
      await pending;
    });

    it('mixes image and file attachments in ready() in insertion order', async () => {
      const draft = new ComposerAttachments();
      const image = makeStagedImage();
      const file = makeStagedFile();
      await draft.add(makeFile(), 'image', async () => image);
      await draft.add(makeFile('notes.pdf', 'application/pdf'), 'file', async () => file);

      expect(draft.ready()).toEqual([image.attachment, file.attachment]);
    });
  });

  describe('add — failure path', () => {
    it('removes the pending record and reports the error under the file name', async () => {
      const draft = new ComposerAttachments();

      await draft.add(makeFile(), 'image', async () => {
        throw new Error('bad image');
      });

      expect(draft.records()).toHaveLength(0);
      expect(draft.error()).toBe('img.png: bad image');
    });

    it('shows the text a failed Tauri command rejected with, which is a plain string', async () => {
      const draft = new ComposerAttachments();

      await draft.add(makeFile('big.iso', ''), 'file', async () => {
        throw 'failed to write /proj/.speedwave/pastes/x.part: No space left on device';
      });

      expect(draft.records()).toHaveLength(0);
      expect(draft.error()).toBe(
        'big.iso: failed to write /proj/.speedwave/pastes/x.part: No space left on device'
      );
    });

    it('falls back to the shared attach-failed message for a rejection with no text', async () => {
      const draft = new ComposerAttachments();

      await draft.add(makeFile('a.png'), 'image', async () => {
        throw undefined;
      });
      await draft.add(makeFile('b.png'), 'image', async () => {
        throw '';
      });

      expect(draft.error()).toBe(`a.png: ${ERROR_ATTACH_FAILED}\nb.png: ${ERROR_ATTACH_FAILED}`);
    });

    it('keeps the failure of an earlier file when a later one succeeds', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile('first.png'), 'image', async () => {
        throw new Error('first one failed');
      });

      await draft.add(makeFile('second.png'), 'image', async () => makeStagedImage('second.png'));

      expect(draft.error()).toBe('first.png: first one failed');
      expect(draft.records()).toHaveLength(1);
    });
  });

  describe('reportError', () => {
    it('adds one line per report until the error is cleared', () => {
      const draft = new ComposerAttachments();

      draft.reportError('one');
      draft.reportError('two');

      expect(draft.error()).toBe('one\ntwo');
      draft.clear();
      draft.reportError('three');
      expect(draft.error()).toBe('three');
    });
  });

  describe('remove', () => {
    it('removes the matching record, revokes its preview, discards its file and returns it', async () => {
      const draft = new ComposerAttachments();
      const out = makeStagedImage();
      await draft.add(makeFile(), 'image', async () => out);
      const [record] = draft.records();
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      const removed = draft.remove(record.id);

      expect(removed).toBe(record);
      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith(record.previewUrl);
      expect(out.discard).toHaveBeenCalledOnce();
      expect(draft.announcement()).toBe('Image removed: img.png');
      revokeSpy.mockRestore();
    });

    it('announces a removed file as a file', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile('notes.pdf', 'application/pdf'), 'file', async () =>
        makeStagedFile()
      );

      draft.remove(draft.records()[0].id);

      expect(draft.announcement()).toBe('File removed: notes.pdf');
    });

    it('returns undefined and does nothing for an unknown id', async () => {
      const draft = new ComposerAttachments();
      await draft.add(makeFile(), 'image', async () => makeStagedImage());

      expect(draft.remove('does-not-exist')).toBeUndefined();
      expect(draft.records()).toHaveLength(1);
    });

    it('a still-pending record removed before its stage resolves discards what the stage wrote', async () => {
      const draft = new ComposerAttachments();
      const stage = deferredStage<'image'>();
      const pending = draft.add(makeFile(), 'image', stage.run);
      const [record] = draft.records();

      draft.remove(record.id);
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
      const out = makeStagedImage('img.png', { previewUrl: 'blob:orphaned-final' });
      stage.resolve(out);
      await pending;

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:orphaned-final');
      expect(out.discard).toHaveBeenCalledOnce();
      revokeSpy.mockRestore();
    });

    it('removing a still-uploading file aborts its signal, and the cancellation sets no error', async () => {
      const draft = new ComposerAttachments();
      const stage = deferredStage<'file'>();
      const pending = draft.add(makeFile('big.iso', ''), 'file', stage.run);
      const [record] = draft.records();

      draft.remove(record.id);

      expect(stage.signal()?.aborted).toBe(true);
      stage.reject(new Error('Attachment cancelled.'));
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
    it('revokes every preview and empties the record list without discarding the sent files', async () => {
      const draft = new ComposerAttachments();
      const a = makeStagedImage('a.png', { previewUrl: 'blob:a' });
      const b = makeStagedImage('b.png', { previewUrl: 'blob:b' });
      await draft.add(makeFile('a.png'), 'image', async () => a);
      await draft.add(makeFile('b.png'), 'image', async () => b);
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      draft.clear();

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:a');
      expect(revokeSpy).toHaveBeenCalledWith('blob:b');
      expect(a.discard).not.toHaveBeenCalled();
      expect(b.discard).not.toHaveBeenCalled();
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
      const stage = deferredStage<'file'>();
      const pending = draft.add(makeFile('big.iso', ''), 'file', stage.run);

      draft.clear();

      expect(stage.signal()?.aborted).toBe(true);
      stage.reject(new Error('Attachment cancelled.'));
      await pending;
      expect(draft.records()).toHaveLength(0);
      expect(draft.error()).toBe('');
    });
  });

  describe('dispose', () => {
    it('revokes every held preview, discards every staged file and empties the records', async () => {
      const draft = new ComposerAttachments();
      const image = makeStagedImage('img.png', { previewUrl: 'blob:held' });
      const file = makeStagedFile();
      await draft.add(makeFile(), 'image', async () => image);
      await draft.add(makeFile('notes.pdf', 'application/pdf'), 'file', async () => file);
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

      draft.dispose();

      expect(draft.records()).toHaveLength(0);
      expect(draft.isDisposed).toBe(true);
      expect(revokeSpy).toHaveBeenCalledWith('blob:held');
      expect(image.discard).toHaveBeenCalledOnce();
      expect(file.discard).toHaveBeenCalledOnce();
      revokeSpy.mockRestore();
    });

    it('a resolution landing after dispose revokes the final preview and discards the file', async () => {
      const draft = new ComposerAttachments();
      const stage = deferredStage<'image'>();
      const pending = draft.add(makeFile(), 'image', stage.run);

      draft.dispose();
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
      const out = makeStagedImage('img.png', { previewUrl: 'blob:too-late' });
      stage.resolve(out);
      await pending;

      expect(draft.records()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith('blob:too-late');
      expect(out.discard).toHaveBeenCalledOnce();
      revokeSpy.mockRestore();
    });

    it('a rejection landing after dispose does not set an error', async () => {
      const draft = new ComposerAttachments();
      const stage = deferredStage<'image'>();
      const pending = draft.add(makeFile(), 'image', stage.run);

      draft.dispose();
      stage.reject(new Error('too late to matter'));
      await pending;

      expect(draft.error()).toBe('');
    });

    it('aborts every upload still in flight', async () => {
      const draft = new ComposerAttachments();
      const first = deferredStage<'file'>();
      const second = deferredStage<'file'>();
      const pendingA = draft.add(makeFile('a.bin', ''), 'file', first.run);
      const pendingB = draft.add(makeFile('b.bin', ''), 'file', second.run);

      draft.dispose();

      expect(first.signal()?.aborted).toBe(true);
      expect(second.signal()?.aborted).toBe(true);
      first.reject(new Error('Attachment cancelled.'));
      second.reject(new Error('Attachment cancelled.'));
      await Promise.all([pendingA, pendingB]);
    });

    it('an add after dispose stages nothing and never runs its stage step', async () => {
      const draft = new ComposerAttachments();
      draft.dispose();
      const stage = vi.fn(async () => makeStagedFile());

      await draft.add(makeFile('late.bin', ''), 'file', stage);

      expect(stage).not.toHaveBeenCalled();
      expect(draft.records()).toHaveLength(0);
    });

    it('is idempotent', async () => {
      const draft = new ComposerAttachments();
      const out = makeStagedImage();
      await draft.add(makeFile(), 'image', async () => out);

      expect(() => {
        draft.dispose();
        draft.dispose();
      }).not.toThrow();
      expect(out.discard).toHaveBeenCalledOnce();
    });
  });
});
