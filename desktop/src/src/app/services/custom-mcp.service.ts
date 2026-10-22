import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import type {
  CustomMcpApproveChoices,
  CustomMcpEgressDenials,
  CustomMcpEntry,
  CustomMcpList,
  CustomMcpPreview,
  CustomMcpPreviewRequest,
  CustomMcpProposal,
  CustomMcpToolDecision,
  CustomPiiMode,
  CustomWorkspaceMode,
} from '../models/custom-mcp';
import { CUSTOM_MCP_SERVICE_PREFIX, errorText } from '../custom-mcp/custom-mcp-text';

/**
 * Custom MCP servers of the active project (ADR-100..103): the list the backend reports, and a
 * wrapper for every `custom_mcp_*` command. A response for a project that is no longer active,
 * or older than a later refresh, is dropped. Changes to consented fields restart the containers
 * naming the server as just enabled, so a failed restart turns it off: a PII mode tightened to
 * `tokens` restarts at once, every other change asks first.
 */
@Injectable({ providedIn: 'root' })
export class CustomMcpService {
  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly list = signal<CustomMcpList | null>(null);
  private readonly addServerSignal = signal(false);
  private generation = 0;

  /** Servers of the project the last accepted response belongs to. */
  readonly entries = computed<CustomMcpEntry[]>(() => this.list()?.servers ?? []);
  /** The project `entries` belongs to, `null` before the first response. */
  readonly project = computed<string | null>(() => this.list()?.project ?? null);
  /** Whether the organization turned Custom MCP servers off. */
  readonly managedDisabled = computed<boolean>(() => this.list()?.managed_disabled ?? false);
  /** True while a refresh runs. */
  readonly loading = signal(false);
  /** The last refresh error, empty when it succeeded. */
  readonly error = signal('');
  /** True while a request to open the add-server form waits for the section. */
  readonly addServerRequested: Signal<boolean> = this.addServerSignal.asReadonly();

  /** Asks the Custom MCP section to open its add-server form, now or once it is shown. */
  requestAddServer(): void {
    this.addServerSignal.set(true);
  }

  /** Takes the pending add-server request; `true` when there was one. */
  consumeAddServerRequest(): boolean {
    const pending = this.addServerSignal();
    this.addServerSignal.set(false);
    return pending;
  }

  /**
   * Reloads the servers of `project`, dropping the answer when another refresh started since or
   * the project is no longer active.
   * @param project - the project to list
   */
  async refresh(project: string): Promise<void> {
    const gen = ++this.generation;
    if (this.list()?.project !== project) this.list.set(null);
    this.loading.set(true);
    try {
      const res = await this.tauri.invoke<CustomMcpList>('custom_mcp_get', { project });
      if (!this.accepts(project, gen)) return;
      this.list.set(res);
      this.error.set('');
    } catch (e: unknown) {
      if (this.accepts(project, gen)) this.error.set(errorText(e));
    } finally {
      if (gen === this.generation) this.loading.set(false);
    }
  }

  /**
   * Servers the project's `.mcp.json` proposes; nothing is enabled by a proposal.
   * @param project - the project to scan
   */
  scanRepo(project: string): Promise<CustomMcpProposal[]> {
    return this.tauri.invoke<CustomMcpProposal[]>('custom_mcp_scan_repo', { project });
  }

  /**
   * Starts a review: resolves and pins an npm package or probes a host server.
   * @param project - the project the server is for
   * @param source - what to review, built field by field (the backend denies unknown fields)
   */
  preview(project: string, source: CustomMcpPreviewRequest): Promise<CustomMcpPreview> {
    const wire: CustomMcpPreviewRequest =
      source.kind === 'npm'
        ? {
            kind: 'npm',
            name: source.name,
            package: source.package,
            version: source.version,
            args: [...source.args],
            env_keys: [...source.env_keys],
          }
        : { kind: 'host', name: source.name, port: source.port, path: source.path };
    return this.tauri.invoke<CustomMcpPreview>('custom_mcp_preview', { project, source: wire });
  }

  /**
   * Approves a review, then reloads and requests the restart that starts the server.
   * @param project - the project the review belongs to
   * @param previewId - the id `preview` returned
   * @param choices - the review-screen choices; carries credential values, never logged
   */
  async approve(
    project: string,
    previewId: string,
    choices: CustomMcpApproveChoices
  ): Promise<void> {
    const wire: CustomMcpApproveChoices = {
      name: choices.name,
      pii_mode: choices.pii_mode,
      workspace_mode: choices.workspace_mode,
      env_values: { ...choices.env_values },
    };
    await this.tauri.invoke('custom_mcp_approve', { project, previewId, choices: wire });
    await this.refresh(project);
    this.requestRestart(project, choices.name);
  }

  /**
   * Records tool decisions (applied without a restart) and stores the server it returns.
   * @param project - the project of the server
   * @param name - the server name
   * @param decisions - one decision per tool, pinned to the hash the user saw
   */
  async setTools(
    project: string,
    name: string,
    decisions: CustomMcpToolDecision[]
  ): Promise<CustomMcpEntry> {
    const wire: CustomMcpToolDecision[] = decisions.map((d) => ({
      upstream_name: d.upstream_name,
      state: d.state,
      definition_hash: d.definition_hash,
    }));
    const entry = await this.tauri.invoke<CustomMcpEntry>('custom_mcp_set_tools', {
      project,
      name,
      decisions: wire,
    });
    const current = this.list();
    if (current && current.project === project && project === this.projectState.activeProject()) {
      this.list.set({
        ...current,
        servers: current.servers.map((s) => (s.name === entry.name ? entry : s)),
      });
    }
    return entry;
  }

  /**
   * Sets a server's PII mode and reloads; `tokens` restarts the containers at once, `plaintext`
   * requests a restart.
   * @param project - the project of the server
   * @param name - the server name
   * @param piiMode - the new mode
   */
  async setPiiMode(project: string, name: string, piiMode: CustomPiiMode): Promise<void> {
    await this.tauri.invoke('custom_mcp_set_pii_mode', { project, name, piiMode });
    await this.refresh(project);
    if (piiMode === 'tokens') {
      await this.restartNow(project, name);
    } else {
      this.requestRestart(project, name);
    }
  }

  /**
   * Sets a server's project file access, then reloads and requests a restart.
   * @param project - the project of the server
   * @param name - the server name
   * @param workspaceMode - the new access level
   */
  async setFileAccess(
    project: string,
    name: string,
    workspaceMode: CustomWorkspaceMode
  ): Promise<void> {
    await this.tauri.invoke('custom_mcp_set_file_access', { project, name, workspaceMode });
    await this.refresh(project);
    this.requestRestart(project, name);
  }

  /**
   * Turns a server on or off, then reloads and requests a restart.
   * @param project - the project of the server
   * @param name - the server name
   * @param enabled - the new state
   */
  async setEnabled(project: string, name: string, enabled: boolean): Promise<void> {
    await this.tauri.invoke('custom_mcp_set_enabled', { project, name, enabled });
    await this.refresh(project);
    this.requestRestart(project, name);
  }

  /**
   * Lets a server reach `host:port` (no restart), then reloads.
   * @param project - the project of the server
   * @param name - the server name
   * @param host - the host name
   * @param port - the TCP port
   */
  async allowDomain(project: string, name: string, host: string, port: number): Promise<void> {
    await this.tauri.invoke('custom_mcp_allow_domain', { project, name, host, port });
    await this.refresh(project);
  }

  /**
   * Stops a server from reaching `host:port` (no restart), then reloads.
   * @param project - the project of the server
   * @param name - the server name
   * @param host - the host name
   * @param port - the TCP port
   */
  async removeDomain(project: string, name: string, host: string, port: number): Promise<void> {
    await this.tauri.invoke('custom_mcp_remove_domain', { project, name, host, port });
    await this.refresh(project);
  }

  /**
   * Connections an npm server's egress proxy refused since its container started.
   * @param project - the project of the server
   * @param name - the server name
   */
  egressDenials(project: string, name: string): Promise<CustomMcpEgressDenials> {
    return this.tauri.invoke<CustomMcpEgressDenials>('custom_mcp_egress_denials', {
      project,
      name,
    });
  }

  /**
   * Revokes a server; the backend re-renders a running project itself, so no restart is requested.
   * @param project - the project of the server
   * @param name - the server name
   */
  async remove(project: string, name: string): Promise<void> {
    await this.tauri.invoke('custom_mcp_remove', { project, name });
    await this.refresh(project);
  }

  private accepts(project: string, gen: number): boolean {
    return gen === this.generation && project === this.projectState.activeProject();
  }

  private requestRestart(project: string, name: string): void {
    this.markJustEnabled(project, name);
    this.projectState.requestRestartFor(project);
  }

  private async restartNow(project: string, name: string): Promise<void> {
    const status = this.projectState.status();
    if (
      !this.projectState.isSettledOn(project) ||
      (status !== 'ready' && status !== 'auth_required')
    ) {
      this.requestRestart(project, name);
      return;
    }
    this.markJustEnabled(project, name);
    const outcome = await this.projectState.restartContainers(project);
    if (outcome !== 'restarted') this.projectState.requestRestartFor(project);
  }

  private markJustEnabled(project: string, name: string): void {
    const serviceId =
      this.entries().find((s) => s.name === name && this.project() === project)?.service_id ??
      `${CUSTOM_MCP_SERVICE_PREFIX}${name}`;
    if (this.projectState.isSettledOn(project)) {
      this.projectState.pendingJustEnabled = serviceId;
    }
  }
}
