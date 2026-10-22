import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CustomMcpCardComponent } from './custom-mcp-card.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import type { CustomMcpEgressDenials, CustomMcpEntry } from '../models/custom-mcp';
import {
  CUSTOM_MCP_PROJECT,
  makeHostEntry,
  makeList,
  makeNpmEntry,
  noForced,
} from '../testing/custom-mcp-fixtures';

describe('CustomMcpCardComponent', () => {
  let fixture: ComponentFixture<CustomMcpCardComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let failing: Record<string, string>;
  let entry: CustomMcpEntry;
  let denialCalls: Record<string, unknown>[];
  let denials: unknown[];

  function blocked(over: Partial<CustomMcpEgressDenials> = {}): CustomMcpEgressDenials {
    return {
      container_running: true,
      hosts: [
        { host: 'cdn.figma.com', port: 443, count: 3, allowed_by_policy: true },
        { host: 'cdn.x.io', port: 443, count: 1, allowed_by_policy: false },
      ],
      other: [
        { reason: 'private_address', count: 2 },
        { reason: 'ip_literal', count: 1 },
      ],
      ...over,
    };
  }

  beforeEach(async () => {
    calls = [];
    failing = {};
    denialCalls = [];
    denials = [];
    entry = makeNpmEntry();
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd === 'custom_mcp_egress_denials') {
        denialCalls.push(args ?? {});
        const next = denials.length > 1 ? denials.shift() : denials[0];
        if (next instanceof Error) throw next;
        return next ?? blocked({ hosts: [], other: [] });
      }
      calls.push({ cmd, args });
      if (failing[cmd]) throw failing[cmd];
      if (cmd === 'custom_mcp_get') return makeList([entry]);
      return undefined;
    };
    await TestBed.configureTestingModule({
      imports: [CustomMcpCardComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();
    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set(CUSTOM_MCP_PROJECT);
    projectState.status.set('ready');
  });

  function mount(e: CustomMcpEntry): void {
    entry = e;
    fixture = TestBed.createComponent(CustomMcpCardComponent);
    fixture.componentRef.setInput('project', CUSTOM_MCP_PROJECT);
    fixture.componentRef.setInput('entry', e);
    fixture.detectChanges();
  }

  function el(testId: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
  }

  function input(testId: string): HTMLInputElement {
    return el(testId) as HTMLInputElement;
  }

  async function click(testId: string): Promise<void> {
    el(testId)!.click();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function sent(cmd: string): Record<string, unknown> | undefined {
    return calls.find((c) => c.cmd === cmd)?.args;
  }

  async function restartJustEnabled(): Promise<unknown> {
    expect(projectState.needsRestart).toBe(true);
    await projectState.restartContainers(CUSTOM_MCP_PROJECT);
    return sent('restart_integration_containers')?.['justEnabled'];
  }

  it('shows the server header, its tools and its domains', () => {
    mount(makeNpmEntry({ proposed_by_repo: true }));
    expect(el('custom-mcp-card-state')?.textContent?.trim()).toBe('approved');
    expect(el('custom-mcp-card-proposed')?.textContent).toContain('proposed by repository file');
    expect(el('custom-mcp-card-dot')?.textContent?.trim()).toBe('●');
    expect(el('custom-mcp-tools-table')).not.toBeNull();
    expect(el('custom-mcp-card-domains')?.textContent).toContain('api.figma.com:443');
    expect(el('custom-mcp-card-host-warning')).toBeNull();
    expect(input('custom-mcp-card-pii-tokens').checked).toBe(true);
  });

  it('says when the tool list is not available yet', () => {
    mount(makeNpmEntry({ tools_available: false, tools: [] }));
    expect(el('custom-mcp-card-no-tools')).not.toBeNull();
    expect(el('custom-mcp-tools-table')).toBeNull();
  });

  it('a host server shows the warning, has no internet list, and says when its app is down', async () => {
    mount(makeHostEntry({ host_app_available: false }));
    expect(el('custom-mcp-card-host-warning')?.textContent).toContain('Host server warning.');
    expect(el('custom-mcp-card-dot')?.textContent?.trim()).toBe('◐');
    expect(el('custom-mcp-card-domains')).toBeNull();
    expect(el('custom-mcp-card-not-running')?.textContent).toContain(
      'desk is not running. Start it and its MCP server, then retry.'
    );
    await click('custom-mcp-card-retry');
    expect(calls.map((c) => c.cmd)).toEqual(['custom_mcp_get']);
  });

  it('shows the exclusion reason as text', () => {
    mount(makeNpmEntry({ state: 'pending', reason: 'not_approved' }));
    expect(el('custom-mcp-card-reason')?.textContent).toContain('Waiting for your approval.');
  });

  it('organization-forced fields disable the radios and show the pill', () => {
    mount(
      makeNpmEntry({
        forced: {
          ...noForced(),
          pii_mode: 'tokens',
          workspace_mode_max: 'read_only',
          allowed_domains: ['*.figma.com'],
        },
      })
    );
    expect(el('custom-mcp-card-pii-forced')?.textContent).toContain('Enforced by organization');
    expect(input('custom-mcp-card-pii-plaintext').disabled).toBe(true);
    expect(el('custom-mcp-card-files-forced')?.textContent).toContain('Enforced by organization');
    expect(input('custom-mcp-card-files-read_write').disabled).toBe(true);
    expect(input('custom-mcp-card-files-read_only').disabled).toBe(false);
    expect(el('custom-mcp-card-domains-forced')).not.toBeNull();
  });

  it('a host server the organization turned off shows the pill and cannot be toggled', () => {
    mount(makeHostEntry({ forced: { ...noForced(), host_servers_disabled: true } }));
    expect(el('custom-mcp-card-host-org-disabled')?.textContent).toContain(
      'Disabled by your organization'
    );
    expect((el('custom-mcp-card-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the toggle saves and restarts with the server id', async () => {
    mount(makeNpmEntry());
    await click('custom-mcp-card-toggle');
    expect(sent('custom_mcp_set_enabled')).toEqual({
      project: CUSTOM_MCP_PROJECT,
      name: 'figma',
      enabled: false,
    });
    expect(await restartJustEnabled()).toBe('custom-figma');
  });

  it('a PII change to tokens saves and restarts at once with the server id', async () => {
    mount(makeNpmEntry({ pii_mode: 'plaintext' }));
    await click('custom-mcp-card-pii-tokens');
    expect(sent('custom_mcp_set_pii_mode')).toEqual({
      project: CUSTOM_MCP_PROJECT,
      name: 'figma',
      piiMode: 'tokens',
    });
    expect(sent('restart_integration_containers')).toEqual({
      project: CUSTOM_MCP_PROJECT,
      justEnabled: 'custom-figma',
    });
    expect(projectState.needsRestart).toBe(false);
    expect(el('custom-mcp-card-error')).toBeNull();
  });

  it('a PII change to plaintext saves and asks to restart with the server id', async () => {
    mount(makeNpmEntry());
    await click('custom-mcp-card-pii-plaintext');
    expect(sent('custom_mcp_set_pii_mode')).toEqual({
      project: CUSTOM_MCP_PROJECT,
      name: 'figma',
      piiMode: 'plaintext',
    });
    expect(sent('restart_integration_containers')).toBeUndefined();
    expect(await restartJustEnabled()).toBe('custom-figma');
  });

  it('a refused PII change shows the error and the saved mode again', async () => {
    failing['custom_mcp_set_pii_mode'] = 'your organization sets the personal data mode';
    mount(makeNpmEntry());
    await click('custom-mcp-card-pii-plaintext');
    expect(el('custom-mcp-card-error')?.textContent).toContain('organization');
    expect(input('custom-mcp-card-pii-tokens').checked).toBe(true);
    expect(input('custom-mcp-card-pii-plaintext').checked).toBe(false);
    expect(projectState.needsRestart).toBe(false);
  });

  it('more file access waits for its confirmations, then saves and restarts', async () => {
    mount(makeNpmEntry());
    await click('custom-mcp-card-files-read_write');
    expect(sent('custom_mcp_set_file_access')).toBeUndefined();
    const apply = el('custom-mcp-card-files-apply') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    await click('custom-mcp-card-files-confirm-0');
    expect(apply.disabled).toBe(true);
    await click('custom-mcp-card-files-confirm-1');
    expect(apply.disabled).toBe(false);
    await click('custom-mcp-card-files-apply');
    expect(sent('custom_mcp_set_file_access')).toEqual({
      project: CUSTOM_MCP_PROJECT,
      name: 'figma',
      workspaceMode: 'read_write',
    });
    expect(await restartJustEnabled()).toBe('custom-figma');
  });

  it('cancelling a file access pick shows the saved one again', async () => {
    mount(makeNpmEntry());
    await click('custom-mcp-card-files-read_only');
    await click('custom-mcp-card-files-cancel');
    expect(input('custom-mcp-card-files-none').checked).toBe(true);
    expect(el('custom-mcp-card-files-apply')).toBeNull();
  });

  it('less file access applies at once', async () => {
    mount(makeNpmEntry({ workspace_mode: 'read_write' }));
    await click('custom-mcp-card-files-none');
    expect(sent('custom_mcp_set_file_access')?.['workspaceMode']).toBe('none');
  });

  it('a refused file access change shows the saved one again', async () => {
    failing['custom_mcp_set_file_access'] = 'the container engine is not running';
    mount(makeNpmEntry({ workspace_mode: 'read_write' }));
    await click('custom-mcp-card-files-none');
    expect(el('custom-mcp-card-error')?.textContent).toContain('engine');
    expect(input('custom-mcp-card-files-read_write').checked).toBe(true);
    expect(input('custom-mcp-card-files-none').checked).toBe(false);
  });

  it('domains change without a restart', async () => {
    mount(makeNpmEntry());
    const field = input('custom-mcp-card-domain-input');
    field.value = 'CDN.Figma.com';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await click('custom-mcp-card-domain-allow');
    expect(sent('custom_mcp_allow_domain')).toEqual({
      project: CUSTOM_MCP_PROJECT,
      name: 'figma',
      host: 'cdn.figma.com',
      port: 443,
    });
    await click('custom-mcp-card-domain-remove-api.figma.com:443');
    expect(sent('custom_mcp_remove_domain')).toEqual({
      project: CUSTOM_MCP_PROJECT,
      name: 'figma',
      host: 'api.figma.com',
      port: 443,
    });
    expect(projectState.needsRestart).toBe(false);
  });

  it('a malformed domain is refused before any call', async () => {
    mount(makeNpmEntry());
    const field = input('custom-mcp-card-domain-input');
    field.value = 'not a host';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await click('custom-mcp-card-domain-allow');
    expect(calls).toEqual([]);
    expect(el('custom-mcp-card-error')?.textContent).toContain('host name');
  });

  it('marks domains the organization blocks', () => {
    mount(makeNpmEntry({ domains_blocked_by_policy: ['cdn.example.com:443'] }));
    expect(el('custom-mcp-card-domain-blocked-cdn.example.com:443')?.textContent).toContain(
      'Blocked by your organization'
    );
  });

  it('removal asks for confirmation and leaves the restart to the backend', async () => {
    mount(makeNpmEntry());
    await click('custom-mcp-card-remove');
    expect(calls).toEqual([]);
    await click('custom-mcp-card-remove-confirm');
    expect(calls.map((c) => c.cmd)).toEqual(['custom_mcp_remove', 'custom_mcp_get']);
    expect(projectState.needsRestart).toBe(false);
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function hostRows(): string[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="custom-mcp-card-blocked-host"]'),
      (li: Element) => Array.from(li.children, (child) => child.textContent?.trim() ?? '').join(' ')
    );
  }

  it('lists the blocked connections of an npm server when it opens', async () => {
    denials = [blocked()];
    mount(makeNpmEntry());
    await settle();
    expect(denialCalls).toEqual([{ project: CUSTOM_MCP_PROJECT, name: 'figma' }]);
    expect(el('custom-mcp-card-blocked')?.textContent).toContain(
      'Blocked connections (since last start)'
    );
    expect(el('custom-mcp-card-blocked-help')?.textContent).toContain(
      'These hosts were requested by the server. Allow only domains you recognize.'
    );
    expect(hostRows()).toEqual([
      'cdn.figma.com:443 ×3 $ allow',
      'cdn.x.io:443 ×1 Blocked by your organization',
    ]);
    expect(el('custom-mcp-card-blocked-allow-cdn.x.io:443')).toBeNull();
    expect(el('custom-mcp-card-blocked-org-cdn.x.io:443')).not.toBeNull();
    expect(el('custom-mcp-card-blocked-other')?.textContent).toContain(
      'Other refused: private address ×2, IP literal ×1'
    );
    expect(calls).toEqual([]);
  });

  it('allow saves the domain without a restart and reads the refusals again', async () => {
    denials = [blocked(), blocked({ hosts: [blocked().hosts[1]] })];
    mount(makeNpmEntry());
    await settle();
    await click('custom-mcp-card-blocked-allow-cdn.figma.com:443');
    await settle();
    expect(sent('custom_mcp_allow_domain')).toEqual({
      project: CUSTOM_MCP_PROJECT,
      name: 'figma',
      host: 'cdn.figma.com',
      port: 443,
    });
    expect(calls.map((c) => c.cmd)).toEqual(['custom_mcp_allow_domain', 'custom_mcp_get']);
    expect(denialCalls).toHaveLength(2);
    expect(hostRows()).toEqual(['cdn.x.io:443 ×1 Blocked by your organization']);
    expect(projectState.needsRestart).toBe(false);
  });

  it('a refused allow shows the error and keeps the row', async () => {
    failing['custom_mcp_allow_domain'] = 'your organization does not allow servers to reach it';
    denials = [blocked()];
    mount(makeNpmEntry());
    await settle();
    await click('custom-mcp-card-blocked-allow-cdn.figma.com:443');
    await settle();
    expect(el('custom-mcp-card-error')?.textContent).toContain('organization');
    expect(denialCalls).toHaveLength(1);
    expect(hostRows()).toHaveLength(2);
  });

  it('says when nothing was blocked and when the server is not running', async () => {
    denials = [blocked({ hosts: [], other: [] })];
    mount(makeNpmEntry());
    await settle();
    expect(el('custom-mcp-card-blocked-empty')?.textContent).toContain(
      'No blocked connections since the server last started.'
    );
    expect(el('custom-mcp-card-blocked-help')).toBeNull();
    expect(el('custom-mcp-card-blocked-proxy-note')?.textContent).toContain(
      'ignores proxy settings'
    );
    denials = [{ container_running: false, hosts: [], other: [] }];
    await click('custom-mcp-card-blocked-refresh');
    await settle();
    expect(el('custom-mcp-card-blocked-not-running')).not.toBeNull();
    expect(el('custom-mcp-card-blocked-empty')).toBeNull();
    expect(denialCalls).toHaveLength(2);
  });

  it('only other refusals show without the host list', async () => {
    denials = [blocked({ hosts: [] })];
    mount(makeNpmEntry());
    await settle();
    expect(hostRows()).toEqual([]);
    expect(el('custom-mcp-card-blocked-help')).toBeNull();
    expect(el('custom-mcp-card-blocked-other')).not.toBeNull();
  });

  it('a failed read shows the error and refresh recovers', async () => {
    denials = [new Error('the container engine is not running'), blocked()];
    mount(makeNpmEntry());
    await settle();
    expect(el('custom-mcp-card-blocked-error')?.textContent).toContain(
      'Could not read the blocked connections: the container engine is not running'
    );
    expect(hostRows()).toEqual([]);
    await click('custom-mcp-card-blocked-refresh');
    await settle();
    expect(el('custom-mcp-card-blocked-error')).toBeNull();
    expect(hostRows()).toHaveLength(2);
  });

  it('an answer that is not a summary shows as an error', async () => {
    denials = ['nonsense'];
    mount(makeNpmEntry());
    await settle();
    expect(el('custom-mcp-card-blocked-error')).not.toBeNull();
  });

  it('a host server has no blocked connections section and reads none', async () => {
    mount(makeHostEntry());
    await settle();
    expect(el('custom-mcp-card-blocked')).toBeNull();
    expect(denialCalls).toEqual([]);
  });

  it('opening another server reads its refusals, a list reload does not', async () => {
    denials = [blocked()];
    mount(makeNpmEntry());
    await settle();
    fixture.componentRef.setInput('entry', makeNpmEntry({ warnings: ['reloaded'] }));
    await settle();
    expect(denialCalls).toHaveLength(1);
    fixture.componentRef.setInput(
      'entry',
      makeNpmEntry({ name: 'linear', service_id: 'custom-linear' })
    );
    await settle();
    expect(denialCalls).toEqual([
      { project: CUSTOM_MCP_PROJECT, name: 'figma' },
      { project: CUSTOM_MCP_PROJECT, name: 'linear' },
    ]);
  });

  it('renders refused hosts as text', async () => {
    denials = [
      blocked({
        hosts: [{ host: '<b>evil</b>.example.com', port: 443, count: 1, allowed_by_policy: true }],
      }),
    ];
    mount(makeNpmEntry());
    await settle();
    expect(
      fixture.nativeElement.querySelector('[data-testid="custom-mcp-card-blocked"] b')
    ).toBeNull();
    expect(hostRows()[0]).toContain('<b>evil</b>.example.com:443');
  });

  it('renders server strings as text', () => {
    mount(makeNpmEntry({ warnings: ['<img src=x onerror=alert(1)>'] }));
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(el('custom-mcp-card-warning')?.textContent).toContain('<img');
  });
});
