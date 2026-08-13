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
  CustomPolicyDtoInput,
  KeywordV3,
  PiiRuleInfo,
  RuleCategories,
  RuleFlags,
  SecurityPolicyCustomPatternInput,
  SecurityPolicyResponse,
  SecurityPolicyTemplateInfo,
  SecurityPolicyUpdate,
} from '../../models/security-policy';

/** Editable row for a custom detection pattern (server derives the rule id). */
interface CustomPatternRow {
  displayName: string;
  pattern: string;
  caseInsensitive: boolean;
}

/** Editable row for a keyword substitution. */
interface KeywordRow {
  match: string;
  alias: string;
  caseSensitive: boolean;
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
  categories: RuleCategories;
  patterns: CustomPatternRow[];
  keywords: KeywordRow[];
}

const OFF_FLAGS: RuleFlags = { tokenize: false, log: false };

/**
 * Settings → Security: enable a set of built-in and/or custom PII policies,
 * each with per-category tokenize/log pairs. Categories are an open rule-id
 * set fetched from the library (`list_pii_rules`), not a fixed enum.
 * MDM-forced policies show locked.
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
                @for (cat of categories(); track cat.id) {
                  <div class="rounded border border-[var(--line)] px-2 py-1 text-[11px]">
                    <div class="text-[var(--ink-dim)]">{{ cat.display_name }}</div>
                    <label class="mr-2 inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        [checked]="rowCategoryFlags(row, cat.id).tokenize"
                        (change)="onCustomCategoryToggle(row.key, cat.id, 'tokenize', $event)"
                        [attr.data-testid]="
                          'security-custom-' + row.key + '-' + cat.id + '-tokenize'
                        "
                      />
                      tokenize
                    </label>
                    <label class="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        [checked]="rowCategoryFlags(row, cat.id).log"
                        (change)="onCustomCategoryToggle(row.key, cat.id, 'log', $event)"
                        [attr.data-testid]="'security-custom-' + row.key + '-' + cat.id + '-log'"
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
                  Keywords
                </div>
                @for (keyword of row.keywords; track $index; let i = $index) {
                  <div class="mb-1 flex flex-wrap items-start gap-2">
                    <input
                      type="text"
                      placeholder="Match (3–128 chars)"
                      class="min-w-[10rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                      [value]="keyword.match"
                      (input)="onKeywordMatchInput(row.key, i, eventValue($event))"
                      [attr.data-testid]="'security-custom-' + row.key + '-keyword-match-' + i"
                    />
                    <input
                      type="text"
                      placeholder="Alias ([A-Za-z][A-Za-z0-9]*)"
                      class="min-w-[8rem] flex-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--ink)]"
                      [value]="keyword.alias"
                      (input)="onKeywordAliasInput(row.key, i, eventValue($event))"
                      [attr.data-testid]="'security-custom-' + row.key + '-keyword-alias-' + i"
                    />
                    <label class="flex items-center gap-1 text-[11px] text-[var(--ink-dim)]">
                      <input
                        type="checkbox"
                        [checked]="keyword.caseSensitive"
                        (change)="onKeywordCaseSensitiveToggle(row.key, i, $event)"
                        [attr.data-testid]="
                          'security-custom-' + row.key + '-keyword-casesensitive-' + i
                        "
                      />
                      case-sensitive
                    </label>
                    <button
                      type="button"
                      class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                      (click)="removeKeyword(row.key, i)"
                      [attr.data-testid]="'security-custom-' + row.key + '-keyword-remove-' + i"
                    >
                      remove
                    </button>
                    @if (keywordErrorsFor(row.key)[i]; as err) {
                      <p
                        class="w-full text-[11px] text-[var(--red)]"
                        [attr.data-testid]="'security-custom-' + row.key + '-keyword-error-' + i"
                      >
                        {{ err }}
                      </p>
                    }
                  </div>
                }
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
                  (click)="addKeyword(row.key)"
                  [attr.data-testid]="'security-custom-' + row.key + '-keyword-add'"
                >
                  Add keyword
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
            @for (cat of categories(); track cat.id) {
              <div [attr.data-testid]="'security-effective-' + cat.id">
                {{ cat.display_name }}: tokenize
                {{ effectiveCategoryFlags(cat.id).tokenize ? 'on' : 'off' }}, log
                {{ effectiveCategoryFlags(cat.id).log ? 'on' : 'off' }}
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
  /** Every known PII rule id + label, fetched from the library (`list_pii_rules`). */
  readonly categories = signal<PiiRuleInfo[]>([]);
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
  /** Rule id -> flags, built from the last load's `effective_rules`; a missing id is off. */
  readonly effectiveCategories = signal<RuleCategories>({});
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
        row.patterns.every((p) => this.patternRowError(p) === null) &&
        row.keywords.every((k) => this.keywordRowError(k) === null)
    );
  });

  private readonly tauri = inject(TauriService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly projectState = inject(ProjectStateService);
  private unsubProjectReady: (() => void) | null = null;

  protected readonly eventValue = eventValue;

  /** Loads categories/templates/policy on first paint; reloads on project switch. */
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

  /**
   * A custom row's flags for one category id, defaulting to off when the row
   * has never toggled that id (the row's map only carries entries a user touched).
   * @param row - the policy row.
   * @param categoryId - the rule id.
   */
  protected rowCategoryFlags(row: CustomPolicyRow, categoryId: string): RuleFlags {
    return row.categories[categoryId] ?? OFF_FLAGS;
  }

  /**
   * The resolved effective flags for one category id, defaulting to off when
   * the id is absent from `effective_rules` (nothing in the enabled set turns it on).
   * @param categoryId - the rule id.
   */
  protected effectiveCategoryFlags(categoryId: string): RuleFlags {
    return this.effectiveCategories()[categoryId] ?? OFF_FLAGS;
  }

  private async refresh(): Promise<void> {
    try {
      const [categories, templates, policy] = await Promise.all([
        this.tauri.invoke<PiiRuleInfo[]>('list_pii_rules'),
        this.tauri.invoke<SecurityPolicyTemplateInfo[]>('list_security_policy_templates'),
        this.tauri.invoke<SecurityPolicyResponse>('get_security_policy'),
      ]);
      this.categories.set(categories);
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
    this.effectiveCategories.set(
      Object.fromEntries(
        policy.effective_rules.map((r) => [r.id, { tokenize: r.tokenize, log: r.log }])
      )
    );
    this.customPolicies.set(
      policy.custom_policies.map((c) => ({
        key: `srv-${c.id}`,
        id: c.id,
        name: c.name,
        enabled: policy.enabled_policies.includes(c.id),
        categories: c.categories,
        patterns: c.rules.map((r) => ({
          displayName: r.displayName,
          pattern: r.patterns[0] ?? '',
          caseInsensitive: !r.caseSensitive,
        })),
        keywords: c.keywords.map((k) => ({
          match: k.match,
          alias: k.alias,
          caseSensitive: k.caseSensitive,
        })),
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
        categories: {},
        patterns: [],
        keywords: [],
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
   * @param categoryId - the rule id being toggled.
   * @param field - which half of the flag pair.
   * @param ev - the checkbox change event.
   */
  onCustomCategoryToggle(key: string, categoryId: string, field: keyof RuleFlags, ev: Event): void {
    const on = eventChecked(ev);
    this.customPolicies.update((rows) =>
      rows.map((r) => {
        if (r.key !== key) return r;
        const current = r.categories[categoryId] ?? OFF_FLAGS;
        return {
          ...r,
          categories: { ...r.categories, [categoryId]: { ...current, [field]: on } },
        };
      })
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

  /**
   * Appends an empty keyword row to a policy.
   * @param rowKey - the owning policy row's local key.
   */
  addKeyword(rowKey: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              keywords: [...r.keywords, { match: '', alias: '', caseSensitive: true }],
            }
          : r
      )
    );
  }

  /**
   * Removes a keyword row from a policy.
   * @param rowKey - the owning policy row's local key.
   * @param i - the keyword row index.
   */
  removeKeyword(rowKey: string, i: number): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey ? { ...r, keywords: r.keywords.filter((_, idx) => idx !== i) } : r
      )
    );
  }

  /**
   * Updates a keyword row's match text.
   * @param rowKey - the owning policy row's local key.
   * @param i - the keyword row index.
   * @param value - the new match text.
   */
  onKeywordMatchInput(rowKey: string, i: number, value: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              keywords: r.keywords.map((k, idx) => (idx === i ? { ...k, match: value } : k)),
            }
          : r
      )
    );
  }

  /**
   * Updates a keyword row's alias text.
   * @param rowKey - the owning policy row's local key.
   * @param i - the keyword row index.
   * @param value - the new alias text.
   */
  onKeywordAliasInput(rowKey: string, i: number, value: string): void {
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              keywords: r.keywords.map((k, idx) => (idx === i ? { ...k, alias: value } : k)),
            }
          : r
      )
    );
  }

  /**
   * Toggles a keyword row's case-sensitivity flag.
   * @param rowKey - the owning policy row's local key.
   * @param i - the keyword row index.
   * @param ev - the checkbox change event.
   */
  onKeywordCaseSensitiveToggle(rowKey: string, i: number, ev: Event): void {
    const on = eventChecked(ev);
    this.customPolicies.update((rows) =>
      rows.map((r) =>
        r.key === rowKey
          ? {
              ...r,
              keywords: r.keywords.map((k, idx) => (idx === i ? { ...k, caseSensitive: on } : k)),
            }
          : r
      )
    );
  }

  /**
   * Client-side validation for a keyword row; the server is authoritative
   * and re-validates on save. Spec: match/alias 3–128 chars, alias matches
   * `^[A-Za-z][A-Za-z0-9]*$`, match ≠ alias (case-insensitive).
   * @param row - the keyword row to validate.
   */
  private keywordRowError(row: KeywordRow): string | null {
    const matchLen = row.match.length;
    if (matchLen < 3 || matchLen > 128) return 'Match: 3–128 characters';
    const aliasLen = row.alias.length;
    if (aliasLen < 3 || aliasLen > 128) return 'Alias: 3–128 characters';
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(row.alias)) return 'Alias: letter + alphanumeric only';
    if (row.match.toLowerCase() === row.alias.toLowerCase()) return 'Match and alias must differ';
    return null;
  }

  /**
   * Errors for all keyword rows in a policy; `null` entry = no error for that row.
   * @param rowKey - the owning policy row's local key.
   */
  readonly keywordErrorsFor = (rowKey: string): (string | null)[] => {
    const row = this.customPolicies().find((r) => r.key === rowKey);
    return row ? row.keywords.map((k) => this.keywordRowError(k)) : [];
  };

  private computeFormSnapshot(): string {
    return JSON.stringify({
      enabled: Array.from(this.enabledPolicies()).sort(),
      custom: this.customPolicies().map((r) => ({
        name: r.name,
        enabled: r.enabled,
        categories: r.categories,
        patterns: r.patterns,
        keywords: r.keywords,
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
      keywords: row.keywords.map(
        (k): KeywordV3 => ({
          match: k.match,
          alias: k.alias,
          caseSensitive: k.caseSensitive,
        })
      ),
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
