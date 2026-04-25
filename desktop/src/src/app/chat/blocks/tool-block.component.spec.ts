import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ToolBlockComponent } from './tool-block.component';
import { ToolNormalizerService } from '../../services/tool-normalizer.service';
import type { ToolUseBlock } from '../../models/chat';

describe('ToolBlockComponent', () => {
  let component: ToolBlockComponent;
  let fixture: ComponentFixture<ToolBlockComponent>;

  /** Unique-id seed per test run. */
  let toolIdCounter = 0;

  /**
   * Creates a ToolUseBlock for testing — defaults to 'done' status.
   * @param overrides - Fields to override in the default block.
   */
  function makeTool(overrides: Record<string, unknown> = {}): ToolUseBlock {
    const id = `t${++toolIdCounter}`;
    const base = {
      type: 'tool_use' as const,
      tool_id: id,
      tool_name: 'Read',
      input_json: '{"file_path":"/src/main.rs"}',
      collapsed: false,
    };
    if (overrides['status'] === 'running') {
      return { ...base, status: 'running', ...overrides } as ToolUseBlock;
    }
    if (overrides['status'] === 'error' || overrides['result_is_error'] === true) {
      return {
        ...base,
        status: 'error',
        result: (overrides['result'] as string) ?? '',
        result_is_error: true,
        ...overrides,
      } as ToolUseBlock;
    }
    return {
      ...base,
      status: 'done',
      result: (overrides['result'] as string) ?? '',
      result_is_error: false,
      ...overrides,
    } as ToolUseBlock;
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToolBlockComponent],
      providers: [ToolNormalizerService],
    }).compileComponents();

    fixture = TestBed.createComponent(ToolBlockComponent);
    component = fixture.componentInstance;
  });

  describe('header rendering', () => {
    it('renders tool name in the header', () => {
      component.tool = makeTool();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="tool-name"]')?.textContent).toBe('Read');
    });

    it('renders the done glyph for successful tools', () => {
      component.tool = makeTool({ status: 'done' });
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('[data-testid="tool-status"]')?.textContent?.trim()
      ).toBe('✓');
    });

    it('renders the running glyph for in-flight tools', () => {
      component.tool = makeTool({ status: 'running' });
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('[data-testid="tool-status"]')?.textContent?.trim()
      ).toBe('○');
    });

    it('renders the error glyph for failed tools', () => {
      component.tool = makeTool({ status: 'error', result: 'boom', result_is_error: true });
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('[data-testid="tool-status"]')?.textContent?.trim()
      ).toBe('✗');
    });

    it('renders a stopped glyph when the error result mentions "stopped"', () => {
      component.tool = makeTool({
        status: 'error',
        result: 'Stopped by user',
        result_is_error: true,
      });
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('[data-testid="tool-status"]')?.textContent?.trim()
      ).toBe('⊘');
    });

    it('renders an inline summary for the tool', () => {
      component.tool = makeTool();
      fixture.detectChanges();

      const summary = fixture.nativeElement.querySelector(
        '[data-testid="tool-summary"]'
      ) as HTMLElement | null;
      expect(summary?.textContent?.trim()).toBe('/src/main.rs');
    });

    it('renders the running meta label while running', () => {
      component.tool = makeTool({ status: 'running' });
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="tool-meta"]')?.textContent?.trim()
      ).toBe('running');
    });

    it('hides the meta label when not running or stopped', () => {
      component.tool = makeTool({ status: 'done' });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="tool-meta"]')).toBeNull();
    });
  });

  describe('collapse default', () => {
    it('expands running tools by default', () => {
      component.tool = makeTool({ status: 'running' });
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="tool-body"]')
      ).not.toBeNull();
    });

    it('collapses done tools by default', () => {
      component.tool = makeTool({ status: 'done' });
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="tool-body"]')
      ).toBeNull();
    });

    it('collapses error tools by default', () => {
      component.tool = makeTool({ status: 'error', result: 'boom', result_is_error: true });
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="tool-body"]')
      ).toBeNull();
    });
  });

  describe('per-tool body templates', () => {
    it('renders bash terminal output when expanded', () => {
      component.tool = makeTool({ tool_name: 'Bash', input_json: '{"command":"ls -la"}' });
      fixture.detectChanges();
      // done starts collapsed; expand the body first.
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="terminal-output"]')?.textContent).toContain(
        '$ ls -la'
      );
    });

    it('renders the file path for Read', () => {
      component.tool = makeTool();
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="file-path"]')?.textContent?.trim()).toBe(
        '/src/main.rs'
      );
    });

    it('renders diff-view for Edit', () => {
      component.tool = makeTool({
        tool_name: 'Edit',
        input_json: '{"file_path":"/a.ts","old_string":"foo","new_string":"bar"}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('app-diff-view')).not.toBeNull();
      expect(el.querySelectorAll('[data-testid="diff-add"]').length).toBeGreaterThan(0);
      expect(el.querySelectorAll('[data-testid="diff-remove"]').length).toBeGreaterThan(0);
    });

    it('renders diff-view for Write with empty old_string (all additions)', () => {
      component.tool = makeTool({
        tool_name: 'Write',
        input_json: '{"file_path":"/x.ts","content":"hello\\nworld"}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('app-diff-view')).not.toBeNull();
      expect(el.querySelectorAll('[data-testid="diff-add"]').length).toBe(2);
      expect(el.querySelectorAll('[data-testid="diff-remove"]').length).toBe(0);
    });

    it('renders TodoWrite checklist with one item per todo', () => {
      component.tool = makeTool({
        tool_name: 'TodoWrite',
        input_json: JSON.stringify({
          todos: [
            { id: '1', title: 'first', status: 'completed' },
            { id: '2', title: 'second', status: 'in_progress' },
            { id: '3', title: 'third', status: 'pending' },
          ],
        }),
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const list = el.querySelector('[data-testid="todo-list"]');
      expect(list).not.toBeNull();
      const items = list?.querySelectorAll('li') ?? [];
      expect(items.length).toBe(3);
      expect(items[0].textContent).toContain('first');
      expect(items[1].textContent).toContain('second');
      expect(items[2].textContent).toContain('third');
    });

    it('renders Glob pattern', () => {
      component.tool = makeTool({
        tool_name: 'Glob',
        input_json: '{"pattern":"**/*.ts","path":"src"}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="pattern"]')?.textContent?.trim()).toBe('**/*.ts');
    });

    it('renders Grep with include filter', () => {
      component.tool = makeTool({
        tool_name: 'Grep',
        input_json: '{"pattern":"TODO","include":"*.rs"}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="pattern"]')?.textContent?.trim()).toBe('TODO');
      expect(el.textContent).toContain('*.rs');
    });

    it('renders WebSearch query', () => {
      component.tool = makeTool({
        tool_name: 'WebSearch',
        input_json: '{"query":"lima vm"}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="query"]')?.textContent?.trim()).toBe('lima vm');
    });

    it('renders WebFetch url', () => {
      component.tool = makeTool({
        tool_name: 'WebFetch',
        input_json: '{"url":"https://example.com"}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="url"]')?.textContent?.trim()).toBe(
        'https://example.com'
      );
    });

    it('renders Agent description', () => {
      component.tool = makeTool({
        tool_name: 'Agent',
        input_json: '{"description":"explore the code"}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="agent-description"]')?.textContent?.trim()).toBe(
        'explore the code'
      );
    });

    it('falls back to generic code-block for unknown tools', () => {
      component.tool = makeTool({
        tool_name: 'CustomTool',
        input_json: '{"custom":"data"}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="code-block"]')?.textContent).toContain(
        '{"custom":"data"}'
      );
    });

    it('falls back to generic on malformed JSON without throwing', () => {
      component.tool = makeTool({
        tool_name: 'Bash',
        input_json: '{not valid json',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="code-block"]')?.textContent).toContain(
        '{not valid json'
      );
    });

    it('tolerates empty input_json', () => {
      component.tool = makeTool({
        tool_name: 'Read',
        input_json: '{}',
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const path = el.querySelector('[data-testid="file-path"]');
      expect(path).not.toBeNull();
      expect(path?.textContent?.trim()).toBe('');
    });
  });

  describe('result rendering', () => {
    it('shows result content for successful tools', () => {
      component.tool = makeTool({ result: 'file contents here', result_is_error: false });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="result-content"]')?.textContent).toBe(
        'file contents here'
      );
      expect(el.querySelector('[data-testid="result-label"]')?.textContent?.trim()).toBe('Result');
    });

    it('shows error result with error styling and label', () => {
      component.tool = makeTool({
        status: 'error',
        result: 'command not found',
        result_is_error: true,
      });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const result = el.querySelector('[data-testid="tool-result"]');
      expect(result?.getAttribute('data-error')).toBe('true');
      expect(el.querySelector('[data-testid="result-label"]')?.textContent?.trim()).toBe('Error');
    });

    it('hides the result block while the tool is running', () => {
      component.tool = makeTool({ status: 'running' });
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="tool-result"]')).toBeNull();
    });

    it('hides the result block when there is no result string', () => {
      component.tool = makeTool({ result: '' });
      fixture.detectChanges();
      component.toggleCollapsed();
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="tool-result"]')).toBeNull();
    });
  });

  describe('ARIA and keyboard', () => {
    it('wires role=region and aria-labelledby/aria-controls/aria-expanded', () => {
      component.tool = makeTool({ status: 'running' });
      fixture.detectChanges();

      const region = fixture.nativeElement.querySelector('[role="region"]') as HTMLElement | null;
      expect(region).not.toBeNull();
      const labelled = region?.getAttribute('aria-labelledby');
      const header = fixture.nativeElement.querySelector(`#${labelled}`) as HTMLElement | null;
      expect(header).not.toBeNull();
      expect(header?.getAttribute('aria-expanded')).toBe('true');

      const controls = header?.getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      expect(fixture.nativeElement.querySelector(`#${controls}`)).not.toBeNull();
    });

    it('flips aria-expanded on toggle', () => {
      component.tool = makeTool({ status: 'done' });
      fixture.detectChanges();

      const header = fixture.nativeElement.querySelector('[aria-expanded]') as HTMLElement | null;
      expect(header?.getAttribute('aria-expanded')).toBe('false');

      component.toggleCollapsed();
      fixture.detectChanges();

      const after = fixture.nativeElement.querySelector('[aria-expanded]') as HTMLElement | null;
      expect(after?.getAttribute('aria-expanded')).toBe('true');
    });

    it('uses a <button> for the header (keyboard-operable by default)', () => {
      component.tool = makeTool();
      fixture.detectChanges();
      const header = fixture.nativeElement.querySelector('[aria-expanded]') as HTMLElement | null;
      expect(header?.tagName).toBe('BUTTON');
    });
  });

  describe('status transitions', () => {
    it('applies amber border while running', () => {
      component.tool = makeTool({ status: 'running' });
      fixture.detectChanges();
      const region = fixture.nativeElement.querySelector('[role="region"]') as HTMLElement | null;
      expect(region?.className).toContain('border-amber/50');
    });

    it('applies green border when done', () => {
      component.tool = makeTool({ status: 'done' });
      fixture.detectChanges();
      const region = fixture.nativeElement.querySelector('[role="region"]') as HTMLElement | null;
      expect(region?.className).toContain('border-green/50');
    });

    it('applies red border when error', () => {
      component.tool = makeTool({ status: 'error', result: 'x', result_is_error: true });
      fixture.detectChanges();
      const region = fixture.nativeElement.querySelector('[role="region"]') as HTMLElement | null;
      expect(region?.className).toContain('border-red-500/50');
    });

    it('applies opacity-70 on the interrupted/stopped state', () => {
      component.tool = makeTool({ status: 'error', result: 'Interrupted', result_is_error: true });
      fixture.detectChanges();
      const region = fixture.nativeElement.querySelector('[role="region"]') as HTMLElement | null;
      expect(region?.className).toContain('opacity-70');
    });
  });

  describe('toggleCollapsed', () => {
    it('never mutates the @Input tool object', () => {
      const tool = makeTool();
      component.tool = tool;
      fixture.detectChanges();

      component.toggleCollapsed();

      expect(tool.collapsed).toBe(false);
    });

    it('toggles the collapsed state on each call', () => {
      component.tool = makeTool({ status: 'done' });
      fixture.detectChanges();
      expect(component.isCollapsed()).toBe(true);

      component.toggleCollapsed();
      expect(component.isCollapsed()).toBe(false);

      component.toggleCollapsed();
      expect(component.isCollapsed()).toBe(true);
    });
  });

  describe('normalized caching', () => {
    it('caches the normalized result until input_json changes', () => {
      component.tool = makeTool();
      const first = component.normalized;
      const second = component.normalized;
      expect(first).toBe(second);
    });

    it('recomputes when input_json changes', () => {
      component.tool = makeTool({ input_json: '{"file_path":"/a.ts"}' });
      const first = component.normalized;

      component.tool = { ...component.tool, input_json: '{"file_path":"/b.ts"}' };
      const second = component.normalized;

      expect(first).not.toBe(second);
    });
  });

  describe('headerSummary', () => {
    it('uses file_path for read/write/edit', () => {
      component.tool = makeTool({
        tool_name: 'Write',
        input_json: '{"file_path":"/x.ts","content":"c"}',
      });
      expect(component.headerSummary).toBe('/x.ts');

      component.tool = makeTool({
        tool_name: 'Edit',
        input_json: '{"file_path":"/y.ts","old_string":"a","new_string":"b"}',
      });
      expect(component.headerSummary).toBe('/y.ts');
    });

    it('uses pattern for glob/grep', () => {
      component.tool = makeTool({ tool_name: 'Glob', input_json: '{"pattern":"**/*.ts"}' });
      expect(component.headerSummary).toBe('**/*.ts');

      component.tool = makeTool({ tool_name: 'Grep', input_json: '{"pattern":"TODO"}' });
      expect(component.headerSummary).toBe('TODO');
    });

    it('prefixes bash commands with $', () => {
      component.tool = makeTool({ tool_name: 'Bash', input_json: '{"command":"ls -la"}' });
      expect(component.headerSummary).toBe('$ ls -la');
    });

    it('reports todo count (singular)', () => {
      component.tool = makeTool({
        tool_name: 'TodoWrite',
        input_json: '{"todos":[{"id":"1","title":"a","status":"pending"}]}',
      });
      expect(component.headerSummary).toBe('1 task');
    });

    it('reports todo count (plural)', () => {
      component.tool = makeTool({
        tool_name: 'TodoWrite',
        input_json:
          '{"todos":[{"id":"1","title":"a","status":"pending"},{"id":"2","title":"b","status":"pending"}]}',
      });
      expect(component.headerSummary).toBe('2 tasks');
    });

    it('returns an empty string for generic (unknown) tools', () => {
      component.tool = makeTool({ tool_name: 'Unknown', input_json: '{}' });
      expect(component.headerSummary).toBe('');
    });
  });
});
