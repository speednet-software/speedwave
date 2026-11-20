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

  it('normalizes TaskCreate tool', () => {
    const result = service.normalize(
      'TaskCreate',
      '{"subject":"Write the fold","description":"Pure function","activeForm":"Writing the fold"}'
    );
    expect(result).toEqual({
      kind: 'task_create',
      subject: 'Write the fold',
      description: 'Pure function',
      activeForm: 'Writing the fold',
    });
  });

  it('normalizes TaskCreate tool without optional fields', () => {
    const result = service.normalize('TaskCreate', '{"subject":"Ship it"}');
    expect(result).toEqual({
      kind: 'task_create',
      subject: 'Ship it',
      description: '',
      activeForm: undefined,
    });
  });

  it('normalizes TaskUpdate tool', () => {
    const result = service.normalize('TaskUpdate', '{"taskId":"3","status":"in_progress"}');
    expect(result).toEqual({
      kind: 'task_update',
      task_id: '3',
      status: 'in_progress',
      subject: undefined,
      activeForm: undefined,
    });
  });

  it('normalizes a numeric TaskUpdate id to a string', () => {
    const result = service.normalize('TaskUpdate', '{"taskId":7,"subject":"Renamed"}');
    expect(result).toEqual({
      kind: 'task_update',
      task_id: '7',
      status: undefined,
      subject: 'Renamed',
      activeForm: undefined,
    });
  });

  it('normalizes TaskList tool', () => {
    expect(service.normalize('TaskList', '{}')).toEqual({ kind: 'task_list' });
  });

  it('normalizes TaskGet tool', () => {
    expect(service.normalize('TaskGet', '{"taskId":"2"}')).toEqual({
      kind: 'task_get',
      task_id: '2',
    });
  });

  it('normalizes WebSearch tool', () => {
    const result = service.normalize('WebSearch', '{"query":"rust async"}');
    expect(result).toEqual({ kind: 'web_search', query: 'rust async' });
  });

  it('normalizes WebFetch tool', () => {
    const result = service.normalize('WebFetch', '{"url":"https://example.com"}');
    expect(result).toEqual({ kind: 'web_fetch', url: 'https://example.com' });
  });

  describe('Workflow', () => {
    it('normalizes name, description and args', () => {
      const result = service.normalize(
        'Workflow',
        '{"name":"release","description":"Ship it","args":{"env":"prod","retries":3}}'
      );
      expect(result).toEqual({
        kind: 'workflow',
        title: 'release',
        description: 'Ship it',
        args: [
          { key: 'env', value: 'prod' },
          { key: 'retries', value: '3' },
        ],
        script: undefined,
        scriptPath: undefined,
        resumeFromRunId: undefined,
      });
    });

    it.each([
      ["export const meta = { name: 'from-meta' };", 'from-meta'],
      ['export const meta={name:"dq-name"}', 'dq-name'],
      ["export  const  meta  =  {\n  description: 'x',\n  name :  'spaced'\n}", 'spaced'],
    ])('takes the title from meta in the script', (script, title) => {
      const result = service.normalize('Workflow', JSON.stringify({ script }));
      expect(result).toMatchObject({ kind: 'workflow', title, script });
    });

    it('prefers name over meta', () => {
      const result = service.normalize(
        'Workflow',
        JSON.stringify({ name: 'saved', script: "export const meta = { name: 'other' }" })
      );
      expect(result).toMatchObject({ kind: 'workflow', title: 'saved' });
    });

    it('ignores a blank name and takes the title from meta', () => {
      const result = service.normalize(
        'Workflow',
        JSON.stringify({ name: '  ', script: "export const meta = { name: 'm' }" })
      );
      expect(result).toMatchObject({ kind: 'workflow', title: 'm' });
    });

    it('falls back to the literal workflow title', () => {
      const result = service.normalize('Workflow', '{"script":"run()"}');
      expect(result).toMatchObject({ kind: 'workflow', title: 'workflow', script: 'run()' });
    });

    it('keeps scriptPath and resumeFromRunId', () => {
      const result = service.normalize(
        'Workflow',
        '{"scriptPath":"wf/a.js","resumeFromRunId":"run-1"}'
      );
      expect(result).toMatchObject({
        kind: 'workflow',
        title: 'workflow',
        scriptPath: 'wf/a.js',
        resumeFromRunId: 'run-1',
      });
    });

    it('falls back to generic when no known field is present', () => {
      const json = '{"other":"shape"}';
      expect(service.normalize('Workflow', json)).toEqual({ kind: 'generic', raw_json: json });
    });

    it('takes the title from meta when args precede the name', () => {
      const script = "export const meta = { args: { a: { b: '}' } }, name: 'x' };";
      const result = service.normalize('Workflow', JSON.stringify({ script }));
      expect(result).toMatchObject({ kind: 'workflow', title: 'x' });
    });

    it('ignores a name nested inside meta', () => {
      const script = "export const meta = { args: { name: 'inner' } };";
      const result = service.normalize('Workflow', JSON.stringify({ script }));
      expect(result).toMatchObject({ kind: 'workflow', title: 'workflow' });
    });

    it.each([
      '{"description":"d"}',
      '{"args":{"a":1}}',
      '{"resumeFromRunId":"run-1"}',
      '{"name":"","script":" ","scriptPath":""}',
    ])('falls back to generic without a usable name, script or scriptPath: %s', (json) => {
      expect(service.normalize('Workflow', json)).toEqual({ kind: 'generic', raw_json: json });
    });

    it('falls back to generic for an empty object', () => {
      expect(service.normalize('Workflow', '{}')).toEqual({ kind: 'generic', raw_json: '{}' });
    });

    it.each([
      '{"args":"text","script":42}',
      '{"args":null,"name":7}',
      '{"args":[1,2],"script":{"a":1}}',
    ])('does not throw on odd types: %s', (json) => {
      expect(service.normalize('Workflow', json)).toEqual({ kind: 'generic', raw_json: json });
    });

    it('ignores a non-object args next to a valid field', () => {
      const result = service.normalize('Workflow', '{"name":"x","args":"nope"}');
      expect(result).toMatchObject({ kind: 'workflow', title: 'x', args: [] });
    });

    it('stringifies non-string arg values', () => {
      const result = service.normalize('Workflow', '{"name":"x","args":{"a":{"b":1},"c":null}}');
      expect(result).toMatchObject({
        args: [
          { key: 'a', value: '{"b":1}' },
          { key: 'c', value: 'null' },
        ],
      });
    });
  });

  it('normalizes Agent tool (without prompt field)', () => {
    const result = service.normalize('Agent', '{"description":"search code"}');
    expect(result).toEqual({ kind: 'agent', description: 'search code' });
  });

  it('normalizes Task like Agent, with its type and background flag', () => {
    const input = JSON.stringify({
      description: 'search code',
      subagent_type: 'Explore',
      run_in_background: true,
      prompt: 'find it',
    });
    const expected = {
      kind: 'agent',
      description: 'search code',
      subagent_type: 'Explore',
      run_in_background: true,
    };
    expect(service.normalize('Task', input)).toEqual(expected);
    expect(service.normalize('Agent', input)).toEqual(expected);
  });

  it('leaves the background flag unset unless it is true', () => {
    const result = service.normalize('Agent', '{"run_in_background":false,"subagent_type":3}');
    expect(result).toEqual({ kind: 'agent', description: '' });
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
