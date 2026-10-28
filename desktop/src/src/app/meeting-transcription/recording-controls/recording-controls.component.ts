import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { TranscriptionService } from '../../services/transcription.service';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { IconComponent } from '../../shared/icon.component';
import {
  IMPORT_FORMATS_LABEL,
  type AudioSource,
  type AudioSourceInfo,
  type AudioSourceKind,
  type Language,
} from '../../models/transcript';
import { LANGUAGE_NAME, RECORD_SHORTCUT_HINT, recordingName } from '../recording-format';

/** Tooltip on "Transcribe later" next to the transcription status. */
const POSTPONE_TOOLTIP =
  'Stops these transcriptions so they do not slow this computer down during your next meeting. Open a recording and press Transcribe when you are ready.';
/** Tooltip on the chooser. */
const OPTIONS_TOOLTIP =
  'The language applies to Record and Import audio; the source applies to Record only.';
/** Tooltip on Record. */
const START_TOOLTIP =
  'Records system audio and your microphone on this machine. Nothing leaves your computer.';

/** Short source names for the chooser. */
const SOURCE_SHORT_LABEL: Record<AudioSourceKind, string> = {
  mixed: 'Whole meeting',
  system_wide: 'Other people only',
  microphone: 'Your microphone only',
  imported_file: 'Imported file',
};

/** A named input device for the microphone dropdown. */
interface MicChoice {
  uid: string;
  name: string;
}

/**
 * A source's mic device id, or null if it isn't a named-mic source.
 * @param s - the audio source.
 */
function micDeviceId(s: AudioSource): string | null {
  return s.kind === 'microphone' && s.device ? s.device : null;
}

/**
 * Strips the `Microphone: ` prefix from a source label for the dropdown.
 * @param label - the source's display label.
 */
function micName(label: string): string {
  return label.replace(/^Microphone:\s*/, '');
}

/**
 * Record (view header, idle): a chooser showing the language (for Record and Import audio) and the
 * source the next recording uses, remembered from the last one, then Import audio, the Record button
 * with its shortcut, and a muted status of the transcriptions still running, with Transcribe later.
 * Emits `started` and `imported`; errors go to the parent banner. ⌘⇧R / Ctrl+Shift+R starts.
 */
@Component({
  selector: 'app-recording-controls',
  standalone: true,
  imports: [TooltipDirective, IconComponent],
  host: {
    '(document:keydown)': 'onKeydown($event)',
    '(document:click)': 'onDocumentClick($event)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="relative flex flex-col items-end gap-1.5" data-testid="recording-controls">
      <div class="flex items-center gap-2" data-chooser-root>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border bg-[var(--bg-1)] px-2.5 py-1.5 text-[12px] hover:text-[var(--ink)]"
          [class]="
            optionsOpen()
              ? 'border-[var(--accent)] text-[var(--ink)]'
              : 'border-[var(--line)] text-[var(--ink-dim)]'
          "
          aria-haspopup="dialog"
          data-testid="recording-options"
          [appTooltip]="optionsTooltip"
          placement="bottom"
          [attr.aria-label]="'Options for Record and Import audio: ' + choiceLabel()"
          [attr.aria-expanded]="optionsOpen()"
          (click)="optionsOpen.set(!optionsOpen())"
        >
          {{ choiceLabel() }}
          <app-icon name="chevron-down" class="h-3 w-3" />
        </button>
        <span [appTooltip]="importTooltip()" placement="bottom">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--line)] bg-[var(--bg-1)] px-2.5 py-1.5 text-[12px] text-[var(--ink-dim)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="import-btn"
            [attr.aria-busy]="importing()"
            [disabled]="!canImport()"
            (click)="importFile()"
          >
            <app-icon name="document" class="h-3.5 w-3.5" />
            {{ importing() ? 'Importing…' : 'Import audio' }}
          </button>
        </span>
        <span [appTooltip]="startTooltip" [tooltipKbd]="shortcutHint" placement="bottom">
          <button
            type="button"
            class="mono inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="start-btn"
            [disabled]="!canStart()"
            (click)="start()"
          >
            <app-icon name="microphone" class="h-3.5 w-3.5" [strokeWidth]="2" />
            {{ busy() ? 'Starting…' : 'Record' }}
            <kbd
              class="rounded border border-black/20 bg-black/15 px-1 font-mono text-[10px] font-normal"
              >{{ shortcutHint }}</kbd
            >
          </button>
        </span>

        @if (optionsOpen()) {
          <div
            class="absolute right-0 top-full z-30 mt-2 w-[25rem] rounded-lg border border-[var(--line-strong)] bg-[var(--bg-2)] p-3.5 text-[12.5px] shadow-xl"
            role="dialog"
            aria-label="Recording options"
            data-testid="recording-options-panel"
          >
            <label class="mb-2.5 flex flex-col gap-1">
              <span class="text-[11.5px] text-[var(--ink-mute)]"
                >Language spoken, for Record and Import audio</span
              >
              <select
                class="min-w-0 truncate rounded border border-[var(--line-strong)] bg-[var(--bg-1)] py-1.5 pl-2 pr-8 text-[var(--ink)]"
                data-testid="language-select"
                (change)="onLanguage($any($event.target).value)"
              >
                <option value="pl" [selected]="language() === 'pl'">Polish</option>
                <option value="en" [selected]="language() === 'en'">English</option>
              </select>
            </label>
            <label class="mb-2.5 flex flex-col gap-1">
              <span class="text-[11.5px] text-[var(--ink-mute)]">What Record captures</span>
              <select
                class="min-w-0 truncate rounded border border-[var(--line-strong)] bg-[var(--bg-1)] py-1.5 pl-2 pr-8 text-[var(--ink)]"
                data-testid="source-select"
                (change)="onSource(+$any($event.target).value)"
              >
                @for (s of sources(); track $index) {
                  <option [value]="$index" [selected]="$index === sourceIndex()">
                    {{ s.label }}
                  </option>
                }
              </select>
            </label>
            @if (micSelectable() && mics().length > 0) {
              <label class="mb-2.5 flex flex-col gap-1">
                <span class="text-[11.5px] text-[var(--ink-mute)]">Microphone</span>
                <select
                  class="min-w-0 truncate rounded border border-[var(--line-strong)] bg-[var(--bg-1)] py-1.5 pl-2 pr-8 text-[var(--ink)]"
                  data-testid="mic-select"
                  (change)="onMic($any($event.target).value)"
                >
                  <option value="" [selected]="micDevice() === null">System default</option>
                  @for (m of mics(); track m.uid) {
                    <option [value]="m.uid" [selected]="m.uid === micDevice()">{{ m.name }}</option>
                  }
                </select>
              </label>
            }
            @if (mixedSourceSelected()) {
              <p class="mb-2 text-[11.5px] text-[var(--ink-mute)]" data-testid="mixed-source-note">
                Records the other participants (system audio) and your microphone. Your OS may ask
                for microphone and audio-recording permission the first time.
              </p>
            }
            <p class="border-t border-[var(--line)] pt-2.5 text-[11.5px] text-[var(--ink-mute)]">
              Remembered for your next recording and import.
            </p>
          </div>
        }
      </div>

      @if (transcribingNote(); as note) {
        <p
          class="flex items-center gap-1.5 text-[12px] text-[var(--ink-mute)]"
          role="status"
          data-testid="transcribing-note"
        >
          {{ note }}
          <button
            type="button"
            class="mono shrink-0 whitespace-nowrap rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40"
            data-testid="postpone-all"
            [appTooltip]="postponeTooltip"
            [disabled]="postponing()"
            (click)="postponeAll()"
          >
            Transcribe later
          </button>
        </p>
      }
      @if (modelsKnown() && !hasModel()) {
        <p
          class="max-w-md text-right text-[11.5px] text-[var(--ink-mute)]"
          data-testid="no-model-note"
        >
          No speech recognition model is downloaded yet. Download it in Settings → Meeting
          transcription.
        </p>
      }
      @if (hasModel() && missingFinalizeModel(); as missing) {
        <p
          class="max-w-md text-right text-[11.5px] text-[var(--amber)]"
          data-testid="finalize-model-warning"
        >
          Transcripts are made with the smaller model until the high-quality one ({{ missing }}) is
          downloaded in Settings.
        </p>
      }
    </div>
  `,
})
export class RecordingControlsComponent implements OnInit {
  /** Emitted with the new session id once recording starts. */
  readonly started = output<string>();
  /** Emitted with the new session id once an audio file is imported. */
  readonly imported = output<string>();
  /** Forwards errors to the parent banner. */
  readonly errorOccurred = output<string>();

  /** Forced language (never auto-detect). */
  readonly language = signal<Language>('pl');
  /** Audio sources from the host backend. */
  readonly sources = signal<AudioSourceInfo[]>([]);
  /** Index into `sources()` of the chosen source. */
  readonly sourceIndex = signal(0);
  /** Disables Record while a start is in flight. */
  readonly busy = signal(false);
  /** Disables Import audio while the picked file is decoded. */
  readonly importing = signal(false);
  /** Whether the language/source pickers are open. */
  readonly optionsOpen = signal(false);
  private readonly transcription = inject(TranscriptionService);
  readonly modelsKnown = computed(() => this.transcription.modelReady() !== null);
  readonly hasModel = computed(() => this.transcription.modelReady() === true);
  readonly missingFinalizeModel = computed(() => {
    const fin = this.transcription.recommended()?.finalize;
    return fin && !fin.downloaded && !fin.downloading ? fin.display_name : null;
  });
  /** `true` when the chosen source is the mixed (system + mic) one. */
  readonly mixedSourceSelected = computed(
    () => this.sources()[this.sourceIndex()]?.source.kind === 'mixed'
  );
  /** Chosen mic device id (UID on macOS, name on Windows); null = system default. */
  readonly micDevice = signal<string | null>(null);
  /** Named input devices, derived from the source list. */
  readonly mics = computed<MicChoice[]>(() =>
    this.sources()
      .filter((s) => micDeviceId(s.source) !== null)
      .map((s) => ({ uid: micDeviceId(s.source) as string, name: micName(s.label) }))
  );
  /** Whether the chosen source uses a mic (mixed or mic-only) — shows the picker. */
  readonly micSelectable = computed(() => {
    const k = this.sources()[this.sourceIndex()]?.source.kind;
    return k === 'mixed' || k === 'microphone';
  });

  private readonly cdr = inject(ChangeDetectorRef);

  /** "Polish · Whole meeting": what the next recording uses, on the chooser. */
  readonly choiceLabel = computed(() => {
    const lang = LANGUAGE_NAME[this.language()];
    const kind = this.sources()[this.sourceIndex()]?.source.kind;
    return kind ? `${lang} · ${SOURCE_SHORT_LABEL[kind]}` : lang;
  });

  /** What is still being transcribed: one recording with its progress, or how many ('' when none). */
  readonly transcribingNote = computed(() => {
    const busy = this.transcription.transcribing();
    if (busy.length > 1) return `Transcribing ${busy.length} recordings`;
    const [rec] = busy;
    if (!rec || rec.status.state !== 'finalizing') return '';
    return rec.queued
      ? `Waiting to transcribe ${recordingName(rec)}`
      : `Transcribing ${recordingName(rec)} · ${Math.round(rec.status.progress * 100)}%`;
  });

  /** Whether Record can be pressed now: not while an import is picked or decoded. */
  readonly canStart = computed(
    () => this.idleWithModel() && !this.transcription.captureOpen() && this.sources().length > 0
  );

  /** Whether Import audio can be pressed now. */
  readonly canImport = computed(() => this.idleWithModel());

  /** Nothing is starting or importing, and no model is known to be missing. */
  private readonly idleWithModel = computed(
    () => !this.importing() && !this.busy() && !(this.modelsKnown() && !this.hasModel())
  );

  /** Tooltip on Import audio: what it takes, and the language from the chooser it transcribes in. */
  readonly importTooltip = computed(
    () =>
      `Adds an audio or video file (${IMPORT_FORMATS_LABEL}) to your recordings and transcribes ` +
      `it in ${LANGUAGE_NAME[this.language()]}, the language set on the left. ` +
      'Nothing leaves your computer.'
  );

  protected readonly startTooltip = START_TOOLTIP;
  protected readonly optionsTooltip = OPTIONS_TOOLTIP;
  protected readonly postponeTooltip = POSTPONE_TOOLTIP;

  /** `true` while "Transcribe later" puts the running transcriptions off. */
  readonly postponing = signal(false);
  protected readonly shortcutHint = RECORD_SHORTCUT_HINT;

  /** Restores the remembered language at once, so Import audio has it, then loads the sources. */
  async ngOnInit(): Promise<void> {
    const saved = this.transcription.recordingChoice();
    if (saved) this.language.set(saved.language);
    try {
      const list = await this.transcription.listAudioSources();
      this.sources.set(list);
      this.restoreChoice(list);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.cdr.markForCheck();
  }

  /**
   * Picks the remembered source and microphone (ngOnInit already restored the language); without
   * one, the mixed source, else system audio.
   * @param list - the freshly-loaded source list.
   */
  private restoreChoice(list: AudioSourceInfo[]): void {
    const saved = this.transcription.recordingChoice();
    const savedIdx = saved ? list.findIndex((s) => s.source.kind === saved.source) : -1;
    if (saved && savedIdx >= 0) {
      this.sourceIndex.set(savedIdx);
      const known = saved.mic === null || this.mics().some((m) => m.uid === saved.mic);
      this.micDevice.set(known ? saved.mic : null);
      return;
    }
    const mixedIdx = list.findIndex((s) => s.source.kind === 'mixed');
    const sysIdx = list.findIndex((s) => s.source.kind === 'system_wide');
    this.sourceIndex.set(mixedIdx >= 0 ? mixedIdx : sysIdx >= 0 ? sysIdx : 0);
  }

  /**
   * Updates the forced language and remembers it.
   * @param v - 'pl' or 'en'.
   */
  onLanguage(v: string): void {
    if (v !== 'pl' && v !== 'en') return;
    this.language.set(v);
    this.saveChoice();
  }

  /**
   * Updates the chosen source and remembers it.
   * @param i - index into `sources()`.
   */
  onSource(i: number): void {
    if (i < 0 || i >= this.sources().length) return;
    this.sourceIndex.set(i);
    this.saveChoice();
  }

  /**
   * Updates the chosen mic device and remembers it.
   * @param uid - device id, or '' for the system default.
   */
  onMic(uid: string): void {
    this.micDevice.set(uid === '' ? null : uid);
    this.saveChoice();
  }

  /**
   * Closes the pickers on a click outside them.
   * @param event - any click in the document.
   */
  onDocumentClick(event: MouseEvent): void {
    if (!this.optionsOpen()) return;
    const target = event.target as Element | null;
    if (!target?.closest?.('[data-chooser-root]')) this.optionsOpen.set(false);
  }

  /**
   * ⌘⇧R / Ctrl+Shift+R starts a recording (the recording bar handles it while one runs).
   * @param event - the document keydown.
   */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.optionsOpen()) {
      this.optionsOpen.set(false);
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'r') {
      return;
    }
    event.preventDefault();
    if (this.canStart()) void this.start();
  }

  /**
   * Puts off every transcription still running or queued, so the next meeting has the processor.
   * A refusal for a recording that finished meanwhile is no error; any other names its recording.
   */
  async postponeAll(): Promise<void> {
    this.postponing.set(true);
    const busy = this.transcription.transcribing();
    const results = await Promise.allSettled(busy.map((r) => this.transcription.postpone(r.id)));
    this.postponing.set(false);
    const stillBusy = new Set(this.transcription.transcribing().map((r) => r.id));
    const failed = busy.filter((r, i) => results[i].status === 'rejected' && stillBusy.has(r.id));
    if (failed.length === 0) return;
    const first = results[busy.indexOf(failed[0])] as PromiseRejectedResult;
    const reason: unknown = first.reason;
    const names = failed.map((r) => `"${recordingName(r)}"`).join(', ');
    this.errorOccurred.emit(
      `Could not put off ${names}: ${reason instanceof Error ? reason.message : String(reason)}`
    );
  }

  /** Starts recording the chosen source in the chosen language. */
  async start(): Promise<void> {
    const picked: AudioSource | undefined = this.sources()[this.sourceIndex()]?.source;
    if (!picked) {
      this.errorOccurred.emit('no audio source selected');
      return;
    }
    const src = this.applyMic(picked);
    this.optionsOpen.set(false);
    this.busy.set(true);
    try {
      if (src.kind !== 'system_wide' && !(await this.ensureMicConsent())) {
        return;
      }
      this.saveChoice();
      const ack = await this.transcription.startRecording(
        src,
        this.language(),
        this.transcription.liveTranscriptPreferred()
      );
      this.started.emit(ack.session_id);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
      this.cdr.markForCheck();
    }
  }

  /** Asks for an audio file and transcribes it in the chosen language; a closed picker is no error. */
  async importFile(): Promise<void> {
    this.optionsOpen.set(false);
    this.importing.set(true);
    try {
      const id = await this.transcription.importFile(this.language());
      if (id) this.imported.emit(id);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    } finally {
      this.importing.set(false);
      this.cdr.markForCheck();
    }
  }

  /** Stores the language, source and microphone for the next recording and import; with no capture source loaded, it keeps the stored source. */
  private saveChoice(): void {
    const saved = this.transcription.recordingChoice();
    this.transcription.setRecordingChoice({
      language: this.language(),
      source: this.sources()[this.sourceIndex()]?.source.kind ?? saved?.source ?? 'mixed',
      mic: this.micDevice(),
    });
  }

  /**
   * Overlays the chosen mic onto a mixed/mic source (no-op for others).
   * @param src - the picked source.
   */
  private applyMic(src: AudioSource): AudioSource {
    const mic = this.micDevice();
    if (src.kind === 'mixed') return { ...src, mic };
    if (src.kind === 'microphone') return { ...src, device: mic };
    return src;
  }

  /**
   * Resolves mic consent before a mic-including capture starts; on refusal
   * surfaces the error and, for an earlier refusal, deep-links to Settings.
   */
  private async ensureMicConsent(): Promise<boolean> {
    const verdict = await this.transcription.requestMicrophonePermission();
    if (verdict === 'granted') return true;
    if (verdict === 'previously_denied') {
      await this.transcription.openMicrophonePrivacyPane().catch(() => undefined);
    }
    this.errorOccurred.emit(
      'microphone permission denied — enable Speedwave under System Settings → ' +
        'Privacy & Security → Microphone, then start again'
    );
    return false;
  }
}
