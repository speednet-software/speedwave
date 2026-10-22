import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  CustomMcpSectionComponent,
  parseEnvKeys,
  proposalSourceLabel,
} from './custom-mcp-section.component';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { CustomMcpService } from '../services/custom-mcp.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { createDeferred } from '../testing/deferred';
import type { CustomMcpList, CustomMcpProposal } from '../models/custom-mcp';
import {
  CUSTOM_MCP_PROJECT,
  makeHostEntry,
  makeList,
  makeNpmEntry,
  makeNpmPreview,
} from '../testing/custom-mcp-fixtures';

function proposal(over: Partial<CustomMcpProposal> = {}): CustomMcpProposal {
  return {
    key: 'figma',
    suggested_name: 'figma',
    source: { kind: 'npm', package: 'figma-developer-mcp', version: '0.6.1' },
    status: 'ready',
    args: ['--stdio'],
    env_keys: ['FIGMA_API_KEY'],
    refused_env_keys: [],
    builtin_integration: null,
    reason: null,
    configured_as: null,
    ...over,
  };
}

describe('section helpers', () => {
  it('splits credential names on commas and spaces', () => {
    expect(parseEnvKeys(' A_KEY, B_KEY  C ')).toEqual(['A_KEY', 'B_KEY', 'C']);
    expect(parseEnvKeys('')).toEqual([]);
  });

  it('describes proposal sources', () => {
    expect(proposalSourceLabel({ kind: 'npm', package: 'p', version: null })).toBe('npm p');
    expect(proposalSourceLabel({ kind: 'npm', package: 'p', version: '1.0.0' })).toBe(
      'npm p@1.0.0'
    );
    expect(proposalSourceLabel({ kind: 'remote', host: 'mcp.example.com' })).toBe(
      'remote mcp.example.com'
    );
    expect(proposalSourceLabel({ kind: 'unsupported', command: 'uvx' })).toBe('uvx');
  });
});

describe('CustomMcpSectionComponent', () => {
  let fixture: ComponentFixture<CustomMcpSectionComponent>;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let list: CustomMcpList;
  let scanResult: CustomMcpProposal[];

  beforeEach(async () => {
    calls = [];
    list = makeList([makeNpmEntry(), makeHostEntry({ state: 'pending', reason: 'not_approved' })]);
    scanResult = [];
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      switch (cmd) {
        case 'custom_mcp_get':
          return structuredClone(list);
        case 'custom_mcp_scan_repo':
          return scanResult;
        case 'custom_mcp_preview':
          return makeNpmPreview();
        default:
          return undefined;
      }
    };
    await TestBed.configureTestingModule({
      imports: [CustomMcpSectionComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();
    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set(CUSTOM_MCP_PROJECT);
    projectState.status.set('ready');
  });

  afterEach(() => {
    fixture?.destroy();
  });

  async function mount(project: string | null = CUSTOM_MCP_PROJECT): Promise<void> {
    fixture = TestBed.createComponent(CustomMcpSectionComponent);
    fixture.componentRef.setInput('project', project);
    fixture.detectChanges();
    await settle();
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  function el(testId: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
  }

  async function click(testId: string): Promise<void> {
    el(testId)!.click();
    await settle();
  }

  function type(testId: string, value: string): void {
    const input = el(testId) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('renders the servers the service lists', async () => {
    await mount();
    expect(el('custom-mcp-title')?.textContent).toContain('Custom MCP servers');
    expect(el('custom-mcp-row-figma')?.textContent).toContain('npm figma-developer-mcp@0.6.1');
    expect(el('custom-mcp-row-status-figma')?.textContent?.trim()).toBe('approved');
    expect(el('custom-mcp-row-tools-figma')?.textContent?.trim()).toBe('1/2');
    expect(el('custom-mcp-row-status-desk')?.textContent?.trim()).toBe('pending');
    expect(el('custom-mcp-row-tools-desk')?.textContent?.trim()).toBe('—');
    expect(el('custom-mcp-row-desk')?.textContent).toContain('host :3845 /mcp');
    expect(el('custom-mcp-empty')).toBeNull();
  });

  it('shows the empty state without servers', async () => {
    list = makeList([]);
    await mount();
    expect(el('custom-mcp-empty')?.textContent).toContain('No custom MCP servers.');
    expect(el('custom-mcp-scan')).not.toBeNull();
    expect(el('custom-mcp-add')).not.toBeNull();
  });

  it('collapses with the organization pill when the organization turned it off', async () => {
    list = makeList([], { managed_disabled: true });
    await mount();
    expect(el('custom-mcp-org-disabled')?.textContent).toContain('Disabled by your organization');
    expect(el('custom-mcp-scan')).toBeNull();
    expect(el('custom-mcp-add')).toBeNull();
    expect(el('custom-mcp-table')).toBeNull();
    expect(el('custom-mcp-empty')).toBeNull();
  });

  it('expands a row into its card and collapses it again', async () => {
    await mount();
    await click('custom-mcp-row-figma');
    expect(el('custom-mcp-expanded-figma')).not.toBeNull();
    expect(el('custom-mcp-card-figma')).not.toBeNull();
    await click('custom-mcp-row-figma');
    expect(el('custom-mcp-expanded-figma')).toBeNull();
  });

  it('a row toggle saves without expanding and restarts with the server id', async () => {
    await mount();
    calls = [];
    await click('custom-mcp-row-toggle-figma');
    expect(calls[0]).toEqual({
      cmd: 'custom_mcp_set_enabled',
      args: { project: CUSTOM_MCP_PROJECT, name: 'figma', enabled: false },
    });
    expect(el('custom-mcp-expanded-figma')).toBeNull();
    await projectState.restartContainers(CUSTOM_MCP_PROJECT);
    expect(calls.find((c) => c.cmd === 'restart_integration_containers')?.args).toEqual({
      project: CUSTOM_MCP_PROJECT,
      justEnabled: 'custom-figma',
    });
  });

  it('a refused toggle shows the error', async () => {
    await mount();
    mockTauri.invokeHandler = async () => {
      throw 'the container engine must run';
    };
    await click('custom-mcp-row-toggle-figma');
    expect(el('custom-mcp-error')?.textContent).toContain('engine must run');
  });

  it('scan lists proposals, labels them, and reviews only a ready one', async () => {
    scanResult = [
      proposal(),
      proposal({ key: 'linear', configured_as: 'linear' }),
      proposal({ key: 'gitlab', builtin_integration: 'gitlab' }),
      proposal({
        key: 'loose',
        status: 'needs_exact_version',
        source: { kind: 'npm', package: 'loose', version: null },
        reason: 'pin an exact version',
      }),
    ];
    await mount();
    await click('custom-mcp-scan');
    expect(el('custom-mcp-proposals')?.textContent).toContain('proposed by repository file');
    expect(el('custom-mcp-proposal-1')?.textContent).toContain('configured as linear');
    expect(el('custom-mcp-proposal-review-1')).toBeNull();
    expect(el('custom-mcp-proposal-2')?.textContent).toContain('built-in gitlab');
    expect(el('custom-mcp-proposal-review-2')).toBeNull();
    expect(el('custom-mcp-proposal-3')?.textContent).toContain('needs_exact_version');
    expect(el('custom-mcp-proposal-review-3')).toBeNull();
    expect(calls.some((c) => c.cmd === 'custom_mcp_preview')).toBe(false);

    type('custom-mcp-proposal-name-0', 'figma-repo');
    await click('custom-mcp-proposal-review-0');
    expect(calls.find((c) => c.cmd === 'custom_mcp_preview')?.args).toEqual({
      project: CUSTOM_MCP_PROJECT,
      source: {
        kind: 'npm',
        name: 'figma-repo',
        package: 'figma-developer-mcp',
        version: '0.6.1',
        args: ['--stdio'],
        env_keys: ['FIGMA_API_KEY'],
      },
    });
    expect(el('custom-mcp-review')).not.toBeNull();
  });

  it('a proposal without a valid name cannot be reviewed', async () => {
    scanResult = [proposal({ suggested_name: null })];
    await mount();
    await click('custom-mcp-scan');
    expect((el('custom-mcp-proposal-review-0') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when the repository proposes nothing', async () => {
    await mount();
    await click('custom-mcp-scan');
    expect(el('custom-mcp-proposals-empty')).not.toBeNull();
  });

  it('add server offers npm and host forms', async () => {
    await mount();
    await click('custom-mcp-add');
    await click('custom-mcp-add-host');
    expect(el('custom-mcp-host-form')).not.toBeNull();
    await click('custom-mcp-host-cancel');
    expect(el('custom-mcp-add-panel')).toBeNull();
  });

  it('the npm form validates and opens the review', async () => {
    await mount();
    await click('custom-mcp-add');
    await click('custom-mcp-add-npm');
    const submit = el('custom-mcp-npm-submit') as HTMLButtonElement;
    type('custom-mcp-npm-name', 'figma');
    type('custom-mcp-npm-package', 'figma-developer-mcp');
    type('custom-mcp-npm-version', '^0.6');
    expect(submit.disabled).toBe(true);
    expect(el('custom-mcp-npm-error')?.textContent).toContain('exact version');
    type('custom-mcp-npm-version', '0.6.1');
    type('custom-mcp-npm-env', 'FIGMA_API_KEY, bad-key');
    expect(submit.disabled).toBe(true);
    type('custom-mcp-npm-env', 'FIGMA_API_KEY');
    expect(submit.disabled).toBe(false);
    await click('custom-mcp-npm-submit');
    expect(calls.find((c) => c.cmd === 'custom_mcp_preview')?.args?.['source']).toEqual({
      kind: 'npm',
      name: 'figma',
      package: 'figma-developer-mcp',
      version: '0.6.1',
      args: [],
      env_keys: ['FIGMA_API_KEY'],
    });
    expect(el('custom-mcp-review')).not.toBeNull();
  });

  it('a refused review shows the error and opens nothing', async () => {
    await mount();
    await click('custom-mcp-add');
    await click('custom-mcp-add-npm');
    type('custom-mcp-npm-name', 'figma');
    type('custom-mcp-npm-package', 'figma-developer-mcp');
    type('custom-mcp-npm-version', '0.6.1');
    mockTauri.invokeHandler = async () => {
      throw 'the version is younger than 7 days';
    };
    await click('custom-mcp-npm-submit');
    expect(el('custom-mcp-error')?.textContent).toContain('younger than 7 days');
    expect(el('custom-mcp-review')).toBeNull();
  });

  it('an approval closes the review and expands the new server', async () => {
    await mount();
    fixture.componentInstance.openReview(makeNpmPreview());
    fixture.detectChanges();
    await click('custom-mcp-review-approve');
    expect(el('custom-mcp-review')).toBeNull();
    expect(fixture.componentInstance.expanded()).toBe('figma');
  });

  it('does not show the list of another project', async () => {
    await mount();
    const service = TestBed.inject(CustomMcpService);
    expect(service.project()).toBe(CUSTOM_MCP_PROJECT);
    fixture.componentRef.setInput('project', 'other');
    fixture.detectChanges();
    expect(el('custom-mcp-table')).toBeNull();
    expect(el('custom-mcp-empty')).not.toBeNull();
  });

  it('drops a response that lands after a project switch', async () => {
    const gate = createDeferred<CustomMcpList>();
    mockTauri.invokeHandler = async () => gate.promise;
    fixture = TestBed.createComponent(CustomMcpSectionComponent);
    fixture.componentRef.setInput('project', CUSTOM_MCP_PROJECT);
    fixture.detectChanges();
    projectState.activeProject.set('other');
    gate.resolve(list);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el('custom-mcp-table')).toBeNull();
  });

  it('reloads after a container restart', async () => {
    await mount();
    calls = [];
    projectState.notifyRestartComplete();
    await fixture.whenStable();
    expect(calls.map((c) => c.cmd)).toEqual(['custom_mcp_get']);
  });

  it('opens the add-server form when the command palette asks', async () => {
    TestBed.inject(CustomMcpService).requestAddServer();
    await mount();
    expect(el('custom-mcp-add-panel')).not.toBeNull();
    expect(TestBed.inject(CustomMcpService).addServerRequested()).toBe(false);
  });

  it('leaves a palette request for the section built for a known project', async () => {
    TestBed.inject(CustomMcpService).requestAddServer();
    await mount(null);
    expect(el('custom-mcp-add-panel')).toBeNull();
    expect(TestBed.inject(CustomMcpService).addServerRequested()).toBe(true);
  });

  it('makes no call before it knows its project', async () => {
    await mount(null);
    expect(calls).toEqual([]);
    expect((el('custom-mcp-add') as HTMLButtonElement).disabled).toBe(true);
  });
});
