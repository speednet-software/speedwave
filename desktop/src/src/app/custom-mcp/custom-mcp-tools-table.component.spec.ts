import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  CustomMcpToolsTableComponent,
  decisionFor,
  presetDecisions,
} from './custom-mcp-tools-table.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { CustomMcpTool } from '../models/custom-mcp';
import {
  CUSTOM_MCP_PROJECT,
  makeList,
  makeNpmEntry,
  makeTool,
} from '../testing/custom-mcp-fixtures';

const TOOLS: CustomMcpTool[] = [
  makeTool('get_file', { state: 'pending', read_only_hint: true }),
  makeTool('post_comment', { state: 'pending', read_only_hint: false }),
  makeTool('list_files', { state: 'allowed', read_only_hint: true }),
  makeTool('delete_file', { state: 'allowed', read_only_hint: null }),
  makeTool('rename_file', { state: 'changed', read_only_hint: true }),
];

describe('presetDecisions', () => {
  it('all allows every tool not yet allowed, except a changed one', () => {
    expect(presetDecisions('all', TOOLS)).toEqual([
      decisionFor(TOOLS[0], 'allowed'),
      decisionFor(TOOLS[1], 'allowed'),
    ]);
  });

  it('read-only allows hinted tools and blocks the rest, never a changed one', () => {
    expect(presetDecisions('read_only', TOOLS)).toEqual([
      decisionFor(TOOLS[0], 'allowed'),
      decisionFor(TOOLS[1], 'blocked'),
      decisionFor(TOOLS[3], 'blocked'),
    ]);
  });

  it('manual records nothing', () => {
    expect(presetDecisions('manual', TOOLS)).toEqual([]);
  });

  it('records nothing for an empty list', () => {
    expect(presetDecisions('all', [])).toEqual([]);
    expect(presetDecisions('read_only', [])).toEqual([]);
  });

  it('pins each decision to the hash the user saw', () => {
    expect(decisionFor(TOOLS[1], 'blocked')).toEqual({
      upstream_name: 'post_comment',
      state: 'blocked',
      definition_hash: 'hash-post_comment',
    });
  });
});

describe('CustomMcpToolsTableComponent', () => {
  let fixture: ComponentFixture<CustomMcpToolsTableComponent>;
  let mockTauri: MockTauriService;
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let setToolsError: string | null;

  beforeEach(async () => {
    calls = [];
    setToolsError = null;
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'custom_mcp_set_tools') {
        if (setToolsError) throw setToolsError;
        return makeNpmEntry();
      }
      if (cmd === 'custom_mcp_get') return makeList([makeNpmEntry()]);
      return undefined;
    };
    await TestBed.configureTestingModule({
      imports: [CustomMcpToolsTableComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set(CUSTOM_MCP_PROJECT);
    fixture = TestBed.createComponent(CustomMcpToolsTableComponent);
    fixture.componentRef.setInput('project', CUSTOM_MCP_PROJECT);
    fixture.componentRef.setInput('name', 'figma');
    fixture.componentRef.setInput('tools', TOOLS);
    fixture.detectChanges();
  });

  function el(testId: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
  }

  async function click(testId: string): Promise<void> {
    el(testId)!.click();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function sentDecisions(): unknown {
    return calls.find((c) => c.cmd === 'custom_mcp_set_tools')?.args?.['decisions'];
  }

  it('renders one row per tool with its state', () => {
    expect(el('custom-mcp-tool-state-get_file')?.textContent?.trim()).toBe('pending');
    expect(el('custom-mcp-tool-state-list_files')?.textContent?.trim()).toBe('allowed');
    expect(el('custom-mcp-tool-allow-get_file')).not.toBeNull();
    expect(el('custom-mcp-tool-block-get_file')).not.toBeNull();
    expect(el('custom-mcp-tool-allow-list_files')).toBeNull();
  });

  it('the all preset saves the computed decisions', async () => {
    await click('custom-mcp-preset-all');
    expect(sentDecisions()).toEqual(presetDecisions('all', TOOLS));
  });

  it('the read-only preset shows that the hint is unverified', async () => {
    await click('custom-mcp-preset-read-only');
    expect(el('custom-mcp-preset-note')?.textContent).toContain(
      "Based on the server's own readOnlyHint; unverified."
    );
    expect(sentDecisions()).toEqual(presetDecisions('read_only', TOOLS));
  });

  it('the manual preset saves nothing', async () => {
    await click('custom-mcp-preset-manual');
    expect(calls).toEqual([]);
  });

  it('a stale hash error from the backend shows on the row it belongs to', async () => {
    setToolsError = "tool 'post_comment' changed since you reviewed it; review it again";
    await click('custom-mcp-tool-allow-post_comment');
    expect(el('custom-mcp-tool-error-post_comment')?.textContent).toContain(
      'changed since you reviewed it'
    );
    expect(el('custom-mcp-tool-error-get_file')).toBeNull();
    expect(calls.some((c) => c.cmd === 'custom_mcp_get')).toBe(true);
  });

  it('a later successful decision clears the row error', async () => {
    setToolsError = 'refused';
    await click('custom-mcp-tool-allow-post_comment');
    setToolsError = null;
    await click('custom-mcp-tool-block-post_comment');
    expect(el('custom-mcp-tool-error-post_comment')).toBeNull();
  });

  it('a failed preset shows above the table', async () => {
    setToolsError = 'the tool list of this server is not available yet';
    await click('custom-mcp-preset-all');
    expect(el('custom-mcp-tools-error')?.textContent).toContain('not available yet');
  });

  it('a changed tool stays blocked until the user reviews it and allows it explicitly', async () => {
    expect(el('custom-mcp-tool-changed-rename_file')?.textContent).toContain(
      'Definition changed since approval; blocked until you review it.'
    );
    expect(el('custom-mcp-tool-allow-rename_file')).toBeNull();
    await click('custom-mcp-tool-review-rename_file');
    expect(calls).toEqual([]);
    expect(el('custom-mcp-tool-changed-rename_file')?.textContent).toContain('New description');
    await click('custom-mcp-tool-allow-rename_file');
    expect(sentDecisions()).toEqual([decisionFor(TOOLS[4], 'allowed')]);
  });

  it('shows an empty state without tools', () => {
    fixture.componentRef.setInput('tools', []);
    fixture.detectChanges();
    expect(el('custom-mcp-tools-empty')).not.toBeNull();
  });

  it('renders a hostile description as text', () => {
    fixture.componentRef.setInput('tools', [
      makeTool('x', { description_preview: '<img src=x onerror=alert(1)>' }),
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
  });
});
