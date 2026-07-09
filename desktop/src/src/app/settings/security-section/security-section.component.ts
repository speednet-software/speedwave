import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { eventChecked, eventValue } from '../../shared/dom-event';
import type {
  PiiCategory,
  PiiCategoryFlags,
  SecurityPolicyCustomPatternInput,
  SecurityPolicyResponse,
  SecurityPolicyTemplateInfo,
  SecurityPolicyUpdate,
} from '../../models/security-policy';

/** Editable row for a custom detection pattern (server derives the token id). */
interface CustomPatternRow {
  displayName: string;
  pattern: string;
  caseInsensitive: boolean;
}

/** Every built-in category, in the contract's declaration order (Rust `PiiCategory::ALL`). */
const ALL_CATEGORIES: readonly PiiCategory[] = [
  'EMAIL',
  'PHONE_PL',
  'PESEL',
  'NIP',
  'IBAN',
  'CARD',
  'API_KEY',
  'SENSITIVE_FIELD',
];

/** Human-readable label per category, shown in the checkbox rows. */
const CATEGORY_LABELS: Record<PiiCategory, string> = {
  EMAIL: 'Email addresses',
  PHONE_PL: 'Polish phone numbers',
  PESEL: 'PESEL',
  NIP: 'NIP',
  IBAN: 'IBAN',
  CARD: 'Payment cards',
  API_KEY: 'API keys',
  SENSITIVE_FIELD: 'Sensitive field names',
};

const CUSTOM_TEMPLATE_ID = 'custom';

/**
 * Settings → Security: pick a built-in PII policy template or define a custom
 * one (categories, detection patterns, sensitive key names).
 */
@Component({
  selector: 'app-security-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      id="section-security"
      class="border-t border-[var(--line)] pt-6"
      data-testid="settings-section-security"
    >
      <h2 class="view-title view-title-section text-[var(--ink)]">Security</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        Tokenize sensitive data before it reaches the model.
      </p>

      @if (error() && !saveError()) {
        <p class="mt-2 text-[12px] text-[var(--red)]" data-testid="security-error">
          {{ error() }}
        </p>
      }

      @if (loaded()) {
        <div
          class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
          role="radiogroup"
          aria-label="Policy template"
        >
          @for (t of templates(); track t.id) {
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="selectedTemplate() === t.id"
              class="rounded border px-3 py-2 text-left"
              [class]="
                selectedTemplate() === t.id
                  ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
                  : 'border-[var(--line)] bg-[var(--bg-1)] hover:border-[var(--line-strong)]'
              "
              [attr.data-testid]="'security-template-' + t.id"
              (click)="selectTemplate(t.id, t.categories)"
            >
              <div
                class="mono text-[11px] font-medium"
                [class]="
                  selectedTemplate() === t.id ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'
                "
              >
                {{ selectedTemplate() === t.id ? '● ' : '○ ' }}{{ t.name }}
              </div>
              <div class="mt-1 text-[11px] leading-relaxed text-[var(--ink-dim)]">
                {{ t.description }}
              </div>
            </button>
          }
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="selectedTemplate() === customId"
            class="rounded border px-3 py-2 text-left"
            [class]="
              selectedTemplate() === customId
                ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
                : 'border-[var(--line)] bg-[var(--bg-1)] hover:border-[var(--line-strong)]'
            "
            data-testid="security-template-custom"
            (click)="selectCustom()"
          >
            <div
              class="mono text-[11px] font-medium"
              [class]="
                selectedTemplate() === customId ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'
              "
            >
              {{ selectedTemplate() === customId ? '● ' : '○ ' }}Custom
            </div>
            <div class="mt-1 text-[11px] leading-relaxed text-[var(--ink-dim)]">
              Choose your own categories, patterns, and sensitive key names.
            </div>
          </button>
        </div>

        <div class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-4 py-3">
          <div class="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            Categories
            @if (!isCustom()) {
              <span class="normal-case tracking-normal">(read-only — pick Custom to edit)</span>
            }
          </div>
          <div class="space-y-1.5 text-[11px] text-[var(--ink)]">
            @for (cat of categoryList; track cat) {
              <label class="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  class="accent-[var(--accent)]"
                  [checked]="categories()[cat]"
                  [disabled]="!isCustom()"
                  (change)="onCategoryToggle(cat, $event)"
                  [attr.data-testid]="'security-category-' + cat"
                />
                {{ categoryLabels[cat] }}
              </label>
            }
          </div>
        </div>

        @if (isCustom()) {
          <div class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-4 py-3">
            <div class="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
              Custom patterns
            </div>
            <div class="space-y-2">
              @for (row of customPatterns(); track $index; let i = $index) {
                <div class="flex flex-wrap items-start gap-2">
                  <input
                    type="text"
                    placeholder="Display name"
                    class="min-w-[10rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                    [value]="row.displayName"
                    (input)="onPatternNameInput(i, eventValue($event))"
                    [attr.data-testid]="'security-pattern-name-' + i"
                  />
                  <input
                    type="text"
                    placeholder="Regex pattern"
                    class="mono min-w-[12rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                    [value]="row.pattern"
                    (input)="onPatternRegexInput(i, eventValue($event))"
                    [attr.data-testid]="'security-pattern-regex-' + i"
                  />
                  <button
                    type="button"
                    class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                    (click)="removePattern(i)"
                    [attr.data-testid]="'security-pattern-remove-' + i"
                  >
                    remove
                  </button>
                  @if (patternErrors()[i]; as err) {
                    <p
                      class="w-full text-[11px] text-[var(--red)]"
                      [attr.data-testid]="'security-pattern-error-' + i"
                    >
                      {{ err }}
                    </p>
                  }
                </div>
              }
            </div>
            <button
              type="button"
              class="mono mt-2 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
              (click)="addPattern()"
              data-testid="security-pattern-add"
            >
              Add pattern
            </button>
          </div>

          <div class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-4 py-3">
            <div class="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
              Sensitive field names
            </div>
            <div class="space-y-2">
              @for (key of sensitiveKeys(); track $index; let i = $index) {
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="e.g. salary"
                    class="mono flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                    [value]="key"
                    (input)="onKeyInput(i, eventValue($event))"
                    [attr.data-testid]="'security-key-' + i"
                  />
                  <button
                    type="button"
                    class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                    (click)="removeKey(i)"
                    [attr.data-testid]="'security-key-remove-' + i"
                  >
                    remove
                  </button>
                </div>
              }
            </div>
            <button
              type="button"
              class="mono mt-2 rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
              (click)="addKey()"
              data-testid="security-key-add"
            >
              Add key name
            </button>
          </div>
        }

        <div class="flex items-center justify-end gap-3 border-t border-[var(--line)] pt-4 mt-4">
          @if (saveError()) {
            <span class="mono text-[11px] text-[var(--red)]" data-testid="security-save-error">
              {{ saveError() }}
            </span>
          }
          @if (saved()) {
            <span class="mono text-[11px] text-[var(--green)]" data-testid="security-saved">
              Saved — restart to apply
            </span>
          }
          <button
            type="button"
            class="mono rounded bg-[var(--accent)] px-4 py-1.5 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            [disabled]="!canSave() || saving()"
            (click)="save()"
            data-testid="security-save"
          >
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      }
    </section>
  `,
})
export class SecuritySectionComponent implements OnInit, OnDestroy {
  /** Forwards errors to the Settings shell banner. */
  readonly errorOccurred = output<string>();

  readonly templates = signal<SecurityPolicyTemplateInfo[]>([]);
  readonly error = signal('');
  readonly saveError = signal('');
  readonly saving = signal(false);
  readonly saved = signal(false);
  /** False until the first get_security_policy resolves; gates the form + Save. */
  readonly loaded = signal(false);

  readonly selectedTemplate = signal<string>(CUSTOM_TEMPLATE_ID);
  readonly categories = signal<PiiCategoryFlags>(this.allCategoriesOn());
  readonly customPatterns = signal<CustomPatternRow[]>([]);
  readonly sensitiveKeys = signal<string[]>([]);

  private readonly loadedFormSnapshot = signal('');

  readonly isCustom = computed(() => this.selectedTemplate() === CUSTOM_TEMPLATE_ID);

  /** Inline validation per custom-pattern row (empty until the row is filled in). */
  readonly patternErrors = computed<(string | null)[]>(() =>
    this.customPatterns().map((row) => this.rowError(row))
  );

  readonly isDirty = computed<boolean>(
    () => this.computeFormSnapshot() !== this.loadedFormSnapshot()
  );

  readonly canSave = computed<boolean>(() => {
    if (!this.loaded() || !this.isDirty()) return false;
    if (!this.isCustom()) return true;
    return this.patternErrors().every((e) => e === null);
  });

  private readonly tauri = inject(TauriService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly projectState = inject(ProjectStateService);
  private unsubProjectReady: (() => void) | null = null;

  protected readonly categoryList = ALL_CATEGORIES;
  protected readonly categoryLabels = CATEGORY_LABELS;
  protected readonly customId = CUSTOM_TEMPLATE_ID;
  protected readonly eventValue = eventValue;

  /** Loads templates + the current policy on first paint; reloads on project switch. */
  ngOnInit(): void {
    void this.refresh();
    this.unsubProjectReady = this.projectState.onProjectReady(() => {
      void this.refresh();
    });
  }

  /** Unsubscribes the project-ready listener. */
  ngOnDestroy(): void {
    this.unsubProjectReady?.();
    this.unsubProjectReady = null;
  }

  private allCategoriesOn(): PiiCategoryFlags {
    return ALL_CATEGORIES.reduce((acc, c) => ({ ...acc, [c]: true }), {} as PiiCategoryFlags);
  }

  private async refresh(): Promise<void> {
    try {
      const [templates, policy] = await Promise.all([
        this.tauri.invoke<SecurityPolicyTemplateInfo[]>('list_security_policy_templates'),
        this.tauri.invoke<SecurityPolicyResponse>('get_security_policy'),
      ]);
      this.templates.set(templates);
      this.applyPolicy(policy);
      this.error.set('');
      this.loadedFormSnapshot.set(this.computeFormSnapshot());
      this.loaded.set(true);
    } catch (e: unknown) {
      this.emitError(e);
    }
    this.cdr.markForCheck();
  }

  private applyPolicy(policy: SecurityPolicyResponse): void {
    this.selectedTemplate.set(policy.template);
    this.categories.set(policy.categories);
    this.customPatterns.set(
      policy.custom_patterns.map((p) => ({
        displayName: p.displayName,
        pattern: p.pattern,
        caseInsensitive: p.caseInsensitive,
      }))
    );
    this.sensitiveKeys.set(policy.sensitive_keys_add);
  }

  /**
   * Selects a built-in template card; its category map replaces the form's
   * (read-only until the user switches to Custom).
   * @param id - the template id.
   * @param categories - the template's category map, shown read-only.
   */
  selectTemplate(id: string, categories: PiiCategoryFlags): void {
    this.selectedTemplate.set(id);
    this.categories.set(categories);
  }

  /** Selects the Custom card, exposing the editable category/pattern/key controls. */
  selectCustom(): void {
    this.selectedTemplate.set(CUSTOM_TEMPLATE_ID);
  }

  /**
   * Toggles one category; turning a category OFF weakens detection, so it
   * requires an explicit confirm (mirrors telemetry's privacy-gate confirm).
   * @param cat - the category being toggled.
   * @param ev - the checkbox change event.
   */
  onCategoryToggle(cat: PiiCategory, ev: Event): void {
    const on = eventChecked(ev);
    if (!on && !confirm(`Turning off "${CATEGORY_LABELS[cat]}" weakens PII detection. Continue?`)) {
      (ev.target as HTMLInputElement).checked = true;
      return;
    }
    this.categories.update((c) => ({ ...c, [cat]: on }));
  }

  /** Appends an empty custom-pattern row. */
  addPattern(): void {
    this.customPatterns.update((rows) => [
      ...rows,
      { displayName: '', pattern: '', caseInsensitive: false },
    ]);
  }

  /**
   * Removes a custom-pattern row.
   * @param i - the row index.
   */
  removePattern(i: number): void {
    this.customPatterns.update((rows) => rows.filter((_, idx) => idx !== i));
  }

  /**
   * Updates a pattern row's display name.
   * @param i - the row index.
   * @param value - the new display name.
   */
  onPatternNameInput(i: number, value: string): void {
    this.customPatterns.update((rows) =>
      rows.map((r, idx) => (idx === i ? { ...r, displayName: value } : r))
    );
  }

  /**
   * Updates a pattern row's regex source.
   * @param i - the row index.
   * @param value - the new regex source.
   */
  onPatternRegexInput(i: number, value: string): void {
    this.customPatterns.update((rows) =>
      rows.map((r, idx) => (idx === i ? { ...r, pattern: value } : r))
    );
  }

  /** Appends an empty sensitive-key row. */
  addKey(): void {
    this.sensitiveKeys.update((keys) => [...keys, '']);
  }

  /**
   * Removes a sensitive-key row.
   * @param i - the row index.
   */
  removeKey(i: number): void {
    this.sensitiveKeys.update((keys) => keys.filter((_, idx) => idx !== i));
  }

  /**
   * Updates a sensitive-key row's value.
   * @param i - the row index.
   * @param value - the new key-name text.
   */
  onKeyInput(i: number, value: string): void {
    this.sensitiveKeys.update((keys) => keys.map((k, idx) => (idx === i ? value : k)));
  }

  /**
   * Client-side pre-validation for a custom-pattern row; the server is
   * authoritative and re-validates on save.
   * @param row - the pattern row to validate.
   */
  private rowError(row: CustomPatternRow): string | null {
    if (!row.displayName.trim()) return 'Name is required';
    if (!row.pattern.trim()) return 'Pattern is required';
    try {
      new RegExp(row.pattern);
    } catch (e: unknown) {
      return e instanceof Error ? e.message : 'Invalid pattern';
    }
    return null;
  }

  private computeFormSnapshot(): string {
    return [
      this.selectedTemplate(),
      JSON.stringify(this.categories()),
      JSON.stringify(this.customPatterns()),
      JSON.stringify(this.sensitiveKeys()),
    ].join('|');
  }

  private buildUpdate(): SecurityPolicyUpdate {
    const custom = this.isCustom();
    const customPatterns: SecurityPolicyCustomPatternInput[] = custom
      ? this.customPatterns().map((p) => ({
          display_name: p.displayName,
          pattern: p.pattern,
          case_insensitive: p.caseInsensitive,
        }))
      : [];
    // The server rejects uppercase sensitive keys by contract.
    const sensitiveKeysAdd = custom
      ? this.sensitiveKeys()
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0)
      : [];
    return {
      template: this.selectedTemplate(),
      categories: this.categories(),
      custom_patterns: customPatterns,
      sensitive_keys_add: sensitiveKeysAdd,
    };
  }

  /** Persists the selected template/categories/patterns/keys, then requests a restart. */
  async save(): Promise<void> {
    this.saving.set(true);
    this.saved.set(false);
    this.saveError.set('');
    this.cdr.markForCheck();
    try {
      const update = this.buildUpdate();
      await this.tauri.invoke('update_security_policy', { update });
      await this.refresh();
      // refresh() swallows its own errors into error(), so gate success feedback
      // on it being clear — never show "Saved" next to an error.
      if (this.error()) {
        this.saveError.set(this.error());
      } else {
        this.projectState.requestRestart();
        this.saved.set(true);
        setTimeout(() => {
          this.saved.set(false);
          this.cdr.markForCheck();
        }, 2000);
      }
    } catch (e: unknown) {
      this.emitError(e);
      this.saveError.set(this.error());
    }
    this.saving.set(false);
    this.cdr.markForCheck();
  }

  private emitError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.error.set(msg);
    this.errorOccurred.emit(msg);
  }
}
