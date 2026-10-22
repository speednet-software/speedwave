import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CustomMcpService } from './custom-mcp.service';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { createDeferred } from '../testing/deferred';
import type { CustomMcpList, CustomMcpTool } from '../models/custom-mcp';
import {
  CUSTOM_MCP_PROJECT,
  makeList,
  makeNpmEntry,
  makeTool,
} from '../testing/custom-mcp-fixtures';

describe('CustomMcpService', () => {
  let service: CustomMcpService;
  let mockTauri: MockTauriService;
  let projectState: ProjectStateService;
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  let list: CustomMcpList;

  beforeEach(() => {
    calls = [];
    list = makeList([makeNpmEntry()]);
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'custom_mcp_get') return structuredClone(list);
      if (cmd === 'custom_mcp_set_tools') return makeNpmEntry({ tools: [] });
      return undefined;
    };
    TestBed.configureTestingModule({ providers: [{ provide: TauriService, useValue: mockTauri }] });
    projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set(CUSTOM_MCP_PROJECT);
    projectState.status.set('ready');
    service = TestBed.inject(CustomMcpService);
  });

  function commands(): string[] {
    return calls.map((c) => c.cmd);
  }

  describe('refresh', () => {
    it('exposes the servers of the project it listed', async () => {
      await service.refresh(CUSTOM_MCP_PROJECT);
      expect(calls[0]).toEqual({ cmd: 'custom_mcp_get', args: { project: CUSTOM_MCP_PROJECT } });
      expect(service.entries().map((e) => e.name)).toEqual(['figma']);
      expect(service.project()).toBe(CUSTOM_MCP_PROJECT);
      expect(service.loading()).toBe(false);
      expect(service.error()).toBe('');
    });

    it('reports the organization switch', async () => {
      list = makeList([], { managed_disabled: true });
      await service.refresh(CUSTOM_MCP_PROJECT);
      expect(service.managedDisabled()).toBe(true);
    });

    it('drops a response for a project that is no longer active', async () => {
      const gate = createDeferred<CustomMcpList>();
      mockTauri.invokeHandler = async () => gate.promise;
      const pending = service.refresh(CUSTOM_MCP_PROJECT);
      projectState.activeProject.set('other');
      gate.resolve(makeList([makeNpmEntry()]));
      await pending;
      expect(service.entries()).toEqual([]);
      expect(service.loading()).toBe(false);
    });

    it('drops an older response that lands after a newer one', async () => {
      const first = createDeferred<CustomMcpList>();
      const second = createDeferred<CustomMcpList>();
      const queue = [first, second];
      mockTauri.invokeHandler = async () => queue.shift()!.promise;
      const a = service.refresh(CUSTOM_MCP_PROJECT);
      const b = service.refresh(CUSTOM_MCP_PROJECT);
      second.resolve(makeList([makeNpmEntry({ name: 'newer' })]));
      await b;
      first.resolve(makeList([makeNpmEntry({ name: 'older' })]));
      await a;
      expect(service.entries().map((e) => e.name)).toEqual(['newer']);
    });

    it('clears the list of another project before the new one lands', async () => {
      await service.refresh(CUSTOM_MCP_PROJECT);
      const gate = createDeferred<CustomMcpList>();
      mockTauri.invokeHandler = async () => gate.promise;
      projectState.activeProject.set('other');
      const pending = service.refresh('other');
      expect(service.entries()).toEqual([]);
      gate.resolve(makeList([], { project: 'other' }));
      await pending;
      expect(service.project()).toBe('other');
    });

    it('surfaces an error of the active project', async () => {
      mockTauri.invokeHandler = async () => {
        throw 'config unreadable';
      };
      await service.refresh(CUSTOM_MCP_PROJECT);
      expect(service.error()).toBe('config unreadable');
      expect(service.loading()).toBe(false);
    });

    it('ignores an error of a project that is no longer active', async () => {
      const gate = createDeferred<CustomMcpList>();
      mockTauri.invokeHandler = async () => gate.promise;
      const pending = service.refresh(CUSTOM_MCP_PROJECT);
      projectState.activeProject.set('other');
      gate.reject('late failure');
      await pending;
      expect(service.error()).toBe('');
    });
  });

  describe('restart after consented changes', () => {
    beforeEach(async () => {
      await service.refresh(CUSTOM_MCP_PROJECT);
      calls = [];
    });

    async function restartedWith(): Promise<unknown> {
      expect(projectState.needsRestart).toBe(true);
      await projectState.restartContainers(CUSTOM_MCP_PROJECT);
      return calls.find((c) => c.cmd === 'restart_integration_containers')?.args;
    }

    it('approve sends the choices field by field and restarts with the server id', async () => {
      await service.approve(CUSTOM_MCP_PROJECT, 'preview-1', {
        name: 'figma',
        pii_mode: 'tokens',
        workspace_mode: 'read_only',
        env_values: { FIGMA_API_KEY: 'secret' },
        extra: 'dropped',
      } as never);
      expect(calls[0]).toEqual({
        cmd: 'custom_mcp_approve',
        args: {
          project: CUSTOM_MCP_PROJECT,
          previewId: 'preview-1',
          choices: {
            name: 'figma',
            pii_mode: 'tokens',
            workspace_mode: 'read_only',
            env_values: { FIGMA_API_KEY: 'secret' },
          },
        },
      });
      expect(await restartedWith()).toEqual({
        project: CUSTOM_MCP_PROJECT,
        justEnabled: 'custom-figma',
      });
    });

    it('approve of a server the list does not show yet names it by the service prefix', async () => {
      list = makeList([]);
      await service.approve(CUSTOM_MCP_PROJECT, 'preview-1', {
        name: 'linear',
        pii_mode: 'tokens',
        workspace_mode: 'none',
        env_values: {},
      });
      expect(await restartedWith()).toEqual({
        project: CUSTOM_MCP_PROJECT,
        justEnabled: 'custom-linear',
      });
    });

    it('a PII mode loosened to plaintext only requests the restart, with the server id', async () => {
      await service.setPiiMode(CUSTOM_MCP_PROJECT, 'figma', 'plaintext');
      expect(calls[0]).toEqual({
        cmd: 'custom_mcp_set_pii_mode',
        args: { project: CUSTOM_MCP_PROJECT, name: 'figma', piiMode: 'plaintext' },
      });
      expect(commands()).not.toContain('restart_integration_containers');
      expect(projectState.restarting).toBe(false);
      expect(projectState.pendingJustEnabled).toBe('custom-figma');
      expect(await restartedWith()).toEqual({
        project: CUSTOM_MCP_PROJECT,
        justEnabled: 'custom-figma',
      });
    });

    it('a file access change restarts with the server id', async () => {
      await service.setFileAccess(CUSTOM_MCP_PROJECT, 'figma', 'read_write');
      expect(calls[0]).toEqual({
        cmd: 'custom_mcp_set_file_access',
        args: { project: CUSTOM_MCP_PROJECT, name: 'figma', workspaceMode: 'read_write' },
      });
      expect(await restartedWith()).toEqual({
        project: CUSTOM_MCP_PROJECT,
        justEnabled: 'custom-figma',
      });
    });

    it('a toggle restarts with the server id', async () => {
      await service.setEnabled(CUSTOM_MCP_PROJECT, 'figma', false);
      expect(calls[0]).toEqual({
        cmd: 'custom_mcp_set_enabled',
        args: { project: CUSTOM_MCP_PROJECT, name: 'figma', enabled: false },
      });
      expect(await restartedWith()).toEqual({
        project: CUSTOM_MCP_PROJECT,
        justEnabled: 'custom-figma',
      });
    });

    it('a change saved while a switch runs does not mark the server for the other project', async () => {
      projectState.status.set('switching');
      await service.setEnabled(CUSTOM_MCP_PROJECT, 'figma', true);
      expect(projectState.pendingJustEnabled).toBeNull();
    });

    it('a failed write requests no restart', async () => {
      mockTauri.invokeHandler = async (cmd) => {
        if (cmd === 'custom_mcp_set_pii_mode') throw 'your organization sets the mode';
        return undefined;
      };
      await expect(service.setPiiMode(CUSTOM_MCP_PROJECT, 'figma', 'plaintext')).rejects.toBe(
        'your organization sets the mode'
      );
      expect(projectState.needsRestart).toBe(false);
      expect(projectState.pendingJustEnabled).toBeNull();
    });
  });

  describe('PII mode tightened to tokens', () => {
    beforeEach(async () => {
      list = makeList([makeNpmEntry({ pii_mode: 'plaintext' })]);
      await service.refresh(CUSTOM_MCP_PROJECT);
      calls = [];
    });

    it('restarts the containers at once with the server id, without a prompt', async () => {
      let restartingDuringCall = false;
      let justEnabledDuringCall: unknown;
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) => {
        if (cmd === 'restart_integration_containers') {
          restartingDuringCall = projectState.restarting;
          justEnabledDuringCall = args?.['justEnabled'];
        }
        return base(cmd, args);
      };
      await service.setPiiMode(CUSTOM_MCP_PROJECT, 'figma', 'tokens');
      expect(commands().slice(0, 3)).toEqual([
        'custom_mcp_set_pii_mode',
        'custom_mcp_get',
        'restart_integration_containers',
      ]);
      expect(calls[0].args).toEqual({
        project: CUSTOM_MCP_PROJECT,
        name: 'figma',
        piiMode: 'tokens',
      });
      expect(calls[2].args).toEqual({ project: CUSTOM_MCP_PROJECT, justEnabled: 'custom-figma' });
      expect(restartingDuringCall).toBe(true);
      expect(justEnabledDuringCall).toBe('custom-figma');
      expect(projectState.restarting).toBe(false);
      expect(projectState.needsRestart).toBe(false);
      expect(projectState.pendingJustEnabled).toBeNull();
    });

    it('a failed restart raises the restart prompt with its error', async () => {
      const base = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd, args) => {
        const answer = base(cmd, args);
        if (cmd === 'restart_integration_containers') throw new Error('compose up failed');
        return answer;
      };
      await service.setPiiMode(CUSTOM_MCP_PROJECT, 'figma', 'tokens');
      expect(commands()).toContain('restart_integration_containers');
      expect(projectState.restartError).toBe('compose up failed');
      expect(projectState.needsRestart).toBe(true);
      expect(projectState.restarting).toBe(false);
    });

    it('a restart already running leaves the change to the restart prompt', async () => {
      projectState.restarting = true;
      await service.setPiiMode(CUSTOM_MCP_PROJECT, 'figma', 'tokens');
      expect(commands()).not.toContain('restart_integration_containers');
      expect(projectState.needsRestart).toBe(true);
    });

    it('a project that is not running only requests the restart', async () => {
      projectState.status.set('starting');
      await service.setPiiMode(CUSTOM_MCP_PROJECT, 'figma', 'tokens');
      expect(commands()).not.toContain('restart_integration_containers');
      expect(projectState.restarting).toBe(false);
    });

    it('a change saved while a switch runs restarts nothing', async () => {
      projectState.status.set('switching');
      await service.setPiiMode(CUSTOM_MCP_PROJECT, 'figma', 'tokens');
      expect(commands()).not.toContain('restart_integration_containers');
      expect(projectState.pendingJustEnabled).toBeNull();
    });

    it('a failed write restarts nothing and does not reload', async () => {
      mockTauri.invokeHandler = async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'custom_mcp_set_pii_mode') throw 'your organization sets the mode';
        return undefined;
      };
      await expect(service.setPiiMode(CUSTOM_MCP_PROJECT, 'figma', 'tokens')).rejects.toBe(
        'your organization sets the mode'
      );
      expect(commands()).toEqual(['custom_mcp_set_pii_mode']);
      expect(projectState.needsRestart).toBe(false);
      expect(projectState.restarting).toBe(false);
      expect(projectState.pendingJustEnabled).toBeNull();
    });
  });

  describe('hot updates', () => {
    beforeEach(async () => {
      await service.refresh(CUSTOM_MCP_PROJECT);
      calls = [];
    });

    it('tool decisions go out field by field and replace the server, without a restart', async () => {
      const tool: CustomMcpTool = makeTool('post_comment');
      await service.setTools(CUSTOM_MCP_PROJECT, 'figma', [{ ...tool, state: 'allowed' } as never]);
      expect(calls[0]).toEqual({
        cmd: 'custom_mcp_set_tools',
        args: {
          project: CUSTOM_MCP_PROJECT,
          name: 'figma',
          decisions: [
            {
              upstream_name: 'post_comment',
              state: 'allowed',
              definition_hash: 'hash-post_comment',
            },
          ],
        },
      });
      expect(service.entries()[0].tools).toEqual([]);
      expect(projectState.needsRestart).toBe(false);
    });

    it('a stale tool decision rejects with the backend message', async () => {
      mockTauri.invokeHandler = async () => {
        throw "tool 'post_comment' changed since you reviewed it; review it again";
      };
      await expect(service.setTools(CUSTOM_MCP_PROJECT, 'figma', [])).rejects.toContain(
        'changed since you reviewed it'
      );
    });

    it('domains change without a restart', async () => {
      await service.allowDomain(CUSTOM_MCP_PROJECT, 'figma', 'cdn.figma.com', 443);
      await service.removeDomain(CUSTOM_MCP_PROJECT, 'figma', 'api.figma.com', 443);
      expect(calls.filter((c) => c.cmd !== 'custom_mcp_get')).toEqual([
        {
          cmd: 'custom_mcp_allow_domain',
          args: { project: CUSTOM_MCP_PROJECT, name: 'figma', host: 'cdn.figma.com', port: 443 },
        },
        {
          cmd: 'custom_mcp_remove_domain',
          args: { project: CUSTOM_MCP_PROJECT, name: 'figma', host: 'api.figma.com', port: 443 },
        },
      ]);
      expect(projectState.needsRestart).toBe(false);
    });

    it('blocked connections are read on request only, without reloading the list', async () => {
      await service.refresh(CUSTOM_MCP_PROJECT);
      expect(commands()).toEqual(['custom_mcp_get']);
      const summary = { container_running: true, hosts: [], other: [] };
      mockTauri.invokeHandler = async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'custom_mcp_egress_denials') return summary;
        throw new Error(`unexpected ${cmd}`);
      };
      expect(await service.egressDenials(CUSTOM_MCP_PROJECT, 'figma')).toEqual(summary);
      expect(calls.slice(1)).toEqual([
        {
          cmd: 'custom_mcp_egress_denials',
          args: { project: CUSTOM_MCP_PROJECT, name: 'figma' },
        },
      ]);
      expect(service.entries().map((e) => e.name)).toEqual(['figma']);
    });

    it('a failed read of blocked connections rejects with the backend message', async () => {
      mockTauri.invokeHandler = async () => {
        throw 'the container engine is not running';
      };
      await expect(service.egressDenials(CUSTOM_MCP_PROJECT, 'figma')).rejects.toBe(
        'the container engine is not running'
      );
      expect(service.error()).toBe('');
    });

    it('remove reloads and leaves the restart to the backend', async () => {
      await service.remove(CUSTOM_MCP_PROJECT, 'figma');
      expect(commands()).toEqual(['custom_mcp_remove', 'custom_mcp_get']);
      expect(projectState.needsRestart).toBe(false);
    });
  });

  describe('scan and preview', () => {
    it('scan names the project', async () => {
      await service.scanRepo(CUSTOM_MCP_PROJECT);
      expect(calls[0]).toEqual({
        cmd: 'custom_mcp_scan_repo',
        args: { project: CUSTOM_MCP_PROJECT },
      });
    });

    it('an npm preview request carries only the request fields', async () => {
      await service.preview(CUSTOM_MCP_PROJECT, {
        kind: 'npm',
        name: 'figma',
        package: 'figma-developer-mcp',
        version: '0.6.1',
        args: ['--stdio'],
        env_keys: ['FIGMA_API_KEY'],
        status: 'ready',
      } as never);
      expect(calls[0].args).toEqual({
        project: CUSTOM_MCP_PROJECT,
        source: {
          kind: 'npm',
          name: 'figma',
          package: 'figma-developer-mcp',
          version: '0.6.1',
          args: ['--stdio'],
          env_keys: ['FIGMA_API_KEY'],
        },
      });
    });

    it('a host preview request carries only the request fields', async () => {
      await service.preview(CUSTOM_MCP_PROJECT, {
        kind: 'host',
        name: 'desk',
        port: 3845,
        path: '/mcp',
      });
      expect(calls[0].args).toEqual({
        project: CUSTOM_MCP_PROJECT,
        source: { kind: 'host', name: 'desk', port: 3845, path: '/mcp' },
      });
    });
  });

  it('holds one add-server request until the section takes it', () => {
    expect(service.addServerRequested()).toBe(false);
    expect(service.consumeAddServerRequest()).toBe(false);
    service.requestAddServer();
    service.requestAddServer();
    expect(service.addServerRequested()).toBe(true);
    expect(service.consumeAddServerRequest()).toBe(true);
    expect(service.addServerRequested()).toBe(false);
    expect(service.consumeAddServerRequest()).toBe(false);
  });
});
