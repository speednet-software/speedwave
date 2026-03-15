import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ToolNormalizerService } from './tool-normalizer.service';

describe('ToolNormalizerService', () => {
  let service: ToolNormalizerService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [ToolNormalizerService] });
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
    const todos = [{ id: '1', title: 'Fix bug', status: 'pending' }];
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

  it('returns generic for invalid JSON and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = service.normalize('Bash', 'not json');
    expect(result).toEqual({ kind: 'generic', raw_json: 'not json' });
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to parse tool input for "Bash":',
      'not json',
      expect.any(SyntaxError)
    );
    warnSpy.mockRestore();
  });

  it('returns generic for empty string', () => {
    const result = service.normalize('Read', '');
    expect(result).toEqual({ kind: 'generic', raw_json: '' });
  });

  it('handles missing fields with defaults', () => {
    const result = service.normalize('Bash', '{}');
    expect(result).toEqual({ kind: 'bash', command: '' });
  });
});
