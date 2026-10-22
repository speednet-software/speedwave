import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  CustomMcpHostFormComponent,
  hostPathError,
  hostPortError,
} from './custom-mcp-host-form.component';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { CustomMcpPreview } from '../models/custom-mcp';
import { CUSTOM_MCP_PROJECT, makeHostPreview } from '../testing/custom-mcp-fixtures';

describe('host form validation', () => {
  it('accepts ports 1024 to 65535 only', () => {
    expect(hostPortError('1024')).toBeNull();
    expect(hostPortError('65535')).toBeNull();
    expect(hostPortError('1023')).not.toBeNull();
    expect(hostPortError('65536')).not.toBeNull();
    expect(hostPortError('')).not.toBeNull();
    expect(hostPortError('80a')).not.toBeNull();
    expect(hostPortError('3845.5')).not.toBeNull();
  });

  it('accepts a path starting with a slash, without query, fragment or spaces', () => {
    expect(hostPathError('/mcp')).toBeNull();
    expect(hostPathError('/')).toBeNull();
    expect(hostPathError('mcp')).not.toBeNull();
    expect(hostPathError('/mcp?x=1')).not.toBeNull();
    expect(hostPathError('/mcp#x')).not.toBeNull();
    expect(hostPathError('/m cp')).not.toBeNull();
    expect(hostPathError('/m\r\ncp')).not.toBeNull();
    expect(hostPathError('/' + 'a'.repeat(300))).not.toBeNull();
  });
});

describe('CustomMcpHostFormComponent', () => {
  let fixture: ComponentFixture<CustomMcpHostFormComponent>;
  let mockTauri: MockTauriService;
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let previewed: CustomMcpPreview[];
  let previewError: string | null;

  beforeEach(async () => {
    calls = [];
    previewed = [];
    previewError = null;
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      if (previewError) throw previewError;
      return makeHostPreview();
    };
    await TestBed.configureTestingModule({
      imports: [CustomMcpHostFormComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();
    fixture = TestBed.createComponent(CustomMcpHostFormComponent);
    fixture.componentRef.setInput('project', CUSTOM_MCP_PROJECT);
    fixture.componentInstance.previewed.subscribe((p) => previewed.push(p));
    fixture.detectChanges();
  });

  function el(testId: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
  }

  function type(testId: string, value: string): void {
    const input = el(testId) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function submitDisabled(): boolean {
    return (el('custom-mcp-host-submit') as HTMLButtonElement).disabled;
  }

  function fillValid(): void {
    type('custom-mcp-host-name', 'desk');
    type('custom-mcp-host-port', '3845');
    type('custom-mcp-host-path', '/mcp');
  }

  it('shows the host warning banner', () => {
    expect(el('custom-mcp-host-form-warning')?.textContent).toContain(
      'Host server warning. Enabling a server that runs on this computer lets Claude reach every tool it exposes'
    );
  });

  it('blocks submit until the warning is confirmed', async () => {
    fillValid();
    expect(submitDisabled()).toBe(true);
    (el('custom-mcp-host-confirm') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(submitDisabled()).toBe(false);
  });

  it('blocks submit for an invalid field even when confirmed', () => {
    (el('custom-mcp-host-confirm') as HTMLInputElement).click();
    type('custom-mcp-host-name', 'Desk');
    type('custom-mcp-host-port', '80');
    expect(submitDisabled()).toBe(true);
    expect(el('custom-mcp-host-field-error')?.textContent).toContain('lowercase');
    type('custom-mcp-host-name', 'desk');
    expect(el('custom-mcp-host-field-error')?.textContent).toContain('1024');
    type('custom-mcp-host-port', '3845');
    type('custom-mcp-host-path', 'mcp');
    expect(el('custom-mcp-host-field-error')?.textContent).toContain("starts with '/'");
    expect(submitDisabled()).toBe(true);
  });

  it('submits a host review and hands it on', async () => {
    fillValid();
    (el('custom-mcp-host-confirm') as HTMLInputElement).click();
    fixture.detectChanges();
    el('custom-mcp-host-submit')!.click();
    await fixture.whenStable();
    expect(calls).toEqual([
      {
        cmd: 'custom_mcp_preview',
        args: {
          project: CUSTOM_MCP_PROJECT,
          source: { kind: 'host', name: 'desk', port: 3845, path: '/mcp' },
        },
      },
    ]);
    expect(previewed.map((p) => p.preview_id)).toEqual(['preview-host']);
  });

  it('shows a refused review', async () => {
    previewError = 'your organization turned off servers running on this computer';
    fillValid();
    (el('custom-mcp-host-confirm') as HTMLInputElement).click();
    fixture.detectChanges();
    el('custom-mcp-host-submit')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el('custom-mcp-host-error')?.textContent).toContain('turned off servers');
    expect(previewed).toEqual([]);
  });

  it('an organization switch disables the form with its pill', () => {
    fixture.componentRef.setInput('orgDisabled', true);
    fixture.detectChanges();
    expect(el('custom-mcp-host-form-org-disabled')?.textContent).toContain(
      'Disabled by your organization'
    );
    expect((el('custom-mcp-host-name') as HTMLInputElement).disabled).toBe(true);
    expect((el('custom-mcp-host-confirm') as HTMLInputElement).disabled).toBe(true);
    expect(submitDisabled()).toBe(true);
  });
});
