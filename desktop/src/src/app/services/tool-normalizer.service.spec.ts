import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ToolNormalizerService } from './tool-normalizer.service';
import { LoggerService } from './logger.service';
import { makeMockLogger } from '../testing/mock-logger';

describe('ToolNormalizerService', () => {
  let service: ToolNormalizerService;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    mockLogger = makeMockLogger();
    TestBed.configureTestingModule({
      providers: [ToolNormalizerService, { provide: LoggerService, useValue: mockLogger }],
    });
    service = TestBed.inject(ToolNormalizerService);
  });

  it('normalizes Bash tool', () => {
    const result = service.normalize('Bash', '{"command":"ls -la"}');
    expect(result).toEqual({ kind: 'bash', command: 'ls -la' });
  });

  it('normalizes Read tool', () => {
    const result = service.normalize('Read', '{"file_path":"/src/main.rs","offset":10,"limit":50}');
    expect(result).toEqual({ kind: 'read', file_path: '/src/main.rs', offset: 10, limit: 50 });
  });

  it('normalizes Read tool without optional fields', () => {
    const result = service.normalize('Read', '{"file_path":"/src/main.rs"}');
    expect(result).toEqual({
      kind: 'read',
      file_path: '/src/main.rs',
      offset: undefined,
      limit: undefined,
    });
  });

  it('normalizes Edit tool', () => {
    const result = service.normalize(
      'Edit',
      '{"file_path":"/a.ts","old_string":"foo","new_string":"bar"}'
    );
    expect(result).toEqual({
      kind: 'edit',
      file_path: '/a.ts',
      old_string: 'foo',
      new_string: 'bar',
    });
  });

  it('normalizes Write tool', () => {
    const result = service.normalize('Write', '{"file_path":"/a.ts","content":"hello"}');
    expect(result).toEqual({ kind: 'write', file_path: '/a.ts', content: 'hello' });
  });

  it('normalizes Glob tool', () => {
    const result = service.normalize('Glob', '{"pattern":"**/*.ts","path":"/src"}');
    expect(result).toEqual({ kind: 'glob', pattern: '**/*.ts', path: '/src' });
  });

  it('normalizes Grep tool', () => {
    const result = service.normalize('Grep', '{"pattern":"TODO","path":"/src","include":"*.ts"}');
    expect(result).toEqual({ kind: 'grep', pattern: 'TODO', path: '/src', include: '*.ts' });
  });

  it('normalizes TodoWrite tool', () => {
    const todos = [{ content: 'Fix bug', status: 'pending', activeForm: 'Fixing bug' }];
    const result = service.normalize('TodoWrite', JSON.stringify({ todos }));
    expect(result).toEqual({ kind: 'todo_write', todos });
  });

  it('normalizes WebSearch tool', () => {
    const result = service.normalize('WebSearch', '{"query":"rust async"}');
    expect(result).toEqual({ kind: 'web_search', query: 'rust async' });
  });

  it('normalizes WebFetch tool', () => {
    const result = service.normalize('WebFetch', '{"url":"https://example.com"}');
    expect(result).toEqual({ kind: 'web_fetch', url: 'https://example.com' });
  });

  it('normalizes Agent tool (without prompt field)', () => {
    const result = service.normalize('Agent', '{"description":"search code"}');
    expect(result).toEqual({ kind: 'agent', description: 'search code' });
  });

  it('returns generic for unknown tool', () => {
    const json = '{"custom":"data"}';
    const result = service.normalize('UnknownTool', json);
    expect(result).toEqual({ kind: 'generic', raw_json: json });
  });

  it('returns generic for invalid JSON without logging', () => {
    const result = service.normalize('Bash', 'not json');
    expect(result).toEqual({ kind: 'generic', raw_json: 'not json' });
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('returns generic for a JSON null or scalar input without throwing', () => {
    expect(service.normalize('Bash', 'null')).toEqual({ kind: 'generic', raw_json: 'null' });
    expect(service.normalize('Read', '42')).toEqual({ kind: 'generic', raw_json: '42' });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('returns generic for empty string', () => {
    const result = service.normalize('Read', '');
    expect(result).toEqual({ kind: 'generic', raw_json: '' });
  });

  it('returns generic for a partial JSON prefix without logging', () => {
    const partial = '{"command":"ls -';
    const result = service.normalize('Bash', partial);
    expect(result).toEqual({ kind: 'generic', raw_json: partial });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('normalizes the same unparseable input repeatedly without logging', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(service.normalize('Bash', '{"command":')).toEqual({
        kind: 'generic',
        raw_json: '{"command":',
      });
    }
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('handles missing fields with defaults', () => {
    const result = service.normalize('Bash', '{}');
    expect(result).toEqual({ kind: 'bash', command: '' });
  });
});
