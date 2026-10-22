import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CustomMcpReviewComponent } from './custom-mcp-review.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { CustomMcpPreview } from '../models/custom-mcp';
import {
  CUSTOM_MCP_PROJECT,
  makeHostPreview,
  makeList,
  makeNpmEntry,
  makeNpmPreview,
  noForced,
} from '../testing/custom-mcp-fixtures';

describe('CustomMcpReviewComponent', () => {
  let fixture: ComponentFixture<CustomMcpReviewComponent>;
  let mockTauri: MockTauriService;
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let approveError: string | null;
  let nextPreview: CustomMcpPreview | null;
  let approvedNames: string[];
  let closedCount: number;

  async function mount(preview: CustomMcpPreview): Promise<void> {
    fixture = TestBed.createComponent(CustomMcpReviewComponent);
    fixture.componentRef.setInput('project', CUSTOM_MCP_PROJECT);
    fixture.componentRef.setInput('preview', preview);
    fixture.componentInstance.approved.subscribe((n) => approvedNames.push(n));
    fixture.componentInstance.closed.subscribe(() => closedCount++);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    calls = [];
    approveError = null;
    nextPreview = null;
    approvedNames = [];
    closedCount = 0;
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'custom_mcp_approve' && approveError) throw approveError;
      if (cmd === 'custom_mcp_get') return makeList([makeNpmEntry()]);
      if (cmd === 'custom_mcp_preview') return nextPreview;
      return undefined;
    };
    await TestBed.configureTestingModule({
      imports: [CustomMcpReviewComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set(CUSTOM_MCP_PROJECT);
    projectState.status.set('ready');
  });

  function el(testId: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
  }

  function input(testId: string): HTMLInputElement {
    return el(testId) as HTMLInputElement;
  }

  async function check(testId: string): Promise<void> {
    input(testId).click();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function approveDisabled(): boolean {
    return (el('custom-mcp-review-approve') as HTMLButtonElement).disabled;
  }

  it('shows every pinned fact of an npm package', async () => {
    await mount(makeNpmPreview());
    expect(el('custom-mcp-review-package')?.textContent).toContain('figma-developer-mcp');
    expect(el('custom-mcp-review-version')?.textContent).toContain('0.6.1');
    expect(el('custom-mcp-review-published')?.textContent).toContain('2026-09-01');
    expect(el('custom-mcp-review-integrity')?.textContent).toContain('sha512-AAAA');
    expect(el('custom-mcp-review-license')?.textContent).toContain('MIT');
    expect(el('custom-mcp-review-dependencies')?.textContent).toContain('42');
    expect(el('custom-mcp-review-publisher')?.textContent).toContain('glips');
    expect(el('custom-mcp-review-provenance')?.textContent).toContain('provenance');
    expect(el('custom-mcp-review-install-script')?.textContent?.trim()).toBe('no');
    expect(el('custom-mcp-review-args')?.textContent).toContain('--stdio');
    expect(input('custom-mcp-review-env-FIGMA_API_KEY').type).toBe('password');
    expect(el('custom-mcp-review-publisher-changed')).toBeNull();
  });

  it('pre-selects tokens and approves with nothing else to confirm', async () => {
    await mount(makeNpmPreview());
    expect(input('custom-mcp-review-pii-tokens').checked).toBe(true);
    expect(input('custom-mcp-review-files-none').checked).toBe(true);
    expect(approveDisabled()).toBe(false);
  });

  it('read access keeps Approve disabled until its confirmation', async () => {
    await mount(makeNpmPreview());
    await check('custom-mcp-review-files-read_only');
    expect(el('custom-mcp-review-confirm-read-label')?.textContent).toContain(
      'This server will read every project file, including .env and credentials.'
    );
    expect(approveDisabled()).toBe(true);
    await check('custom-mcp-review-confirm-read');
    expect(approveDisabled()).toBe(false);
  });

  it('write access needs both confirmations, and a new pick asks again', async () => {
    await mount(makeNpmPreview());
    await check('custom-mcp-review-files-read_write');
    expect(el('custom-mcp-review-confirm-write-label')?.textContent).toContain(
      'This server can change .git/hooks and CI files; code it writes runs on your machine and in CI.'
    );
    await check('custom-mcp-review-confirm-read');
    expect(approveDisabled()).toBe(true);
    await check('custom-mcp-review-confirm-write');
    expect(approveDisabled()).toBe(false);
    await check('custom-mcp-review-files-read_only');
    expect(approveDisabled()).toBe(true);
  });

  it('a publisher change warns and needs a confirmation', async () => {
    const preview = makeNpmPreview();
    if (preview.details.kind !== 'npm') throw new Error('npm fixture');
    preview.details.publisher_changed = true;
    preview.details.previous_publisher = 'someone-else';
    preview.details.previous_version = '0.5.0';
    await mount(preview);
    expect(el('custom-mcp-review-publisher-changed')?.textContent).toContain(
      'Publisher changed since your last approval'
    );
    expect(el('custom-mcp-review-publisher-changed')?.textContent).toContain('someone-else');
    expect(approveDisabled()).toBe(true);
    await check('custom-mcp-review-confirm-publisher');
    expect(approveDisabled()).toBe(false);
  });

  it('a host review shows the probe and the host warning, and waits for its confirmation', async () => {
    await mount(makeHostPreview());
    expect(el('custom-mcp-review-host')?.textContent).toContain('3845');
    expect(el('custom-mcp-review-reachable')?.textContent?.trim()).toBe('yes');
    expect(el('custom-mcp-review-host-warning')?.textContent).toContain('Host server warning.');
    expect(approveDisabled()).toBe(true);
    await check('custom-mcp-review-confirm-host');
    expect(approveDisabled()).toBe(false);
  });

  it('an unreachable host app says so and the retry probes again', async () => {
    await mount(
      makeHostPreview({
        details: { kind: 'host', port: 3845, path: '/mcp', upstream_reachable: false },
      })
    );
    expect(el('custom-mcp-review-not-running')?.textContent).toContain(
      'desk is not running. Start it and its MCP server, then retry.'
    );
    nextPreview = makeHostPreview({ preview_id: 'preview-2' });
    el('custom-mcp-review-retry')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(calls[0]).toEqual({
      cmd: 'custom_mcp_preview',
      args: {
        project: CUSTOM_MCP_PROJECT,
        source: { kind: 'host', name: 'desk', port: 3845, path: '/mcp' },
      },
    });
    expect(el('custom-mcp-review-not-running')).toBeNull();
  });

  it('organization-forced fields disable the radios and show the pill', async () => {
    await mount(
      makeNpmPreview({
        forced: { ...noForced(), pii_mode: 'tokens', workspace_mode_max: 'read_only' },
      })
    );
    expect(el('custom-mcp-review-pii-forced')?.textContent).toContain('Enforced by organization');
    expect(input('custom-mcp-review-pii-plaintext').disabled).toBe(true);
    expect(input('custom-mcp-review-pii-tokens').disabled).toBe(true);
    expect(el('custom-mcp-review-files-forced')?.textContent).toContain('Enforced by organization');
    expect(input('custom-mcp-review-files-read_write').disabled).toBe(true);
    expect(input('custom-mcp-review-files-read_only').disabled).toBe(false);
  });

  it('a forced plaintext mode is pre-selected', async () => {
    await mount(makeNpmPreview({ forced: { ...noForced(), pii_mode: 'plaintext' } }));
    expect(input('custom-mcp-review-pii-plaintext').checked).toBe(true);
  });

  it('approve sends the choices and only filled credentials, then reports the name', async () => {
    await mount(makeNpmPreview());
    const field = input('custom-mcp-review-env-FIGMA_API_KEY');
    field.value = 'secret-123';
    field.dispatchEvent(new Event('input'));
    await check('custom-mcp-review-pii-plaintext');
    el('custom-mcp-review-approve')!.click();
    await fixture.whenStable();
    expect(calls[0]).toEqual({
      cmd: 'custom_mcp_approve',
      args: {
        project: CUSTOM_MCP_PROJECT,
        previewId: 'preview-1',
        choices: {
          name: 'figma',
          pii_mode: 'plaintext',
          workspace_mode: 'none',
          env_values: { FIGMA_API_KEY: 'secret-123' },
        },
      },
    });
    expect(approvedNames).toEqual(['figma']);
  });

  it('an empty credential is not sent', async () => {
    await mount(makeNpmPreview());
    el('custom-mcp-review-approve')!.click();
    await fixture.whenStable();
    expect((calls[0].args?.['choices'] as { env_values: unknown }).env_values).toEqual({});
  });

  it('a refused approval stays open with the error', async () => {
    approveError = 'a server named figma is already configured';
    await mount(makeNpmPreview());
    el('custom-mcp-review-approve')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el('custom-mcp-review-error')?.textContent).toContain('already configured');
    expect(approvedNames).toEqual([]);
  });

  it('cancel closes without a call', async () => {
    await mount(makeNpmPreview());
    el('custom-mcp-review-cancel')!.click();
    expect(closedCount).toBe(1);
    expect(calls).toEqual([]);
  });

  it('labels repository proposals and renders their strings as text', async () => {
    const preview = makeNpmPreview({ proposed_by_repo: true });
    if (preview.details.kind !== 'npm') throw new Error('npm fixture');
    preview.details.args = ['<script>alert(1)</script>', 'x'.repeat(500)];
    await mount(preview);
    expect(el('custom-mcp-review-proposed')?.textContent).toContain('proposed by repository file');
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(el('custom-mcp-review-args')?.textContent).toContain('<script>');
    expect(el('custom-mcp-review-args')?.textContent?.length).toBeLessThan(400);
  });
});
