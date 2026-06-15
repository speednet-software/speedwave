import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TauriService } from '../services/tauri.service';
import { ProjectStateService } from '../services/project-state.service';
import { ThemeService, THEME_MODES, type ThemeId, type ThemeMode } from '../services/theme.service';
import { UiStateService } from '../services/ui-state.service';
import { BetaService } from '../services/beta.service';
import { LlmProviderComponent } from './llm-provider/llm-provider.component';
import { AdvancedSectionComponent } from './advanced-section/advanced-section.component';
import { TranscriptionSectionComponent } from './transcription-section/transcription-section.component';
import { UpdateSectionComponent } from './update-section/update-section.component';
import { ProjectPillComponent } from '../project-switcher/project-pill.component';
import { ProjectList } from '../models/update';

/**
 * One theme card in the Appearance accent grid. The preview swatch reads the
 * live `--accent` value per theme via `data-theme`, so it stays correct in
 * both light and dark mode without duplicating CSS hex values here.
 */
interface ThemeCard {
  /** Theme identifier — drives `ThemeService.setTheme()` and the active-state binding. */
  readonly id: ThemeId;
  /** Lowercase label rendered in mono next to the swatch. */
  readonly label: string;
}

/** Cards rendered in the Appearance section grid — order matches the mockup. */
const THEME_CARDS: readonly ThemeCard[] = [
  { id: 'crimson', label: 'crimson' },
  { id: 'mint', label: 'mint' },
  { id: 'amber', label: 'amber' },
  { id: 'iris', label: 'iris' },
  { id: 'cyan', label: 'cyan' },
  { id: 'sand', label: 'sand' },
] as const;

/** Display copy + glyph for one mode card (light/dark/auto). */
interface ModeCard {
  readonly id: ThemeMode;
  readonly label: string;
  readonly glyph: string;
}

/** Per-mode glyph — `Record<ThemeMode, …>` makes a new mode a compile error here. */
const MODE_GLYPHS: Record<ThemeMode, string> = {
  light: '◯',
  dark: '●',
  auto: '◐',
};

/** Cards rendered in the MODE row — derived from THEME_MODES so order + membership stay in sync. */
const MODE_CARDS: readonly ModeCard[] = THEME_MODES.map((id) => ({
  id,
  label: id,
  glyph: MODE_GLYPHS[id],
}));

/** Displays application settings and provides factory reset functionality. */
@Component({
  selector: 'app-settings',
  imports: [
    RouterLink,
    LlmProviderComponent,
    AdvancedSectionComponent,
    TranscriptionSectionComponent,
    UpdateSectionComponent,
    ProjectPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex h-full flex-col bg-[var(--bg)] text-[var(--ink)]',
  },
  template: `
    <!-- Header band — 44px tall, matches chat header -->
    <div
      class="flex h-11 flex-shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg-1)] px-4 md:px-6"
    >
      <h1
        class="view-title view-title-page truncate text-[var(--ink)]"
        data-testid="settings-title"
      >
        Settings
      </h1>
      <div class="ml-auto flex flex-shrink-0 items-center gap-3">
        <a
          routerLink="/logs"
          class="mono hidden text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)] md:inline"
          data-testid="settings-system-health-link"
          >system health →</a
        >
        <span class="hidden text-[var(--line-strong)] md:inline">·</span>
        <app-project-pill />
      </div>
    </div>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto p-4 md:p-6">
      <div class="mx-auto max-w-3xl space-y-8">
        @if (error) {
          <div
            class="rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300"
            data-testid="settings-error"
            role="alert"
          >
            {{ error }}
          </div>
        }

        <app-llm-provider
          [activeProject]="activeProject"
          (providerChange)="llmProvider = $event"
          (errorOccurred)="error = $event"
        />

        <app-update-section [activeProject]="activeProject" (errorOccurred)="error = $event" />

        <section
          id="section-appearance"
          class="border-t border-[var(--line)] pt-6"
          data-testid="settings-section-appearance"
        >
          <h2 class="view-title view-title-section text-[var(--ink)]">Appearance</h2>
          <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
            Choose appearance mode and accent color. Auto follows your system.
          </p>

          <div class="mono mb-2 mt-4 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            mode
          </div>
          <div class="grid grid-cols-3 gap-2">
            @for (card of modeCards; track card.id) {
              <button
                type="button"
                [attr.data-mode-btn]="card.id"
                [class.active]="theme.mode() === card.id"
                [attr.aria-pressed]="theme.mode() === card.id"
                class="theme-card flex items-center gap-3 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2 text-left hover:border-[var(--line-strong)]"
                (click)="theme.setMode(card.id)"
              >
                <span class="mono w-4 text-center text-[14px] text-[var(--ink-dim)]">{{
                  card.glyph
                }}</span>
                <span class="mono text-[12px] text-[var(--ink)]">{{ card.label }}</span>
                <span class="check ml-auto text-[var(--accent)]">&#9679;</span>
              </button>
            }
          </div>

          <div class="mono mb-2 mt-4 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            accent color
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            @for (card of themeCards; track card.id) {
              <button
                type="button"
                [attr.data-theme-btn]="card.id"
                [class.active]="theme.theme() === card.id"
                [attr.aria-pressed]="theme.theme() === card.id"
                class="theme-card flex items-center gap-3 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2 text-left hover:border-[var(--line-strong)]"
                (click)="theme.setTheme(card.id)"
              >
                <span
                  class="inline-flex gap-0.5 rounded border border-[var(--line)] p-0.5"
                  [attr.data-theme]="card.id"
                >
                  <span class="bg-[var(--bg)]" [style.width.px]="12" [style.height.px]="18"></span>
                  <span
                    class="bg-[var(--accent)]"
                    [style.width.px]="12"
                    [style.height.px]="18"
                  ></span>
                </span>
                <span class="mono text-[12px] text-[var(--ink)]">{{ card.label }}</span>
                <span class="check ml-auto text-[var(--accent)]">&#9679;</span>
              </button>
            }
          </div>
        </section>

        @if (beta.enabled()) {
          <app-transcription-section (errorOccurred)="error = $event" />
        }

        <app-advanced-section
          (errorOccurred)="error = $event"
          (resetCompleted)="onResetCompleted()"
        />
      </div>
    </div>
  `,
})
export class SettingsComponent implements OnInit, OnDestroy {
  activeProject: string | null = null;
  error = '';
  llmProvider = 'anthropic';

  /** Static catalog of accent themes — bound 1:1 by the Appearance card grid. */
  readonly themeCards: readonly ThemeCard[] = THEME_CARDS;
  /** Static catalog of appearance modes — bound 1:1 by the MODE row. */
  readonly modeCards: readonly ModeCard[] = MODE_CARDS;
  /** Theme service exposed to the template so card click handlers can switch accents. */
  readonly theme = inject(ThemeService);
  /** UI state service exposed for the project switcher trigger in the header. */
  readonly ui = inject(UiStateService);
  /** Beta-features gate — the meeting-transcription section is beta-only. */
  readonly beta = inject(BetaService);

  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private unsubProjectReady: (() => void) | null = null;

  /** Loads project information on component initialization. */
  ngOnInit(): void {
    this.loadProjectInfo();

    this.unsubProjectReady = this.projectState.onProjectReady(() => {
      this.loadProjectInfo();
    });
  }

  /** Unsubscribes from the project ready listener. */
  ngOnDestroy(): void {
    if (this.unsubProjectReady) {
      this.unsubProjectReady();
      this.unsubProjectReady = null;
    }
  }

  /** Handles factory reset completion by navigating to setup. */
  onResetCompleted(): void {
    this.router.navigate(['/setup'], { replaceUrl: true });
  }

  private async loadProjectInfo(): Promise<void> {
    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      this.activeProject = result.active_project;
    } catch {
      // Not running inside Tauri
    }
    this.cdr.markForCheck();
  }
}
