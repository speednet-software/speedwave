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
  CategoryFlagPair,
  CustomPolicyDtoInput,
  PiiCategory,
  PiiCategoryPolicies,
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

/**
 * Editable row for a user-defined policy. `key` is a stable local identity for
 * `track`/data-testid; `id` is the last server-known id, empty until saved once.
 */
interface CustomPolicyRow {
  key: string;
  id: string;
  name: string;
  enabled: boolean;
  categories: PiiCategoryPolicies;
  patterns: CustomPatternRow[];
  sensitiveKeys: string[];
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

/**
 * Settings → Security: enable a set of built-in and/or custom PII policies,
 * each with per-category tokenize/log pairs. MDM-forced policies show locked.
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
        <div class="mt-4 space-y-2">
          <div class="mono text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            Policies
          </div>
          @for (t of templates(); track t.id) {
            <label
              class="flex items-start gap-2 rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2"
            >
              <input
                type="checkbox"
                class="mt-0.5 accent-[var(--accent)]"
                [checked]="isBuiltinEnabled(t.id)"
                [disabled]="isForced(t.id)"
                (change)="toggleBuiltin(t.id, $event)"
                [attr.data-testid]="'security-policy-' + t.id"
              />
              <div class="min-w-0 flex-1">
                <div class="text-[12px] font-medium text-[var(--ink)]">
                  {{ t.name }}
                  @if (isForced(t.id)) {
                    <span
                      class="mono ml-1 rounded bg-[var(--bg-3)] px-1.5 py-0.5 text-[10px] text-[var(--ink-dim)]"
                      [attr.data-testid]="'security-forced-' + t.id"
                    >
                      Enforced by organization
                    </span>
                  }
                </div>
                <div class="text-[11px] text-[var(--ink-dim)]">{{ t.description }}</div>
              </div>
            </label>
          }

          @for (row of customPolicies(); track row.key) {
            <div
              class="rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2"
              [attr.data-testid]="'security-custom-' + row.key"
            >
              <div class="flex items-center gap-2">
                <input
                  type="checkbox"
                  class="accent-[var(--accent)]"
                  [checked]="row.enabled"
                  [disabled]="isForced(row.id)"
                  (change)="toggleCustom(row.key, $event)"
                  [attr.data-testid]="'security-custom-' + row.key + '-enabled'"
                />
                <input
                  type="text"
                  placeholder="Policy name"
                  class="min-w-[8rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                  [value]="row.name"
                  (input)="onCustomNameInput(row.key, eventValue($event))"
                  [attr.data-testid]="'security-custom-' + row.key + '-name'"
                />
                @if (isForced(row.id)) {
                  <span
                    class="mono rounded bg-[var(--bg-3)] px-1.5 py-0.5 text-[10px] text-[var(--ink-dim)]"
                    [attr.data-testid]="'security-custom-' + row.key + '-forced'"
                  >
                    Enforced by organization
                  </span>
                }
                @if (rowNameError(row); as nameErr) {
                  <span class="text-[11px] text-[var(--red)]">{{ nameErr }}</span>
                }
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                  (click)="removeCustomPolicy(row.key)"
                  [attr.data-testid]="'security-custom-' + row.key + '-remove'"
                >
                  remove
                </button>
              </div>

              <div class="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
                @for (cat of categoryList; track cat) {
                  <div class="rounded border border-[var(--line)] px-2 py-1 text-[11px]">
                    <div class="text-[var(--ink-dim)]">{{ categoryLabels[cat] }}</div>
                    <label class="mr-2 inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        [checked]="row.categories[cat].tokenize"
                        (change)="onCustomCategoryToggle(row.key, cat, 'tokenize', $event)"
                        [attr.data-testid]="'security-custom-' + row.key + '-' + cat + '-tokenize'"
                      />
                      tokenize
                    </label>
                    <label class="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        [checked]="row.categories[cat].log"
                        (change)="onCustomCategoryToggle(row.key, cat, 'log', $event)"
                        [attr.data-testid]="'security-custom-' + row.key + '-' + cat + '-log'"
                      />
                      log
                    </label>
                  </div>
                }
              </div>

              <div class="mt-2">
                <div class="mono mb-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
                  Custom patterns
                </div>
                @for (pattern of row.patterns; track $index; let i = $index) {
                  <div class="mb-1 flex flex-wrap items-start gap-2">
                    <input
                      type="text"
                      placeholder="Display name"
                      class="min-w-[8rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                      [value]="pattern.displayName"
                      (input)="onPatternNameInput(row.key, i, eventValue($event))"
                      [attr.data-testid]="'security-custom-' + row.key + '-pattern-name-' + i"
                    />
                    <input
                      type="text"
                      placeholder="Regex pattern"
                      class="mono min-w-[10rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                      [value]="pattern.pattern"
                      (input)="onPatternRegexInput(row.key, i, eventValue($event))"
                      [attr.data-testid]="'security-custom-' + row.key + '-pattern-regex-' + i"
                    />
                    <button
                      type="button"
                      class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                      (click)="removePattern(row.key, i)"
                      [attr.data-testid]="'security-custom-' + row.key + '-pattern-remove-' + i"
                    >
                      remove
                    </button>
                    @if (patternErrorsFor(row.key)[i]; as err) {
                      <p
                        class="w-full text-[11px] text-[var(--red)]"
                        [attr.data-testid]="'security-custom-' + row.key + '-pattern-error-' + i"
                      >
                        {{ err }}
                      </p>
                    }
                  </div>
                }
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                  (click)="addPattern(row.key)"
                  [attr.data-testid]="'security-custom-' + row.key + '-pattern-add'"
                >
                  Add pattern
                </button>
              </div>

              <div class="mt-2">
                <div class="mono mb-1 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
                  Sensitive field names
                </div>
                @for (key of row.sensitiveKeys; track $index; let i = $index) {
                  <div class="mb-1 flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="e.g. salary"
                      class="mono flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                      [value]="key"
                      (input)="onKeyInput(row.key, i, eventValue($event))"
                      [attr.data-testid]="'security-custom-' + row.key + '-key-' + i"
                    />
                    <button
                      type="button"
                      class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                      (click)="removeKey(row.key, i)"
                      [attr.data-testid]="'security-custom-' + row.key + '-key-remove-' + i"
                    >
                      remove
                    </button>
                  </div>
                }
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                  (click)="addKey(row.key)"
                  [attr.data-testid]="'security-custom-' + row.key + '-key-add'"
                >
                  Add key name
                </button>
              </div>
            </div>
          }

          <button
            type="button"
            class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1.5 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
            (click)="addCustomPolicy()"
            data-testid="security-custom-add"
          >
            Add custom policy
          </button>
        </div>

        <div class="mt-4 rounded border border-[var(--line)] bg-[var(--bg-1)] px-4 py-3">
          <div class="mono mb-2 text-[10px] uppercase tracking-widest text-[var(--ink-mute)]">
            Effective categories (read-only, union of every enabled policy)
          </div>
          <div
            class="grid grid-cols-1 gap-1.5 text-[11px] text-[var(--ink)] sm:grid-cols-2 lg:grid-cols-4"
          >
            @for (cat of categoryList; track cat) {
              <div [attr.data-testid]="'security-effective-' + cat">
                {{ categoryLabels[cat] }}: tokenize
                {{ effectiveCategories()[cat].tokenize ? 'on' : 'off' }}, log
                {{ effectiveCategories()[cat].log ? 'on' : 'off' }}
              </div>
            }
          </div>
        </div>

        <div class="flex items-center justify-end gap-3 border-t border-[var(--line)] pt-4 mt-4">
          @if (saveError()) {
            <span class="mono text-[11px] text-[var(--red)]" data-testid="security-save-error">
              {{ saveError() }}
            </span>
          }
          @if (saved()) {
            <span class="mono text-[11px] text-[var(--green)]" data-testid="security-saved">
              Saved: restart to apply
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

  /** Enabled ids from the last load: built-in ids the checklist checks directly. */
  readonly enabledPolicies = signal<Set<string>>(new Set());
  /** MDM-forced ids (built-in or custom): checked, disabled, badge in the UI. */
  readonly forcedPolicies = signal<Set<string>>(new Set());
  readonly effectiveCategories = signal<PiiCategoryPolicies>(this.allOff());
  readonly customPolicies = signal<CustomPolicyRow[]>([]);

  private readonly loadedFormSnapshot = signal('');
  private nextRowKey = 0;

  readonly patternErrorsFor = (rowKey: string): (string | null)[] => {
    const row = this.customPolicies().find((r) => r.key === rowKey);
    return row ? row.patterns.map((p) => this.patternRowError(p)) : [];
  };

  readonly isDirty = computed<boolean>(
    () => this.computeFormSnapshot() !== this.loadedFormSnapshot()
  );

  readonly canSave = computed<boolean>(() => {
    if (!this.loaded() || !this.isDirty()) return false;
    return this.customPolicies().every(
      (row) =>
        this.rowNameError(row) === null &&
        row.patterns.every((p) => this.patternRowError(p) === null)
    );
  });

  private readonly tauri = inject(TauriService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly projectState = inject(ProjectStateService);
  private unsubProjectReady: (() => void) | null = null;

  protected readonly categoryList = ALL_CATEGORIES;
  protected readonly categoryLabels = CATEGORY_LABELS;
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

  private allOff(): PiiCategoryPolicies {
    return ALL_CATEGORIES.reduce(
      (acc, c) => ({ ...acc, [c]: { tokenize: false, log: false } }),
      {} as PiiCategoryPolicies
    );
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
    this.forcedPolicies.set(new Set(policy.forced_policies));
    this.enabledPolicies.set(new Set(policy.enabled_policies));
    this.effectiveCategories.set(policy.effective_categories);
    this.customPolicies.set(
      policy.custom_policies.map((c) => ({
        key: `srv-${c.id}`,
        id: c.id,
        name: c.name,
        enabled: policy.enabled_policies.includes(c.id),
        categories: c.categories,
        patterns: c.custom_patterns.map((p) => ({
          displayName: p.displayName,
          pattern: p.pattern,
          caseInsensitive: p.caseInsensitive,
        })),
        sensitiveKeys: c.sensitive_keys_add,
      }))
    );
  }

  /**
   * Whether a built-in template id is currently enabled (checklist state).
   * @param id - the template id.
   */
  isBuiltinEnabled(id: string): boolean {
    return this.enabledPolicies().has(id);
  }

  /**
   * Whether a policy id is MDM-forced: checked, disabled, badge shown.
   * @param id - the policy id (built-in or a custom policy's last-known id).
   */
  isForced(id: string): boolean {
    return id.length > 0 && this.forcedPolicies().has(id);
  }

  /**
   * Toggles a built-in template's enabled state; a forced id ignores the event.
   * @param id - the template id.
   * @param ev - the checkbox change event.
   */
  toggleBuiltin(id: string, ev: Event): void {
    if (this.isForced(id)) return;
    const on = eventChecked(ev);
    this.enabledPolicies.update((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /**
   * Toggles a custom policy row's enabled state; a forced id ignores the event.
   * @param key - the row's local key.
   * @param ev - the checkbox change event.
   */
  toggleCustom(key: string, ev: Event): void {
    const row = this.customPolicies().find((r) => r.key === key);
    if (row && this.isForced(row.id)) return;
    const on = eventChecked(ev);
    this.customPolicies.update((rows) =>
      rows.map((r) => (r.key === key ? { ...r, enabled: on } : r))
    );
  }

  /** Appends a new, enabled, all-off custom policy row. */
  addCustomPolicy(): void {
    const key = `new-${this.nextRowKey++}`;
    this.customPolicies.update((rows) => [
      ...rows,
      {
        key,
        id: '',
        name: '',
        enabled: true,
        categories: this.allOff(),
        patterns: [],
        sensitiveKeys: [],
      },
    ]);
  }

  /**
   * Removes a custom policy row.
   * @param key - the row's local key.
   */
  removeCustomPolicy(key: string): void {
    this.customPolicies.update((rows) => rows.filter((r) => r.key !== key));
  }

  /**
   * Updates a custom policy row's name.
   * @param key - the row's local key.
   * @param value - the new name.
   */
  onCustomNameInput(key: string, value: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) => (r.key === key ? { ...r, name: value } : r))
    );
  }

  /**
   * Toggles one category's tokenize or log flag on a custom policy row.
   * @param key - the row's local key.
   * @param cat - the category being toggled.
   * @param field - which half of the flag pair.
   * @param ev - the checkbox change event.
   */
  onCustomCategoryToggle(
    key: string,
    cat: PiiCategory,
    field: keyof CategoryFlagPair,
    ev: Event
  ): void {
    const on = eventChecked(ev);
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === key
          ? { ...r, categories: { ...r.categories, [cat]: { ...r.categories[cat], [field]: on } } }
          : r
      )
    );
  }

  /**
   * Appends an empty custom-pattern row to a policy.
   * @param rowKey - the owning policy row's local key.
   */
  addPattern(rowKey: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              patterns: [...r.patterns, { displayName: '', pattern: '', caseInsensitive: false }],
            }
          : r
      )
    );
  }

  /**
   * Removes a custom-pattern row from a policy.
   * @param rowKey - the owning policy row's local key.
   * @param i - the pattern row index.
   */
  removePattern(rowKey: string, i: number): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey ? { ...r, patterns: r.patterns.filter((_, idx) => idx !== i) } : r
      )
    );
  }

  /**
   * Updates a pattern row's display name.
   * @param rowKey - the owning policy row's local key.
   * @param i - the pattern row index.
   * @param value - the new display name.
   */
  onPatternNameInput(rowKey: string, i: number, value: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              patterns: r.patterns.map((p, idx) => (idx === i ? { ...p, displayName: value } : p)),
            }
          : r
      )
    );
  }

  /**
   * Updates a pattern row's regex source.
   * @param rowKey - the owning policy row's local key.
   * @param i - the pattern row index.
   * @param value - the new regex source.
   */
  onPatternRegexInput(rowKey: string, i: number, value: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              patterns: r.patterns.map((p, idx) => (idx === i ? { ...p, pattern: value } : p)),
            }
          : r
      )
    );
  }

  /**
   * Appends an empty sensitive-key row to a policy.
   * @param rowKey - the owning policy row's local key.
   */
  addKey(rowKey: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) => (r.key === rowKey ? { ...r, sensitiveKeys: [...r.sensitiveKeys, ''] } : r))
    );
  }

  /**
   * Removes a sensitive-key row from a policy.
   * @param rowKey - the owning policy row's local key.
   * @param i - the key row index.
   */
  removeKey(rowKey: string, i: number): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? { ...r, sensitiveKeys: r.sensitiveKeys.filter((_, idx) => idx !== i) }
          : r
      )
    );
  }

  /**
   * Updates a sensitive-key row's value.
   * @param rowKey - the owning policy row's local key.
   * @param i - the key row index.
   * @param value - the new key-name text.
   */
  onKeyInput(rowKey: string, i: number, value: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? { ...r, sensitiveKeys: r.sensitiveKeys.map((k, idx) => (idx === i ? value : k)) }
          : r
      )
    );
  }

  /**
   * Client-side pre-validation for a policy row's name; the server derives the
   * id from this and re-validates on save. Called directly from the template.
   * @param row - the policy row to validate.
   */
  protected rowNameError(row: CustomPolicyRow): string | null {
    return row.name.trim() ? null : 'Name is required';
  }

  /**
   * Client-side pre-validation for a custom-pattern row; the server is
   * authoritative and re-validates on save.
   * @param row - the pattern row to validate.
   */
  private patternRowError(row: CustomPatternRow): string | null {
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
    return JSON.stringify({
      enabled: Array.from(this.enabledPolicies()).sort(),
      custom: this.customPolicies().map((r) => ({
        name: r.name,
        enabled: r.enabled,
        categories: r.categories,
        patterns: r.patterns,
        sensitiveKeys: r.sensitiveKeys,
      })),
    });
  }

  private buildUpdate(): SecurityPolicyUpdate {
    const builtinIds = new Set(this.templates().map((t) => t.id));
    const policies = Array.from(this.enabledPolicies()).filter(
      (id) => builtinIds.has(id) && !this.isForced(id)
    );
    const custom_policies: CustomPolicyDtoInput[] = this.customPolicies().map((row) => ({
      name: row.name.trim(),
      enabled: row.enabled && !this.isForced(row.id),
      categories: row.categories,
      custom_patterns: row.patterns.map(
        (p): SecurityPolicyCustomPatternInput => ({
          display_name: p.displayName.trim(),
          pattern: p.pattern,
          case_insensitive: p.caseInsensitive,
        })
      ),
      // The server rejects uppercase sensitive keys by contract.
      sensitive_keys_add: row.sensitiveKeys
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 0),
    }));
    return { policies, custom_policies };
  }

  /** Persists the enabled policies + custom definitions, then requests a restart. */
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
      // on it being clear: never show "Saved" next to an error.
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
