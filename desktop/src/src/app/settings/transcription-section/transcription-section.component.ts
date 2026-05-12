import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  inject,
  output,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { TranscriptionService } from '../../services/transcription.service';
import type { ModelStatusEntry, TranscriptionConfig } from '../../models/transcript';

/** Settings → Meeting transcription. ADR-056 opt-in toggle (user-level, OFF by default) + defaults. */
@Component({
  selector: 'app-transcription-section',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      id="section-transcription"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-transcription"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Meeting transcription</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        When enabled, Speedwave can record system audio and your microphone on this machine.
        Transcription runs locally. Model downloads and sending transcripts to Claude use the
        network.
      </p>

      <div
        class="mt-4 flex items-center justify-between rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2"
      >
        <div>
          <div class="mono text-[12px] text-[var(--ink)]">enable meeting transcription</div>
          <div class="text-[11px] text-[var(--ink-mute)]">
            opens the Meeting transcription tab (⌘4)
          </div>
        </div>
        <button
          type="button"
          role="switch"
          [attr.aria-checked]="enabled() === true"
          class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="transcription-toggle"
          (click)="toggle()"
          [disabled]="busy()"
        >
          {{ enabled() === true ? 'on' : 'off' }}
        </button>
      </div>

      @if (enabled() === true) {
        <div class="mt-3 space-y-2 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2">
          <label class="flex items-center justify-between gap-2 text-[12px]">
            <span class="text-[var(--ink)]">default language</span>
            <select
              class="rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px]"
              data-testid="default-language"
              (change)="onLanguage($any($event.target).value)"
            >
              <option value="pl" [selected]="defaultLanguage() === 'pl'">Polish</option>
              <option value="en" [selected]="defaultLanguage() === 'en'">English</option>
            </select>
          </label>

          <label class="flex items-center justify-between gap-2 text-[12px]">
            <span class="text-[var(--ink)]">default live model</span>
            <select
              class="rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px]"
              data-testid="default-live-model"
              (change)="onLiveModel($any($event.target).value)"
            >
              <option value="" [selected]="!defaultLiveModel()">(recommended)</option>
              @for (m of liveModelOptions(); track m.key) {
                <option [value]="m.key" [selected]="defaultLiveModel() === m.key">
                  {{ m.key }}
                </option>
              }
            </select>
          </label>

          <label class="flex items-center justify-between gap-2 text-[12px]">
            <span class="text-[var(--ink)]">keep audio after the offline pass</span>
            <input
              type="checkbox"
              data-testid="keep-audio"
              [checked]="keepAudio()"
              (change)="onKeepAudio($any($event.target).checked)"
            />
          </label>

          <div>
            <button
              type="button"
              class="mono text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
              data-testid="transcription-manage"
              (click)="goToTab()"
            >
              manage models &rarr;
            </button>
          </div>
        </div>
      }
    </section>
  `,
})
export class TranscriptionSectionComponent implements OnInit {
  /** Forwards errors to the Settings shell banner. */
  readonly errorOccurred = output<string>();

  /** Current toggle value; `null` while loading. */
  readonly enabled = signal<boolean | null>(null);
  /** Default forced language (`'pl'` if unset). */
  readonly defaultLanguage = signal<'pl' | 'en'>('pl');
  /** Default live model key (`''` = "use the recommendation"). */
  readonly defaultLiveModel = signal<string>('');
  /** Keep `audio.wav` after the offline pass (default: true). */
  readonly keepAudio = signal(true);
  /** Whisper models available as a default-live-model choice. */
  readonly liveModelOptions = signal<ModelStatusEntry[]>([]);
  /** Disables the toggle while a save is in flight. */
  readonly busy = signal(false);

  private readonly transcription = inject(TranscriptionService);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Reads the current config + model list from the backend on first paint. */
  async ngOnInit(): Promise<void> {
    try {
      const cfg = await this.transcription.getConfig();
      this.enabled.set(cfg.enabled === true);
      this.defaultLanguage.set(cfg.default_language ?? 'pl');
      this.defaultLiveModel.set(cfg.default_live_model ?? '');
      this.keepAudio.set(cfg.keep_audio_after_finalize !== false);
      if (cfg.enabled === true) {
        const models = await this.transcription.listModels();
        this.liveModelOptions.set(models.whisper);
      }
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
      this.enabled.set(false);
    }
    this.cdr.markForCheck();
  }

  /** Builds the current `TranscriptionConfig` from the signals. */
  private currentConfig(): TranscriptionConfig {
    return {
      enabled: this.enabled() ?? false,
      default_language: this.defaultLanguage(),
      default_live_model: this.defaultLiveModel() || null,
      keep_audio_after_finalize: this.keepAudio(),
    };
  }

  /** Saves the current config; reports errors to the shell. */
  private async save(): Promise<void> {
    try {
      await this.transcription.setConfig(this.currentConfig());
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.cdr.markForCheck();
  }

  /** Flips the on/off toggle and persists. */
  async toggle(): Promise<void> {
    if (this.busy()) {
      return;
    }
    const next = !(this.enabled() ?? false);
    this.busy.set(true);
    this.enabled.set(next);
    await this.save();
    if (next) {
      try {
        const models = await this.transcription.listModels();
        this.liveModelOptions.set(models.whisper);
      } catch {
        // Non-fatal — the dropdown just stays empty.
      }
    }
    this.busy.set(false);
    this.cdr.markForCheck();
  }

  /**
   * Updates the default language and persists.
   * @param v - 'pl' or 'en'.
   */
  async onLanguage(v: string): Promise<void> {
    if (v === 'pl' || v === 'en') {
      this.defaultLanguage.set(v);
      await this.save();
    }
  }

  /**
   * Updates the default live model and persists.
   * @param key - a Whisper catalogue key, or '' for "recommended".
   */
  async onLiveModel(key: string): Promise<void> {
    this.defaultLiveModel.set(key);
    await this.save();
  }

  /**
   * Updates the keep-audio-after-finalize preference and persists.
   * @param keep - whether to keep the recorded WAV after the offline pass.
   */
  async onKeepAudio(keep: boolean): Promise<void> {
    this.keepAudio.set(keep);
    await this.save();
  }

  /** Navigates to the Meeting transcription tab. */
  goToTab(): void {
    void this.router.navigateByUrl('/meeting-transcription');
  }
}
