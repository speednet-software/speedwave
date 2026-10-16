import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  ERROR_ATTACH_CANCELLED,
  FileAttachmentService,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_ID_HEADER,
} from './file-attachment.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

interface RecordedCall {
  cmd: string;
  args?: Record<string, unknown>;
  options?: { headers: Record<string, string> };
}

function bodyOf(call: RecordedCall): Uint8Array {
  return call.args as unknown as Uint8Array;
}

const SAVED = {
  container_path: '/workspace/.speedwave/pastes/paste-1-0001-notes.txt',
  host_path: '/Users/x/proj/.speedwave/pastes/paste-1-0001-notes.txt',
  filename: 'paste-1-0001-notes.txt',
};

describe('FileAttachmentService', () => {
  let tauri: MockTauriService;
  let service: FileAttachmentService;
  let calls: RecordedCall[];
  let failAppend: Error | null;
  let onAppend: (() => void) | null;

  beforeEach(() => {
    calls = [];
    failAppend = null;
    onAppend = null;
    tauri = new MockTauriService();
    tauri.invokeHandler = async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      switch (cmd) {
        case 'begin_paste_upload':
          return { upload_id: 7, filename: SAVED.filename };
        case 'append_paste_upload':
          onAppend?.();
          if (failAppend) throw failAppend;
          return 0;
        case 'finish_paste_upload':
          return SAVED;
        default:
          return undefined;
      }
    };
    TestBed.configureTestingModule({ providers: [{ provide: TauriService, useValue: tauri }] });
    service = TestBed.inject(FileAttachmentService);
  });

  function appends(): RecordedCall[] {
    return calls.filter((c) => c.cmd === 'append_paste_upload');
  }

  function commands(): string[] {
    return calls.map((c) => c.cmd);
  }

  it('streams a file as chunk appends addressed by the upload id header, then finishes', async () => {
    const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES + 3);
    bytes[0] = 1;
    bytes[UPLOAD_CHUNK_BYTES] = 2;
    bytes[UPLOAD_CHUNK_BYTES + 2] = 3;
    const file = new File([bytes], 'notes.txt', { type: 'text/plain' });

    const staged = await service.stage(file, 'acme', new AbortController().signal);

    expect(commands()).toEqual([
      'begin_paste_upload',
      'append_paste_upload',
      'append_paste_upload',
      'finish_paste_upload',
    ]);
    expect(calls[0].args).toEqual({
      project: 'acme',
      filename: 'notes.txt',
      sizeBytes: UPLOAD_CHUNK_BYTES + 3,
    });
    const [first, second] = appends();
    expect(bodyOf(first)).toBeInstanceOf(Uint8Array);
    expect(bodyOf(first).length).toBe(UPLOAD_CHUNK_BYTES);
    expect(bodyOf(first)[0]).toBe(1);
    expect(bodyOf(second).length).toBe(3);
    expect(Array.from(bodyOf(second))).toEqual([2, 0, 3]);
    expect(first.options?.headers).toEqual({ [UPLOAD_ID_HEADER]: '7' });
    expect(second.options?.headers).toEqual({ [UPLOAD_ID_HEADER]: '7' });
    expect(calls[3].args).toEqual({ uploadId: 7 });
    expect(staged).toEqual({
      attachment: {
        kind: 'file',
        filename: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: UPLOAD_CHUNK_BYTES + 3,
        containerPath: SAVED.container_path,
        hostPath: SAVED.host_path,
      },
      previewUrl: '',
      sizeBytes: UPLOAD_CHUNK_BYTES + 3,
    });
  });

  it('sends a file that fits one chunk as a single append carrying its exact bytes', async () => {
    const file = new File(['hello'], 'hi.md', { type: '' });

    await service.stage(file, 'acme', new AbortController().signal);

    expect(appends()).toHaveLength(1);
    expect(Array.from(bodyOf(appends()[0]))).toEqual([104, 101, 108, 108, 111]);
  });

  it('begins and finishes a zero-byte file without any append', async () => {
    const file = new File([], 'empty.log', { type: 'text/plain' });

    const staged = await service.stage(file, 'acme', new AbortController().signal);

    expect(commands()).toEqual(['begin_paste_upload', 'finish_paste_upload']);
    expect(staged.sizeBytes).toBe(0);
  });

  it('aborts the upload and rethrows when an append fails', async () => {
    failAppend = new Error('failed to write x.part: No space left on device');
    const file = new File(['abc'], 'a.bin', { type: '' });

    await expect(service.stage(file, 'acme', new AbortController().signal)).rejects.toThrow(
      'No space left on device'
    );

    expect(commands()).toEqual(['begin_paste_upload', 'append_paste_upload', 'abort_paste_upload']);
    expect(calls[2].args).toEqual({ uploadId: 7 });
  });

  it('stops after the current chunk, aborts the upload and reports the cancellation when the signal fires mid-upload', async () => {
    const controller = new AbortController();
    onAppend = () => controller.abort();
    const file = new File([new Uint8Array(UPLOAD_CHUNK_BYTES + 1)], 'big.iso', { type: '' });

    await expect(service.stage(file, 'acme', controller.signal)).rejects.toThrow(
      ERROR_ATTACH_CANCELLED
    );

    expect(commands()).toEqual(['begin_paste_upload', 'append_paste_upload', 'abort_paste_upload']);
  });

  it('never touches the backend for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new File(['abc'], 'a.bin', { type: '' });

    await expect(service.stage(file, 'acme', controller.signal)).rejects.toThrow(
      ERROR_ATTACH_CANCELLED
    );

    expect(calls).toEqual([]);
  });

  it('still rethrows the original failure when the abort call itself fails', async () => {
    failAppend = new Error('append exploded');
    tauri.invokeHandler = async (cmd) => {
      calls.push({ cmd });
      if (cmd === 'begin_paste_upload') return { upload_id: 7, filename: SAVED.filename };
      if (cmd === 'append_paste_upload') throw failAppend;
      throw new Error('abort exploded');
    };
    const file = new File(['abc'], 'a.bin', { type: '' });

    await expect(service.stage(file, 'acme', new AbortController().signal)).rejects.toThrow(
      'append exploded'
    );

    expect(commands()).toEqual(['begin_paste_upload', 'append_paste_upload', 'abort_paste_upload']);
  });
});
