import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  input,
  NgZone,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import {
  ProgressStepsComponent,
  type SetupStep,
  type StepState,
} from '../shared/progress-steps/progress-steps.component';
import {
  CreateProjectModalComponent,
  type CreatedProject,
} from '../shared/create-project-modal/create-project-modal.component';
import { LogoComponent } from '../shared/logo.component';

/** Maximum number of pipeline steps. */
const TOTAL_STEPS = 6;

/** Estimated seconds remaining per step index when active. */
const ETA_PER_STEP_S: readonly number[] = [3, 30, 90, 5, 1, 5];

/** Guides the user through initial environment setup and project creation. */
@Component({
  selector: 'app-setup-wizard',
  imports: [CommonModule, ProgressStepsComponent, CreateProjectModalComponent, LogoComponent],
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
            <!-- Inline SVG mark adapts per theme via currentColor. -->
            <app-logo class="h-9 w-9" />
            <div>
              <div
                class="view-title view-title-display text-[var(--ink)]"
                data-testid="setup-headline"
              >
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

          @if (phase() === 'welcome') {
            <button
              type="button"
              class="mono mt-6 self-start rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-4 py-2 text-[12px] font-medium text-[var(--on-accent)] hover:opacity-90"
              data-testid="setup-start-btn"
              (click)="startSetup()"
            >
              $ start setup
            </button>
          } @else if (phase() === 'progress' || phase() === 'project') {
            <div class="mt-8">
              <app-progress-steps
                [steps]="steps"
                [error]="error()"
                [etaSeconds]="etaTotalSeconds()"
                (retry)="retryCurrentStep()"
                (back)="backToWelcome()"
              />
            </div>
          } @else if (phase() === 'complete') {
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

    <app-create-project-modal
      [open]="phase() === 'project'"
      [dismissible]="false"
      (created)="onProjectCreated($event)"
    />
  `,
})
export class SetupWizardComponent {
  /** When false, the overlay hides itself (used by parent host integrations). */
  readonly visible = input<boolean>(true);

  /** Current wizard phase. Read with `phase()`, mutate via `phase.set(...)`. */
  readonly phase = signal<'welcome' | 'progress' | 'project' | 'complete'>('welcome');
  /** Latest error message surfaced under the steps panel; `null` when clear. */
  readonly error = signal<string | null>(null);
  /** Project name confirmed by the user (preserved across step retries). */
  readonly projectName = signal<string>('');
  /** Absolute project directory chosen by the user. */
  readonly projectDir = signal<string>('');

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
      description: 'Pick the folder Claude will work in',
      status: 'pending',
    },
    {
      id: 'start_containers',
      title: 'start containers',
      description: 'Deferred until a provider is chosen',
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
  /** Replaces the step list. */
  set steps(next: SetupStep[]) {
    this.stepsSig.set(next);
  }

  /** Total ETA in seconds — sum of pending+active step ETAs. */
  readonly etaTotalSeconds = computed<number | null>(() => {
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
      }
      this.stepsSig.set(next);
      this.cdr.markForCheck();
    } catch {
      // Fallback: keep generic descriptions
    }
  }

  /** Begins the setup process by transitioning to the progress phase and running auto steps. */
  async startSetup(): Promise<void> {
    this.phase.set('progress');
    this.error.set(null);
    this.resetSteps();
    this.cdr.markForCheck();
    await this.runAutoSteps();
  }

  /** Resets all steps and returns to the welcome phase. */
  backToWelcome(): void {
    this.phase.set('welcome');
    this.error.set(null);
    this.resetSteps();
    this.cdr.markForCheck();
  }

  /** Retries the current failed step from where it left off. */
  async retryCurrentStep(): Promise<void> {
    this.error.set(null);
    const idx = this.currentStepIndexSig();
    this.patchStep(idx, { status: 'pending', detail: undefined });
    this.cdr.markForCheck();
    await this.runFromStep(idx);
  }

  /**
   * Marks step 3 done and continues auto-steps after the project is created.
   * @param payload - Name and directory of the freshly created project.
   */
  async onProjectCreated(payload: CreatedProject): Promise<void> {
    this.projectName.set(payload.name);
    this.projectDir.set(payload.dir);
    this.setStep(3, 'done');
    this.currentStepIndexSig.set(4);
    this.phase.set('progress');
    this.cdr.markForCheck();
    await this.runFromStep(4);
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
          this.projectName.set(selected.name);
          this.projectDir.set(selected.dir);
          this.setStep(3, 'done', `Using existing project: ${this.projectName()}`);
          continue;
        }
        this.phase.set('project');
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
    this.phase.set('complete');
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
        case 4: // Start Containers — deferred: a fresh project has no
          // provider yet, so this would only bail. Settings starts it later.
          await this.tauri.invoke('defer_container_start', { project: this.projectName() });
          this.setStep(4, 'done', 'Deferred until a provider is chosen');
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
        return 'Building container images for enabled integrations (this may take a few minutes)...';
      case 4:
        return 'Deferring container start...';
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
    this.error.set(message);
    this.phase.set('progress');
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
