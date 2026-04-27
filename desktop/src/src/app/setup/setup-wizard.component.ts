import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  input,
  NgZone,
  output,
  signal,
} from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';

/** Lifecycle status of a single setup step. */
export type StepState = 'pending' | 'active' | 'done' | 'error';

/** Internal SetupStep — used by the routed wizard's pipeline. */
export interface SetupStep {
  id: string;
  title: string;
  description: string;
  status: StepState;
  detail?: string;
  /** 0-100 progress for an `active` step that exposes one. */
  progress?: number;
}

/** Maximum number of pipeline steps. */
const TOTAL_STEPS = 6;

/** Estimated seconds remaining per step index when active. */
const ETA_PER_STEP_S: readonly number[] = [3, 30, 90, 5, 30, 5];

/** Guides the user through initial environment setup and project creation. */
@Component({
  selector: 'app-setup-wizard',
  imports: [CommonModule, FormsModule, NgOptimizedImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="fixed inset-0 z-[1200] flex flex-col bg-[var(--bg)]"
      [class.hidden]="!visible()"
      data-testid="setup-wizard"
    >
      <div class="flex flex-1 overflow-y-auto">
        <div class="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-6 py-10">
          <div class="mb-6 flex items-center gap-3">
            <img
              ngSrc="assets/speedwave-mark-white@2x.png"
              alt="Speedwave"
              class="h-9 w-9"
              width="36"
              height="36"
              priority
            />
            <div>
              <div class="view-title text-[22px] text-[var(--ink)]" data-testid="setup-headline">
                Welcome to Speedwave.<span class="caret ml-1"></span>
              </div>
              <div class="mono mt-1 text-[12px] text-[var(--ink-dim)]" data-testid="setup-subtitle">
                first-run setup · ~2 minutes
              </div>
            </div>
          </div>

          <p
            class="text-[13px] leading-relaxed text-[var(--ink-dim)]"
            data-testid="setup-description"
          >
            We'll check your environment, download what's missing, and create your first project.
            Nothing leaves your machine.
          </p>

          @if (phase === 'welcome') {
            <button
              type="button"
              class="mono mt-6 self-start rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-4 py-2 text-[12px] font-medium text-[var(--on-accent)] hover:opacity-90"
              data-testid="setup-start-btn"
              (click)="startSetup()"
            >
              $ start setup
            </button>
          } @else if (phase === 'progress' || phase === 'project') {
            <div
              class="mt-8 rounded border border-[var(--line)] bg-[var(--bg-1)]"
              data-testid="setup-steps"
            >
              @for (step of steps; track step.id; let i = $index) {
                <div
                  class="flex items-start gap-4 px-5 py-4"
                  [style.borderBottom]="i < steps.length - 1 ? '1px solid var(--line)' : 'none'"
                  [class.opacity-50]="step.status === 'pending'"
                  data-testid="setup-step"
                  [attr.data-status]="step.status"
                >
                  <div
                    class="mono flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-[11px]"
                    [style.borderColor]="circleBorder(step)"
                    [style.background]="circleBg(step)"
                    [style.color]="circleColor(step)"
                  >
                    @switch (step.status) {
                      @case ('done') {
                        <span aria-hidden="true">✓</span>
                      }
                      @case ('active') {
                        <svg
                          class="spin h-3 w-3"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          stroke-width="2"
                          aria-hidden="true"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"
                          />
                        </svg>
                      }
                      @case ('error') {
                        <span aria-hidden="true">!</span>
                      }
                      @default {
                        <span>{{ i + 1 }}</span>
                      }
                    }
                  </div>
                  <div class="flex-1">
                    <div
                      class="mono flex items-center gap-2 text-[13px]"
                      [style.color]="step.status === 'pending' ? 'var(--ink-dim)' : 'var(--ink)'"
                    >
                      <span data-testid="step-title">{{ step.title }}</span>
                      @if (step.status === 'done') {
                        <span class="pill green" data-testid="step-pill">done</span>
                      }
                      @if (step.status === 'active') {
                        <span class="pill amber" data-testid="step-pill">running</span>
                      }
                      @if (step.status === 'error') {
                        <span
                          class="pill"
                          style="color: #f87171; border-color: rgba(239, 68, 68, 0.4);"
                          data-testid="step-pill"
                          >error</span
                        >
                      }
                    </div>
                    <div
                      class="mono mt-0.5 text-[11px] text-[var(--ink-mute)]"
                      data-testid="step-detail"
                    >
                      {{ step.detail || step.description }}
                    </div>
                    @if (step.status === 'active' && step.progress !== undefined) {
                      <div class="mono mt-2 h-1 w-full overflow-hidden rounded bg-[var(--bg-2)]">
                        <div
                          class="h-full bg-[var(--accent)]"
                          [style.width.%]="step.progress"
                        ></div>
                      </div>
                    }
                  </div>
                </div>
              }
            </div>

            @if (phase === 'project') {
              <div
                class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] p-4"
                data-testid="setup-project-form"
              >
                <label
                  class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  for="setup-project-name"
                  >project name</label
                >
                <input
                  id="setup-project-name"
                  type="text"
                  [(ngModel)]="projectName"
                  placeholder="acme-corp"
                  data-testid="setup-project-name"
                  class="mono mb-3 w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
                />
                <label
                  class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  for="setup-project-dir"
                  >project directory</label
                >
                <input
                  id="setup-project-dir"
                  type="text"
                  [(ngModel)]="projectDir"
                  placeholder="/Users/you/projects/acme-corp"
                  data-testid="setup-project-dir"
                  class="mono mb-3 w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--ink)]"
                />
                <button
                  type="button"
                  class="mono rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="setup-create-project-btn"
                  [disabled]="busy || !projectName || !projectDir"
                  (click)="createProject()"
                >
                  {{ busy ? 'creating…' : '$ create project' }}
                </button>
              </div>
            }

            @if (error) {
              <div
                class="mt-4 rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300 mono"
                data-testid="setup-error"
                role="alert"
              >
                {{ error }}
              </div>
              <div class="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  class="mono rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90"
                  data-testid="setup-retry-btn"
                  (click)="retryCurrentStep()"
                >
                  $ retry
                </button>
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                  data-testid="setup-back-btn"
                  (click)="backToWelcome()"
                >
                  ← back
                </button>
              </div>
            }

            <div
              class="mono mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--ink-mute)]"
              data-testid="setup-footer"
            >
              <span data-testid="setup-progress-summary">
                step {{ currentStepNumber() }} of {{ totalSteps() }} · ~{{ etaSeconds() }}s
                remaining
              </span>
              <div class="flex gap-4">
                <button
                  type="button"
                  class="hover:text-[var(--ink)]"
                  data-testid="setup-view-logs"
                  (click)="onViewLogs()"
                >
                  view logs →
                </button>
                <button
                  type="button"
                  class="hover:text-[var(--ink)]"
                  data-testid="setup-exit"
                  (click)="onExitSetup()"
                >
                  exit setup
                </button>
              </div>
            </div>
          } @else if (phase === 'complete') {
            <div
              class="mt-8 rounded border border-[var(--line)] bg-[var(--bg-1)] p-6 text-center"
              data-testid="setup-success"
            >
              <p class="mono text-[13px] text-[var(--green)]">
                Setup complete. Redirecting to settings…
              </p>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class SetupWizardComponent {
  /** When false, the overlay hides itself (used by parent host integrations). */
  readonly visible = input<boolean>(true);
  /** Emitted when the user clicks "view logs". */
  readonly viewLogs = output<void>();
  /** Emitted when the user clicks "exit setup". */
  readonly exitSetup = output<void>();

  phase: 'welcome' | 'progress' | 'project' | 'complete' = 'welcome';
  busy = false;
  error: string | null = null;
  projectName = '';
  projectDir = '';

  /** 0-based index of the step currently in progress (or `0` when idle). */
  private readonly currentStepIndexSig = signal<number>(0);

  /** Steps as a signal so `etaSeconds`/`currentStepNumber` recompute reactively. */
  private readonly stepsSig = signal<SetupStep[]>([
    {
      id: 'system_check',
      title: 'check environment',
      description: 'Verify system requirements',
      status: 'pending',
    },
    {
      id: 'init_vm',
      title: 'start virtual machine',
      description: 'Set up container environment',
      status: 'pending',
    },
    {
      id: 'build_images',
      title: 'build images',
      description: 'Build container images',
      status: 'pending',
    },
    {
      id: 'create_project',
      title: 'create your first project',
      description: 'Pick a folder — we generate the compose file',
      status: 'pending',
    },
    {
      id: 'start_containers',
      title: 'start containers',
      description: 'Launch project containers',
      status: 'pending',
    },
    {
      id: 'finalize',
      title: 'finalize',
      description: 'Link the speedwave CLI',
      status: 'pending',
    },
  ]);

  /** Reactive view onto the step list — preserves the legacy `steps` field for tests. */
  get steps(): SetupStep[] {
    return this.stepsSig();
  }
  /**
   * Replaces the step list — kept as a setter for tests that mutate it directly.
   */
  set steps(next: SetupStep[]) {
    this.stepsSig.set(next);
  }

  /** Total number of steps in the pipeline (used by mockup footer). */
  readonly totalSteps = computed<number>(() => this.stepsSig().length);

  /** Step number (1-based) currently in progress — used by mockup footer. */
  readonly currentStepNumber = computed<number>(() => {
    const list = this.stepsSig();
    const idx = list.findIndex((s) => s.status === 'active');
    if (idx >= 0) return idx + 1;
    const errIdx = list.findIndex((s) => s.status === 'error');
    if (errIdx >= 0) return errIdx + 1;
    return Math.min(this.currentStepIndexSig() + 1, list.length);
  });

  /** Estimated seconds remaining for the current pipeline. */
  readonly etaSeconds = computed<number>(() => {
    const list = this.stepsSig();
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].status === 'pending' || list[i].status === 'active') {
        total += ETA_PER_STEP_S[i] ?? 0;
      }
    }
    return total;
  });

  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);
  private router = inject(Router);
  private tauri = inject(TauriService);

  /** Existing projects fetched at setup start; empty on fresh install. */
  private existingProjects: Array<{ name: string; dir: string }> = [];
  private activeProject: string | null = null;

  /** Detect host platform and customize step descriptions. */
  constructor() {
    // Pin total to TOTAL_STEPS for safety — the constant lives only here.
    void TOTAL_STEPS;
    this.detectPlatform();
  }

  private async detectPlatform(): Promise<void> {
    try {
      const platform = await this.tauri.invoke<string>('get_platform');
      const next = [...this.stepsSig()];
      switch (platform) {
        case 'macos':
          next[0] = { ...next[0], description: 'Verify Lima / nerdctl' };
          next[1] = { ...next[1], description: 'Create and start the Lima VM' };
          break;
        case 'windows':
          next[0] = { ...next[0], description: 'Verify system requirements' };
          next[1] = { ...next[1], description: 'Set up WSL2 distribution' };
          break;
        case 'linux':
          next[0] = { ...next[0], description: 'Verify nerdctl (rootless)' };
          next[1] = { ...next[1], description: 'Set up rootless containerd' };
          break;
      }
      this.stepsSig.set(next);
      this.cdr.markForCheck();
    } catch {
      // Fallback: keep generic descriptions
    }
  }

  /** Begins the setup process by transitioning to the progress phase and running auto steps. */
  async startSetup(): Promise<void> {
    this.phase = 'progress';
    this.error = null;
    this.resetSteps();
    this.cdr.markForCheck();
    await this.runAutoSteps();
  }

  /** Resets all steps and returns to the welcome phase. */
  backToWelcome(): void {
    this.phase = 'welcome';
    this.error = null;
    this.resetSteps();
    this.cdr.markForCheck();
  }

  /** Retries the current failed step from where it left off. */
  async retryCurrentStep(): Promise<void> {
    this.error = null;
    const idx = this.currentStepIndexSig();
    this.patchStep(idx, { status: 'pending', detail: undefined });
    this.cdr.markForCheck();
    await this.runFromStep(idx);
  }

  /** Creates a new project with the provided name and directory, then continues setup. */
  async createProject(): Promise<void> {
    this.busy = true;
    this.error = null;
    this.setStep(3, 'active', 'Creating project...');
    try {
      await this.tauri.invoke('create_project', { name: this.projectName, dir: this.projectDir });
      this.setStep(3, 'done');
      this.currentStepIndexSig.set(4);
      this.phase = 'progress';
      this.cdr.markForCheck();
      await this.runFromStep(4);
    } catch (err) {
      this.failStep(3, `Project creation failed: ${err}`);
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Step status circle — border colour.
   * @param step Setup step whose status drives the colour.
   */
  protected circleBorder(step: SetupStep): string {
    if (step.status === 'done') return 'rgba(52, 211, 153, 0.3)';
    if (step.status === 'active') return 'var(--accent-dim)';
    if (step.status === 'error') return 'rgba(239, 68, 68, 0.5)';
    return 'var(--line)';
  }

  /**
   * Step status circle — background fill.
   * @param step Setup step whose status drives the fill colour.
   */
  protected circleBg(step: SetupStep): string {
    if (step.status === 'done') return 'rgba(52, 211, 153, 0.1)';
    if (step.status === 'active') return 'var(--accent-soft)';
    if (step.status === 'error') return 'rgba(239, 68, 68, 0.1)';
    return 'transparent';
  }

  /**
   * Step status circle — text/icon colour.
   * @param step Setup step whose status drives the foreground colour.
   */
  protected circleColor(step: SetupStep): string {
    if (step.status === 'done') return 'var(--green)';
    if (step.status === 'active') return 'var(--accent)';
    if (step.status === 'error') return '#f87171';
    return 'var(--ink-mute)';
  }

  /** Emit `viewLogs` for parents that wrap the wizard. */
  protected onViewLogs(): void {
    this.viewLogs.emit();
  }

  /** Emit `exitSetup` for parents that wrap the wizard. */
  protected onExitSetup(): void {
    this.exitSetup.emit();
  }

  // ---- Private helpers ----

  private async runAutoSteps(): Promise<void> {
    try {
      const result = await this.tauri.invoke<{
        projects: Array<{ name: string; dir: string }>;
        active_project: string | null;
      }>('list_projects');
      this.existingProjects = result.projects;
      this.activeProject = result.active_project;
    } catch {
      this.existingProjects = [];
      this.activeProject = null;
    }
    await this.runFromStep(0);
  }

  private async runFromStep(start: number): Promise<void> {
    const list = this.stepsSig();
    for (let i = start; i < list.length; i++) {
      this.currentStepIndexSig.set(i);

      // Step 3: Create Project — skip if user already has a project
      if (i === 3) {
        if (this.existingProjects.length > 0) {
          const active = this.existingProjects.find((p) => p.name === this.activeProject);
          const selected = active ?? this.existingProjects[0];
          this.projectName = selected.name;
          this.projectDir = selected.dir;
          this.setStep(3, 'done', `Using existing project: ${this.projectName}`);
          continue;
        }
        this.phase = 'project';
        this.setStep(3, 'active', 'Waiting for project details...');
        return;
      }

      // All other steps: auto-run
      const ok = await this.executeStep(i);
      if (!ok) return; // stop on error

      // If step 0 skipped VM init, jump loop ahead
      if (i === 0 && this.stepsSig()[1].status === 'done') {
        i = 1; // loop will increment to 2
      }
    }

    // All done
    this.phase = 'complete';
    this.cdr.markForCheck();
    setTimeout(
      () => this.zone.run(() => this.router.navigate(['/settings'], { replaceUrl: true })),
      1500
    );
  }

  private async executeStep(index: number): Promise<boolean> {
    this.setStep(index, 'active', this.getStepActionText(index));
    try {
      switch (index) {
        case 0: {
          // Check Runtime
          const status = await this.tauri.invoke<string>('check_runtime');
          this.setStep(0, 'done');
          if (status === 'Ready') {
            // Runtime ready — skip VM init
            this.setStep(1, 'done', 'Already available');
            this.currentStepIndexSig.set(2);
            return true;
          }
          break;
        }
        case 1: // Initialize VM
          await this.tauri.invoke('init_vm');
          this.setStep(1, 'done');
          break;
        case 2: // Build Images
          await this.tauri.invoke('build_images');
          this.setStep(2, 'done');
          break;
        case 4: // Start Containers
          await this.tauri.invoke('start_containers', { project: this.projectName });
          this.setStep(4, 'done');
          break;
        case 5: // Finalize
          this.setStep(5, 'active', 'Linking CLI...');
          this.cdr.markForCheck();
          await this.tauri.invoke('link_cli');
          this.setStep(5, 'done');
          break;
      }
      this.cdr.markForCheck();
      return true;
    } catch (err) {
      this.failStep(index, `${this.stepsSig()[index].title} failed: ${err}`);
      return false;
    }
  }

  private getStepActionText(index: number): string {
    switch (index) {
      case 0:
        return 'Detecting container runtime...';
      case 1:
        return 'Initializing virtual machine...';
      case 2:
        return 'Building container images (this may take a few minutes)...';
      case 4:
        return 'Starting containers...';
      case 5:
        return 'Finalizing setup...';
      default:
        return 'Working...';
    }
  }

  private setStep(index: number, status: StepState, detail?: string): void {
    const patch: Partial<SetupStep> = { status };
    if (detail !== undefined) patch.detail = detail;
    else if (status === 'done') patch.detail = undefined;
    this.patchStep(index, patch);
    this.cdr.markForCheck();
  }

  private patchStep(index: number, patch: Partial<SetupStep>): void {
    const next = [...this.stepsSig()];
    next[index] = { ...next[index], ...patch };
    this.stepsSig.set(next);
  }

  private failStep(index: number, message: string): void {
    this.patchStep(index, { status: 'error', detail: message });
    this.error = message;
    this.phase = 'progress';
    this.cdr.markForCheck();
  }

  private resetSteps(): void {
    const next = this.stepsSig().map((s) => ({
      ...s,
      status: 'pending' as StepState,
      detail: undefined,
    }));
    this.stepsSig.set(next);
    this.currentStepIndexSig.set(0);
  }
}
