import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { LoggerService } from '../../services/logger.service';
import { GitForgeService, GitRepositoriesView } from '../../models/integration';

/** Repository allowlist editor of one git integration (GitHub or GitLab) in one project. */
@Component({
  selector: 'app-git-repositories',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="m-3 rounded border border-[var(--line)] p-3 text-sm"
      data-testid="git-repositories-section"
    >
      <p class="mono mb-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
        Repositories
      </p>
      <p class="mb-2 text-[12px] text-[var(--ink-mute)]" data-testid="git-repositories-help">
        Enter <code class="mono">owner/repo</code> or a clone URL.
        <code class="mono">owner/*</code> admits every repository of that owner or group, subgroups
        included; a bare <code class="mono">*</code> or a whole host is refused.
      </p>

      @if (enabled() && loaded() && view().host !== null && view().repositories.length === 0) {
        <p class="mb-2 text-[12px] text-[var(--ink)]" data-testid="git-repositories-empty-notice">
          Push and fetch from the container work only for repositories on this list, and the list is
          empty.
        </p>
      }

      @if (view().host === null) {
        <p
          class="mb-2 text-[12px] text-[var(--ink-mute)]"
          data-testid="git-repositories-host-unusable"
        >
          The GitLab host URL is not an https URL, so the git transport is off for it.
        </p>
      }

      @if (view().repositories.length > 0) {
        <ul class="mb-2" data-testid="git-repositories-list">
          @for (repo of view().repositories; track repo) {
            <li
              class="flex items-center gap-3 py-1"
              [attr.data-testid]="'git-repositories-row-' + repo"
            >
              <span class="mono text-[12px] text-[var(--ink)]">{{ repo }}</span>
              <button
                type="button"
                class="pill accent ml-auto hover:bg-[var(--accent-soft)]"
                [disabled]="busy()"
                [attr.aria-label]="'Remove ' + repo"
                [attr.data-testid]="'git-repositories-remove-' + repo"
                (click)="remove(repo)"
              >
                Remove
              </button>
            </li>
          }
        </ul>
      }

      <div class="flex items-center gap-2">
        <input
          type="text"
          class="mono min-w-0 flex-1 rounded border border-[var(--line)] bg-transparent px-2 py-1 text-[12px] text-[var(--ink)]"
          placeholder="owner/repo"
          aria-label="Repository to add"
          data-testid="git-repositories-input"
          [value]="draft()"
          [disabled]="busy()"
          (input)="onDraft($event)"
          (keydown.enter)="add(draft())"
        />
        <button
          type="button"
          class="pill accent hover:bg-[var(--accent-soft)]"
          data-testid="git-repositories-add"
          [disabled]="busy() || view().host === null"
          (click)="add(draft())"
        >
          Add
        </button>
      </div>
      @if (error()) {
        <p class="mt-2 text-[12px] text-red-300" role="alert" data-testid="git-repositories-error">
          {{ error() }}
        </p>
      }

      @if (view().suggestions.length > 0) {
        <div class="mt-3" data-testid="git-repositories-suggestions">
          <p class="mono mb-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            Found in the project directory
          </p>
          @for (s of view().suggestions; track s.entry) {
            <div
              class="flex items-center gap-3 py-1"
              [attr.data-testid]="'git-repositories-suggestion-' + s.entry"
            >
              <span class="mono text-[12px] text-[var(--ink)]">{{ s.entry }}</span>
              <span
                class="text-[12px] text-[var(--ink-mute)]"
                [attr.data-testid]="'git-repositories-suggestion-dir-' + s.entry"
                >{{ s.source_dir === '.' ? 'project root' : s.source_dir }}</span
              >
              <button
                type="button"
                class="pill accent ml-auto hover:bg-[var(--accent-soft)]"
                [disabled]="busy() || view().host === null"
                [attr.aria-label]="'Add ' + s.entry"
                [attr.data-testid]="'git-repositories-suggestion-add-' + s.entry"
                (click)="add(s.entry)"
              >
                Add
              </button>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class GitRepositoriesComponent {
  readonly project = input.required<string>();
  readonly service = input.required<GitForgeService>();
  readonly enabled = input.required<boolean>();

  protected readonly view = signal<GitRepositoriesView>({
    host: '',
    repositories: [],
    suggestions: [],
  });
  protected readonly loaded = signal(false);
  protected readonly draft = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  private readonly tauri = inject(TauriService);
  private readonly projectState = inject(ProjectStateService);
  private readonly log = inject(LoggerService);

  /** Reloads the view whenever the project or the service changes. */
  constructor() {
    effect(() => {
      const project = this.project();
      const service = this.service();
      untracked(() => void this.load(project, service));
    });
  }

  /**
   * Stores the typed text of the entry field.
   * @param event - the input event of the field
   */
  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  /**
   * Adds an entry to the allowlist and applies the change to the running proxy.
   * @param raw - the entry as typed or suggested
   */
  protected async add(raw: string): Promise<void> {
    const entry = raw.trim();
    if (!entry || this.busy() || this.view().host === null) return;
    const fromField = raw === this.draft();
    await this.write('add_git_repository', entry, fromField);
  }

  /**
   * Removes an entry from the allowlist and applies the change to the running proxy.
   * @param entry - the entry to remove
   */
  protected async remove(entry: string): Promise<void> {
    if (this.busy()) return;
    await this.write('remove_git_repository', entry, false);
  }

  private async load(project: string, service: GitForgeService): Promise<void> {
    this.error.set('');
    this.loaded.set(false);
    try {
      const next = await this.tauri.invoke<GitRepositoriesView>('get_git_repositories', {
        project,
        service,
      });
      if (this.isShown(project, service) && next) {
        this.view.set(next);
        this.loaded.set(true);
      }
    } catch (e: unknown) {
      if (this.isShown(project, service)) this.error.set(errorText(e));
    }
  }

  private async write(
    command: 'add_git_repository' | 'remove_git_repository',
    entry: string,
    clearField: boolean
  ): Promise<void> {
    const project = this.project();
    const service = this.service();
    this.busy.set(true);
    this.error.set('');
    try {
      const next = await this.tauri.invoke<GitRepositoriesView>(command, {
        project,
        service,
        entry,
      });
      if (this.isShown(project, service)) {
        this.view.set(next);
        if (clearField) this.draft.set('');
      }
      if (this.enabled()) await this.applyToProxy(project);
    } catch (e: unknown) {
      if (this.isShown(project, service)) this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  private isShown(project: string, service: GitForgeService): boolean {
    return this.project() === project && this.service() === service;
  }

  private async applyToProxy(project: string): Promise<void> {
    if (!this.projectState.isSettledOn(project) || this.projectState.status() !== 'ready') {
      this.projectState.requestRestartFor(project);
      return;
    }
    try {
      await this.tauri.invoke('restart_llm_proxy', { project });
    } catch (e: unknown) {
      this.log.warn(`restart_llm_proxy failed, falling back to full restart: ${errorText(e)}`);
      this.projectState.requestRestartFor(project);
    }
  }
}

/**
 * Readable text of a rejected command.
 * @param e - the caught value
 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
