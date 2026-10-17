import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  ERROR_ATTACH_CANCELLED,
  FileAttachmentService,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_ID_HEADER,
} from './file-attachment.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { makeMockLogger } from '../testing/mock-logger';

interface RecordedCall {
  cmd: string;
  args?: Record<string, unknown>;
  options?: { headers: Record<string, string> };
}

function bodyOf(call: RecordedCall): Uint8Array {
  return call.args as unknown as Uint8Array;
}

const UPLOAD_ID = 7;

const SAVED = {
  paste_id: UPLOAD_ID,
  container_path: '/workspace/.speedwave/pastes/paste-1-0001-notes.txt',
  filename: 'paste-1-0001-notes.txt',
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FileAttachmentService', () => {
  let tauri: MockTauriService;
  let logger: ReturnType<typeof makeMockLogger>;
  let service: FileAttachmentService;
  let calls: RecordedCall[];
  let failAppend: unknown;
  let onAppend: (() => void) | null;

  beforeEach(() => {
    calls = [];
    failAppend = null;
    onAppend = null;
    tauri = new MockTauriService();
    logger = makeMockLogger();
    tauri.invokeHandler = async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      switch (cmd) {
        case 'begin_paste_upload':
          return UPLOAD_ID;
        case 'append_paste_upload':
          onAppend?.();
          if (failAppend) throw failAppend;
          return undefined;
        case 'finish_paste_upload':
          return SAVED;
        default:
          return undefined;
      }
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: tauri },
        { provide: LoggerService, useValue: logger },
      ],
    });
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
    expect(first.options?.headers).toEqual({ [UPLOAD_ID_HEADER]: String(UPLOAD_ID) });
    expect(second.options?.headers).toEqual({ [UPLOAD_ID_HEADER]: String(UPLOAD_ID) });
    expect(calls[3].args).toEqual({ uploadId: UPLOAD_ID });
    expect(staged.attachment).toEqual({
      kind: 'file',
      filename: 'notes.txt',
      sizeBytes: UPLOAD_CHUNK_BYTES + 3,
      containerPath: SAVED.container_path,
    });
    expect(staged.sizeBytes).toBe(UPLOAD_CHUNK_BYTES + 3);
    expect(staged.previewUrl).toBeUndefined();
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

  it('discards the finished file by its paste id when the staged attachment is discarded', async () => {
    const staged = await service.stage(
      new File(['x'], 'a.txt', { type: 'text/plain' }),
      'acme',
      new AbortController().signal
    );

    staged.discard();

    expect(calls.at(-1)).toEqual({
      cmd: 'discard_paste',
      args: { pasteId: SAVED.paste_id },
      options: undefined,
    });
  });

  it('discards the upload, logs the failure and rethrows the string a failed append rejects with', async () => {
    failAppend = 'failed to write x.part: No space left on device';
    const file = new File(['abc'], 'a.bin', { type: '' });

    const outcome = service.stage(file, 'acme', new AbortController().signal);

    await expect(outcome).rejects.toBe('failed to write x.part: No space left on device');
    expect(commands()).toEqual(['begin_paste_upload', 'append_paste_upload', 'discard_paste']);
    expect(calls[2].args).toEqual({ pasteId: UPLOAD_ID });
    expect(logger.warn).toHaveBeenCalledWith(
      'could not attach a.bin: failed to write x.part: No space left on device'
    );
  });

  it('stops after the current chunk, discards the upload and reports the cancellation when the signal fires mid-upload', async () => {
    const controller = new AbortController();
    onAppend = () => controller.abort();
    const file = new File([new Uint8Array(UPLOAD_CHUNK_BYTES + 1)], 'big.iso', { type: '' });

    await expect(service.stage(file, 'acme', controller.signal)).rejects.toThrow(
      ERROR_ATTACH_CANCELLED
    );

    expect(commands()).toEqual(['begin_paste_upload', 'append_paste_upload', 'discard_paste']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never finishes a single-chunk file whose signal fires during its only append', async () => {
    const controller = new AbortController();
    onAppend = () => controller.abort();
    const file = new File(['small'], 'small.txt', { type: 'text/plain' });

    await expect(service.stage(file, 'acme', controller.signal)).rejects.toThrow(
      ERROR_ATTACH_CANCELLED
    );

    expect(commands()).toEqual(['begin_paste_upload', 'append_paste_upload', 'discard_paste']);
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

  it('still rethrows the original failure, and logs the discard failure, when the discard itself fails', async () => {
    tauri.invokeHandler = async (cmd) => {
      calls.push({ cmd });
      if (cmd === 'begin_paste_upload') return UPLOAD_ID;
      if (cmd === 'append_paste_upload') throw 'append exploded';
      throw 'discard exploded';
    };
    const file = new File(['abc'], 'a.bin', { type: '' });

    await expect(service.stage(file, 'acme', new AbortController().signal)).rejects.toBe(
      'append exploded'
    );
    await flush();

    expect(commands()).toEqual(['begin_paste_upload', 'append_paste_upload', 'discard_paste']);
    expect(logger.warn).toHaveBeenCalledWith(
      `could not discard pasted file ${UPLOAD_ID}: discard exploded`
    );
  });
});
