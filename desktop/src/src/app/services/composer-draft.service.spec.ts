import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ProjectStateService } from './project-state.service';
import {
  ERROR_UNSUPPORTED_TYPE,
  ImagePreprocessorService,
  type ModelClass,
  type PreprocessedImage,
} from './image-preprocessor.service';
import { ComposerDraftService, ERROR_NO_PROJECT } from './composer-draft.service';

class ProjectStateStub {
  readonly activeProject = signal<string | null>('demo');
}

function preprocessed(filename: string, previewUrl: string): PreprocessedImage {
  return {
    attachment: {
      filename,
      mediaType: 'image/png',
      containerPath: `/workspace/.speedwave/pastes/${filename}`,
      hostPath: `/tmp/${filename}`,
    },
    previewUrl,
    width: 10,
    height: 10,
    sizeBytes: 100,
  };
}

class PreprocessorStub {
  outputs: PreprocessedImage[] = [preprocessed('saved.png', 'blob:out-0')];
  failure: unknown = null;
  gate: Promise<void> | null = null;
  calls: Array<{ file: File; modelClass: ModelClass; project: string }> = [];

  preprocess = vi.fn(async (file: File, modelClass: ModelClass, project: string) => {
    this.calls.push({ file, modelClass, project });
    if (this.gate) await this.gate;
    if (this.failure !== null) throw this.failure;
    return this.outputs[this.calls.length - 1] ?? this.outputs[this.outputs.length - 1];
  });
}

function pngFile(name = 'shot.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

describe('ComposerDraftService', () => {
  let service: ComposerDraftService;
  let projectState: ProjectStateStub;
  let preprocessor: PreprocessorStub;
  let created: string[];
  let revoked: string[];
  const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

  beforeEach(() => {
    created = [];
    revoked = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        const url = `blob:tmp-${created.length}`;
        created.push(url);
        return url;
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((url: string) => {
        revoked.push(url);
      }),
    });

    TestBed.configureTestingModule({
      providers: [
        { provide: ProjectStateService, useClass: ProjectStateStub },
        { provide: ImagePreprocessorService, useClass: PreprocessorStub },
      ],
    });
    projectState = TestBed.inject(ProjectStateService) as unknown as ProjectStateStub;
    preprocessor = TestBed.inject(ImagePreprocessorService) as unknown as PreprocessorStub;
    service = TestBed.inject(ComposerDraftService);
  });

  afterEach(() => {
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  describe('initial state', () => {
    it('starts empty', () => {
      expect(service.text()).toBe('');
      expect(service.planMode()).toBe(false);
      expect(service.attachments()).toEqual([]);
      expect(service.attachmentError()).toBe('');
      expect(service.attachmentAnnouncement()).toBe('');
      expect(service.anyPreprocessing()).toBe(false);
      expect(service.readyChatAttachments()).toEqual([]);
    });

    it('is a singleton across injections', () => {
      expect(TestBed.inject(ComposerDraftService)).toBe(service);
    });
  });

  describe('text', () => {
    it('stores the value verbatim, without trimming', () => {
      service.setText('   spaced   ');
      expect(service.text()).toBe('   spaced   ');
    });

    it('preserves multi-line content and Unicode', () => {
      service.setText('linia jeden\nlinia dwa 🚀 żółć');
      expect(service.text()).toBe('linia jeden\nlinia dwa 🚀 żółć');
    });

    it('accepts an empty string', () => {
      service.setText('draft');
      service.setText('');
      expect(service.text()).toBe('');
    });
  });

  describe('plan mode', () => {
    it('toggles on and off', () => {
      service.togglePlanMode();
      expect(service.planMode()).toBe(true);
      service.togglePlanMode();
      expect(service.planMode()).toBe(false);
    });

    it('survives clearAttachments', () => {
      service.togglePlanMode();
      service.clearAttachments();
      expect(service.planMode()).toBe(true);
    });
  });

  describe('ingest', () => {
    it('does nothing when no file is an image', async () => {
      await service.ingest([new File(['x'], 'notes.txt', { type: 'text/plain' })], '');
      expect(service.attachments()).toEqual([]);
      expect(service.attachmentError()).toBe('');
      expect(created).toEqual([]);
    });

    it('reports a missing project and creates no blob', async () => {
      projectState.activeProject.set(null);
      await service.ingest([pngFile()], '');
      expect(service.attachmentError()).toBe(ERROR_NO_PROJECT);
      expect(service.attachments()).toEqual([]);
      expect(created).toEqual([]);
    });

    it('appends a preprocessed record and revokes the temporary preview exactly once', async () => {
      await service.ingest([pngFile()], 'claude-opus-4-8');

      const list = service.attachments();
      expect(list).toHaveLength(1);
      expect(list[0].preprocessed).not.toBeNull();
      expect(list[0].previewUrl).toBe('blob:out-0');
      expect(revoked).toEqual(['blob:tmp-0']);
      expect(service.attachmentAnnouncement()).toBe('Image attached: saved.png');
      expect(service.attachmentError()).toBe('');
      expect(service.anyPreprocessing()).toBe(false);
    });

    it('maps the model id to a model class', async () => {
      await service.ingest([pngFile()], 'claude-opus-4-8');
      await service.ingest([pngFile()], 'claude-haiku-4-5-20251001');
      await service.ingest([pngFile()], '');

      expect(preprocessor.calls.map((c) => c.modelClass)).toEqual(['opus', 'haiku', 'sonnet']);
      expect(preprocessor.calls[0].project).toBe('demo');
    });

    it('drops the record and surfaces the error message on failure', async () => {
      preprocessor.failure = new Error('Image too large');
      await service.ingest([pngFile()], '');

      expect(service.attachments()).toEqual([]);
      expect(revoked).toEqual(['blob:tmp-0']);
      expect(service.attachmentError()).toBe('Image too large');
    });

    it('falls back to the unsupported-type message on a non-Error throw', async () => {
      preprocessor.failure = 'boom';
      await service.ingest([pngFile()], '');
      expect(service.attachmentError()).toBe(ERROR_UNSUPPORTED_TYPE);
    });

    it('keeps ids unique across separate calls', async () => {
      preprocessor.outputs = [
        preprocessed('a.png', 'blob:out-0'),
        preprocessed('b.png', 'blob:out-1'),
      ];
      await service.ingest([pngFile('a.png')], '');
      await service.ingest([pngFile('b.png')], '');

      expect(service.attachments().map((a) => a.id)).toEqual(['att-1', 'att-2']);
    });

    it('reports anyPreprocessing while a record is still resampling', async () => {
      let release = (): void => undefined;
      preprocessor.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const pending = service.ingest([pngFile()], '');
      expect(service.anyPreprocessing()).toBe(true);
      expect(service.readyChatAttachments()).toEqual([]);

      release();
      await pending;
      expect(service.anyPreprocessing()).toBe(false);
      expect(service.readyChatAttachments()).toHaveLength(1);
    });

    it('revokes the resampled blob and does not resurrect an attachment removed mid-preprocess', async () => {
      let release = (): void => undefined;
      preprocessor.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const pending = service.ingest([pngFile()], '');
      service.removeAttachment('att-1');
      release();
      await pending;

      expect(service.attachments()).toEqual([]);
      expect(revoked).toContain('blob:out-0');
    });

    it('revokes the resampled blob and does not resurrect an attachment cleared mid-preprocess', async () => {
      let release = (): void => undefined;
      preprocessor.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const pending = service.ingest([pngFile()], '');
      service.clearAttachments();
      release();
      await pending;

      expect(service.attachments()).toEqual([]);
      expect(revoked).toContain('blob:out-0');
    });

    it('suppresses the error banner for an attachment removed before preprocessing rejected', async () => {
      let release = (): void => undefined;
      preprocessor.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      preprocessor.failure = new Error('Image too large');

      const pending = service.ingest([pngFile()], '');
      service.removeAttachment('att-1');
      release();
      await pending;

      expect(service.attachmentError()).toBe('');
    });
  });

  describe('removeAttachment', () => {
    it('revokes only the removed preview and announces it', async () => {
      preprocessor.outputs = [
        preprocessed('a.png', 'blob:out-0'),
        preprocessed('b.png', 'blob:out-1'),
      ];
      await service.ingest([pngFile('a.png')], '');
      await service.ingest([pngFile('b.png')], '');
      revoked.length = 0;

      service.removeAttachment('att-1');

      expect(service.attachments().map((a) => a.id)).toEqual(['att-2']);
      expect(revoked).toEqual(['blob:out-0']);
      expect(service.attachmentAnnouncement()).toBe('Image removed: a.png');
    });

    it('is a no-op for an unknown id', async () => {
      await service.ingest([pngFile()], '');
      revoked.length = 0;

      service.removeAttachment('att-999');

      expect(service.attachments()).toHaveLength(1);
      expect(revoked).toEqual([]);
      expect(service.attachmentAnnouncement()).toBe('Image attached: saved.png');
    });
  });

  describe('clearAttachments', () => {
    it('revokes every preview, empties the list, and clears the error, leaving text and plan mode', async () => {
      preprocessor.outputs = [
        preprocessed('a.png', 'blob:out-0'),
        preprocessed('b.png', 'blob:out-1'),
      ];
      await service.ingest([pngFile('a.png')], '');
      await service.ingest([pngFile('b.png')], '');
      service.setText('keep me');
      service.togglePlanMode();
      revoked.length = 0;

      service.clearAttachments();

      expect(service.attachments()).toEqual([]);
      expect(revoked).toEqual(['blob:out-0', 'blob:out-1']);
      expect(service.attachmentError()).toBe('');
      expect(service.text()).toBe('keep me');
      expect(service.planMode()).toBe(true);
    });
  });

  describe('readyChatAttachments', () => {
    it('returns wire shapes in order and skips records still resampling', async () => {
      preprocessor.outputs = [
        preprocessed('a.png', 'blob:out-0'),
        preprocessed('b.png', 'blob:out-1'),
      ];
      await service.ingest([pngFile('a.png')], '');
      await service.ingest([pngFile('b.png')], '');

      expect(service.readyChatAttachments().map((a) => a.filename)).toEqual(['a.png', 'b.png']);
      expect(service.readyChatAttachments()[0].containerPath).toBe(
        '/workspace/.speedwave/pastes/a.png'
      );
    });
  });

  describe('active project changes', () => {
    it('drops attachments but keeps text and plan mode on a real switch', async () => {
      await service.ingest([pngFile()], '');
      service.setText('still mine');
      service.togglePlanMode();
      revoked.length = 0;

      projectState.activeProject.set('other');
      TestBed.tick();

      expect(service.attachments()).toEqual([]);
      expect(revoked).toEqual(['blob:out-0']);
      expect(service.text()).toBe('still mine');
      expect(service.planMode()).toBe(true);
    });

    it('drops attachments when the project is removed', async () => {
      await service.ingest([pngFile()], '');
      projectState.activeProject.set(null);
      TestBed.tick();
      expect(service.attachments()).toEqual([]);
    });

    it('does not clear on the initial null to project transition', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          {
            provide: ProjectStateService,
            useClass: class {
              readonly activeProject = signal<string | null>(null);
            },
          },
          { provide: ImagePreprocessorService, useClass: PreprocessorStub },
        ],
      });
      const state = TestBed.inject(ProjectStateService) as unknown as ProjectStateStub;
      const fresh = TestBed.inject(ComposerDraftService);
      fresh.setText('typed before boot settled');
      fresh.togglePlanMode();

      state.activeProject.set('demo');
      TestBed.tick();

      expect(fresh.text()).toBe('typed before boot settled');
      expect(fresh.planMode()).toBe(true);
    });

    it('clears a stale no-project error on the initial null to project transition', async () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          {
            provide: ProjectStateService,
            useClass: class {
              readonly activeProject = signal<string | null>(null);
            },
          },
          { provide: ImagePreprocessorService, useClass: PreprocessorStub },
        ],
      });
      const state = TestBed.inject(ProjectStateService) as unknown as ProjectStateStub;
      const fresh = TestBed.inject(ComposerDraftService);
      await fresh.ingest([pngFile()], '');
      expect(fresh.attachmentError()).toBe(ERROR_NO_PROJECT);

      state.activeProject.set('demo');
      TestBed.tick();

      expect(fresh.attachmentError()).toBe('');
    });

    it('discards an ingest that was in flight when the project changed', async () => {
      let release = (): void => undefined;
      preprocessor.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const pending = service.ingest([pngFile()], '');
      projectState.activeProject.set('other');
      TestBed.tick();
      release();
      await pending;

      expect(service.attachments()).toEqual([]);
      expect(revoked).toContain('blob:out-0');
    });
  });

  describe('teardown', () => {
    it('revokes live previews when the root injector is destroyed', async () => {
      await service.ingest([pngFile()], '');
      revoked.length = 0;

      TestBed.resetTestingModule();

      expect(revoked).toEqual(['blob:out-0']);
    });
  });
});
