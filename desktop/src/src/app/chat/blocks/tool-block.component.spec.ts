import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ToolBlockComponent } from './tool-block.component';
import { ToolNormalizerService } from '../../services/tool-normalizer.service';
import type { ToolUseBlock } from '../../models/chat';

describe('ToolBlockComponent', () => {
  let component: ToolBlockComponent;
  let fixture: ComponentFixture<ToolBlockComponent>;

  /** Counter to ensure unique tool_ids across tests. */
  let toolIdCounter = 0;

  const makeTool = (overrides: Partial<ToolUseBlock> = {}): ToolUseBlock => ({
    tool_id: `t${++toolIdCounter}`,
    tool_name: 'Read',
    input_json: '{"file_path":"/src/main.rs"}',
    status: 'done',
    collapsed: false,
    ...overrides,
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToolBlockComponent],
      providers: [ToolNormalizerService],
    }).compileComponents();

    fixture = TestBed.createComponent(ToolBlockComponent);
    component = fixture.componentInstance;
  });

  it('renders tool name in header', () => {
    component.tool = makeTool();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tool-name')?.textContent).toBe('Read');
  });

  it('shows file path for Read tool', () => {
    component.tool = makeTool();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.file-path')?.textContent).toBe('/src/main.rs');
  });

  it('shows command for Bash tool', () => {
    component.tool = makeTool({
      tool_name: 'Bash',
      input_json: '{"command":"ls -la"}',
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.terminal-output')?.textContent).toContain('ls -la');
  });

  it('shows diff for Edit tool', () => {
    component.tool = makeTool({
      tool_name: 'Edit',
      input_json: '{"file_path":"/a.ts","old_string":"foo","new_string":"bar"}',
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const adds = el.querySelectorAll('.diff-add');
    const removes = el.querySelectorAll('.diff-remove');
    expect(adds.length).toBeGreaterThan(0);
    expect(removes.length).toBeGreaterThan(0);
  });

  it('shows result when available', () => {
    component.tool = makeTool({
      result: 'file contents here',
      result_is_error: false,
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.result-content')?.textContent).toBe('file contents here');
  });

  it('shows error result with error styling', () => {
    component.tool = makeTool({
      result: 'command not found',
      result_is_error: true,
      status: 'error',
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tool-result-error')).not.toBeNull();
  });

  it('hides body when collapsed via toggleCollapsed', () => {
    component.tool = makeTool();
    fixture.detectChanges();

    // Initially not collapsed
    expect((fixture.nativeElement as HTMLElement).querySelector('.tool-body')).not.toBeNull();

    // Toggle collapsed — component calls markForCheck internally
    component.toggleCollapsed();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.tool-body')).toBeNull();
  });

  it('shows status icon', () => {
    component.tool = makeTool({ status: 'running' });
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('.tool-status-running');
    expect(status).not.toBeNull();
  });

  it('shows header summary', () => {
    component.tool = makeTool();
    fixture.detectChanges();

    const summary = fixture.nativeElement.querySelector('.tool-summary');
    expect(summary?.textContent).toContain('/src/main.rs');
  });

  it('handles generic tool with raw JSON', () => {
    component.tool = makeTool({
      tool_name: 'CustomTool',
      input_json: '{"custom":"data"}',
    });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.code-block')?.textContent).toContain('{"custom":"data"}');
  });

  describe('toggleCollapsed', () => {
    it('does not mutate the @Input tool object', () => {
      const tool = makeTool();
      component.tool = tool;
      fixture.detectChanges();

      component.toggleCollapsed();

      expect(tool.collapsed).toBe(false);
    });

    it('toggles local collapsed state', () => {
      component.tool = makeTool();
      expect(component.isCollapsed()).toBe(false);

      component.toggleCollapsed();
      expect(component.isCollapsed()).toBe(true);

      component.toggleCollapsed();
      expect(component.isCollapsed()).toBe(false);
    });
  });

  describe('normalized caching', () => {
    it('caches normalized result when input_json has not changed', () => {
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
    it('consolidates read/write/edit to file_path', () => {
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

    it('consolidates glob/grep to pattern', () => {
      component.tool = makeTool({
        tool_name: 'Glob',
        input_json: '{"pattern":"**/*.ts"}',
      });
      expect(component.headerSummary).toBe('**/*.ts');

      component.tool = makeTool({
        tool_name: 'Grep',
        input_json: '{"pattern":"TODO"}',
      });
      expect(component.headerSummary).toBe('TODO');
    });

    it('truncates long bash commands at 60 chars', () => {
      const longCmd = 'x'.repeat(100);
      component.tool = makeTool({
        tool_name: 'Bash',
        input_json: `{"command":"${longCmd}"}`,
      });
      expect(component.headerSummary.length).toBe(63);
      expect(component.headerSummary.endsWith('...')).toBe(true);
    });

    it('does not truncate short bash commands', () => {
      component.tool = makeTool({
        tool_name: 'Bash',
        input_json: '{"command":"ls -la"}',
      });
      expect(component.headerSummary).toBe('ls -la');
    });
  });

  describe('diffLines', () => {
    it('prefixes old lines with minus and new lines with plus', () => {
      const result = component.diffLines('old', 'new');
      expect(result).toEqual(['- old', '+ new']);
    });

    it('handles multi-line strings', () => {
      const result = component.diffLines('a\nb', 'c\nd');
      expect(result).toEqual(['- a', '- b', '+ c', '+ d']);
    });

    it('handles empty strings', () => {
      const result = component.diffLines('', '');
      expect(result).toEqual(['- ', '+ ']);
    });

    it('handles old-only content (deletion)', () => {
      const result = component.diffLines('removed', '');
      expect(result).toEqual(['- removed', '+ ']);
    });

    it('handles new-only content (insertion)', () => {
      const result = component.diffLines('', 'added');
      expect(result).toEqual(['- ', '+ added']);
    });
  });
});
