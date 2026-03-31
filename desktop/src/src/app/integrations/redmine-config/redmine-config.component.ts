import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IntegrationStatusEntry } from '../../models/integration';
import { SaveCredentialsEvent } from '../service-card/service-card.component';
import { TauriService } from '../../services/tauri.service';

/** A single Redmine enumeration entry (project, status, tracker, etc.). */
export interface RedmineEnumEntry {
  id: number;
  name: string;
}

/** Response from the `fetch_redmine_enumerations` Tauri command. */
export interface RedmineEnumerations {
  projects: RedmineEnumEntry[];
  statuses: RedmineEnumEntry[];
  trackers: RedmineEnumEntry[];
  priorities: RedmineEnumEntry[];
  activities: RedmineEnumEntry[];
}

/** Result from the `validate_redmine_credentials` Tauri command. */
export interface RedmineValidationResult {
  valid: boolean;
  user: { id: number; login: string } | null;
  error: string | null;
}

/** Predefined mapping keys grouped by category. */
export const MAPPING_CATEGORIES: Record<string, string[]> = {
  status: [
    'status_new',
    'status_in_progress',
    'status_resolved',
    'status_feedback',
    'status_closed',
    'status_rejected',
  ],
  tracker: ['tracker_bug', 'tracker_feature', 'tracker_task', 'tracker_support'],
  priority: [
    'priority_low',
    'priority_normal',
    'priority_high',
    'priority_urgent',
    'priority_immediate',
  ],
  activity: [
    'activity_design',
    'activity_development',
    'activity_testing',
    'activity_documentation',
    'activity_support',
    'activity_management',
    'activity_devops',
    'activity_review',
  ],
};

/**
 * Extracts the human-readable suffix from a mapping key by removing
 * the category prefix and normalizing underscores to spaces.
 * @param key - e.g. "status_in_progress"
 * @returns e.g. "in progress"
 */
function extractSuffix(key: string): string {
  const idx = key.indexOf('_');
  if (idx < 0) return key.toLowerCase();
  return key
    .substring(idx + 1)
    .toLowerCase()
    .replace(/_/g, ' ');
}

/**
 * Auto-matches predefined mapping keys against Redmine enum entries.
 *
 * Algorithm:
 * 1. Extract suffix after category prefix (e.g. `status_` -> `new`)
 * 2. Normalize: lowercase, replace underscores with spaces
 * 3. Case-insensitive comparison against Redmine enum entry names
 * 4. Exact match -> pre-select. Duplicate names -> first match wins
 * 5. No match -> null (= "Not mapped")
 * @param keys - predefined mapping keys for one category
 * @param entries - Redmine enum entries to match against
 * @returns mapping from key to matched entry id, or null if unmatched
 */
export function autoMatchMappings(
  keys: string[],
  entries: RedmineEnumEntry[]
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  const usedIds = new Set<number>();

  for (const key of keys) {
    const suffix = extractSuffix(key);
    let matched = false;
    for (const entry of entries) {
      if (usedIds.has(entry.id)) continue;
      if (entry.name.toLowerCase() === suffix) {
        result[key] = entry.id;
        usedIds.add(entry.id);
        matched = true;
        break;
      }
    }
    if (!matched) {
      result[key] = null;
    }
  }

  return result;
}

type WizardState = 'credentials' | 'mappings' | 'configured';

/** Wizard-based configuration component for the Redmine integration. */
@Component({
  selector: 'app-redmine-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="bg-sw-bg-dark border border-sw-border rounded-lg mb-3 overflow-hidden"
      [attr.data-testid]="'integrations-service-' + svc.service"
    >
      <!-- Card header -->
      <div class="flex justify-between items-center px-5 py-4">
        <button
          class="flex items-center gap-3 flex-1 cursor-pointer bg-transparent border-none text-inherit font-inherit text-left p-0"
          type="button"
          data-testid="card-header-btn"
          (click)="toggleExpand.emit(svc.service)"
        >
          <span class="font-semibold text-base" data-testid="service-name">{{
            svc.display_name
          }}</span>
          <span
            class="text-[11px] px-2 py-0.5 rounded font-medium"
            data-testid="badge"
            [attr.data-status]="svc.configured ? 'configured' : 'not-configured'"
            [ngClass]="
              svc.configured
                ? 'bg-sw-success-dark text-sw-success-text'
                : 'bg-sw-error-badge text-sw-error-text'
            "
          >
            {{ svc.configured ? 'Configured' : 'Not Configured' }}
          </span>
        </button>
        <div class="flex items-center gap-3">
          <label
            class="relative inline-block w-[44px] h-[24px]"
            data-testid="toggle"
            [attr.data-disabled]="!svc.configured"
            [ngClass]="!svc.configured ? 'opacity-40 cursor-not-allowed' : ''"
            [title]="svc.configured ? '' : 'Configure credentials to enable'"
          >
            <input
              type="checkbox"
              class="peer sr-only"
              [checked]="svc.enabled"
              [disabled]="!svc.configured"
              (change)="onToggle($event)"
              [attr.data-testid]="'integrations-toggle-' + svc.service"
              [ngClass]="!svc.configured ? 'cursor-not-allowed' : ''"
            />
            <span
              class="absolute inset-0 bg-sw-slider rounded-full cursor-pointer transition-all duration-300 peer-checked:bg-sw-accent before:absolute before:content-[''] before:h-[18px] before:w-[18px] before:left-[3px] before:bottom-[3px] before:bg-white before:rounded-full before:transition-all before:duration-300 peer-checked:before:translate-x-[20px]"
            ></span>
          </label>
        </div>
      </div>
      <p class="px-5 pb-3 text-sw-text-faint text-[13px] m-0" data-testid="card-description">
        {{ svc.description }}
      </p>

      @if (expanded) {
        <div class="px-5 pb-5 border-t border-sw-border" data-testid="card-body">
          <!-- State 1: Credentials entry -->
          @if (wizardState === 'credentials') {
            <div data-testid="redmine-state-credentials">
              <div class="my-4">
                <label
                  class="block mb-1.5 text-[13px] text-sw-text-dim"
                  for="redmine-host-url-input"
                  >Redmine URL</label
                >
                <input
                  id="redmine-host-url-input"
                  type="text"
                  data-testid="redmine-host-url"
                  class="w-full px-3 py-2.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-sm font-mono box-border focus:border-sw-accent focus:outline-none"
                  placeholder="https://redmine.company.com"
                  [value]="hostUrl"
                  (input)="hostUrl = asInputValue($event)"
                />
              </div>
              <div class="my-4">
                <label class="block mb-1.5 text-[13px] text-sw-text-dim" for="redmine-api-key-input"
                  >API Key</label
                >
                <input
                  id="redmine-api-key-input"
                  type="password"
                  data-testid="redmine-api-key"
                  class="w-full px-3 py-2.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-sm font-mono box-border focus:border-sw-accent focus:outline-none"
                  placeholder="abcdef1234567890..."
                  [value]="apiKey"
                  (input)="apiKey = asInputValue($event)"
                />
              </div>

              @if (validationError) {
                <div
                  class="mb-3 px-3 py-2 bg-sw-error-bg border border-sw-error-text rounded text-sw-error-text text-[13px]"
                  data-testid="redmine-validation-error"
                >
                  {{ validationError }}
                </div>
              }

              <button
                type="button"
                data-testid="redmine-validate-btn"
                class="px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-darkest disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                [disabled]="validating"
                (click)="onValidate()"
              >
                @if (validating) {
                  <span
                    class="inline-block w-3 h-3 border-2 border-sw-accent/30 border-t-sw-accent rounded-full animate-sw-spin"
                    data-testid="redmine-validate-spinner"
                  ></span>
                  Validating...
                } @else {
                  Validate
                }
              </button>
            </div>
          }

          <!-- State 2: Mapping configuration -->
          @if (wizardState === 'mappings') {
            <div data-testid="redmine-state-mappings">
              @if (loadingEnumerations) {
                <div class="flex items-center gap-2 my-4 text-sw-text-dim text-[13px]">
                  <span
                    class="inline-block w-4 h-4 border-2 border-sw-accent/30 border-t-sw-accent rounded-full animate-sw-spin"
                    data-testid="redmine-enum-spinner"
                  ></span>
                  Loading Redmine configuration...
                </div>
              } @else {
                <!-- Project dropdown -->
                <div class="my-4">
                  <label
                    class="block mb-1.5 text-[13px] text-sw-text-dim"
                    for="redmine-project-select"
                    >Project</label
                  >
                  <select
                    id="redmine-project-select"
                    data-testid="redmine-project-dropdown"
                    class="w-full px-3 py-2.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-sm font-mono box-border focus:border-sw-accent focus:outline-none"
                    [ngModel]="selectedProjectId"
                    (ngModelChange)="selectedProjectId = $event"
                  >
                    <option [ngValue]="null">All projects</option>
                    @for (proj of enumerations?.projects ?? []; track proj.id) {
                      <option [ngValue]="proj.id">{{ proj.name }}</option>
                    }
                  </select>
                  @if ((enumerations?.projects?.length ?? 0) >= 100) {
                    <p
                      class="text-sw-text-faint text-[11px] mt-1"
                      data-testid="redmine-projects-note"
                    >
                      Showing first {{ enumerations?.projects?.length }} projects. Use project
                      identifier for filtering if needed.
                    </p>
                  }
                </div>

                <!-- Mapping sections -->
                @for (category of mappingCategoryNames; track category) {
                  <div class="my-4" [attr.data-testid]="'redmine-mapping-category-' + category">
                    <h4 class="text-sw-text-dim text-[13px] mb-2 capitalize">
                      {{ category }} Mappings
                    </h4>
                    @for (key of getMappingKeys(category); track key) {
                      <div class="flex gap-2 mb-2 items-center">
                        <span
                          class="flex-[2] text-sw-text text-[13px] font-mono truncate"
                          [title]="key"
                          >{{ formatMappingLabel(key) }}</span
                        >
                        <select
                          class="flex-[2] px-2 py-1.5 bg-sw-bg-darkest border border-sw-border rounded text-sw-text text-[13px] font-mono"
                          [attr.data-testid]="'redmine-mapping-' + key"
                          [ngModel]="getMappingValue(key)"
                          (ngModelChange)="setMappingValue(key, $event)"
                        >
                          <option [ngValue]="null">Not mapped</option>
                          @for (entry of getEntriesForCategory(category); track entry.id) {
                            <option [ngValue]="entry.id">{{ entry.name }} (#{{ entry.id }})</option>
                          }
                        </select>
                      </div>
                    }
                  </div>
                }

                <div class="flex gap-3 mt-4">
                  <button
                    type="button"
                    data-testid="redmine-save-btn"
                    class="px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:enabled:bg-sw-accent hover:enabled:text-sw-bg-darkest"
                    (click)="onSaveMappings()"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    class="px-5 py-1.5 bg-transparent text-sw-text-dim border border-sw-border rounded text-[13px] font-mono cursor-pointer"
                    (click)="wizardState = 'credentials'"
                  >
                    Back
                  </button>
                </div>
              }
            </div>
          }

          <!-- State 3: Configured -->
          @if (wizardState === 'configured') {
            <div data-testid="redmine-state-configured">
              <div class="my-4 space-y-2 text-[13px]">
                <div class="flex gap-2">
                  <span class="text-sw-text-dim">Host:</span>
                  <span class="text-sw-text font-mono" data-testid="redmine-configured-host">{{
                    svc.current_values['host_url'] || hostUrl
                  }}</span>
                </div>
                @if (getConfiguredProjectName() || svc.current_values['project_id']) {
                  <div class="flex gap-2">
                    <span class="text-sw-text-dim">Project:</span>
                    <span class="text-sw-text font-mono" data-testid="redmine-configured-project">{{
                      getConfiguredProjectName() ?? svc.current_values['project_id']
                    }}</span>
                  </div>
                }
                <div class="flex gap-2">
                  <span class="text-sw-text-dim">Mappings:</span>
                  <span class="text-sw-text font-mono" data-testid="redmine-configured-mappings">{{
                    getConfiguredMappingCount()
                  }}</span>
                </div>
              </div>

              <div class="flex gap-3 mt-4">
                <button
                  type="button"
                  data-testid="redmine-edit-btn"
                  class="px-5 py-1.5 bg-transparent text-sw-accent border border-sw-accent rounded text-[13px] font-mono cursor-pointer transition-all duration-200 hover:bg-sw-accent hover:text-sw-bg-darkest"
                  (click)="onEdit()"
                >
                  Edit
                </button>
                <button
                  type="button"
                  [attr.data-testid]="'integrations-remove-' + svc.service"
                  class="px-5 py-1.5 bg-transparent text-sw-error-text border border-sw-error-text rounded text-[13px] font-mono cursor-pointer"
                  (click)="deleteCredentials.emit(svc)"
                >
                  Remove Credentials
                </button>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class RedmineConfigComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) svc!: IntegrationStatusEntry;
  @Input() expanded = false;

  @Output() saveCredentials = new EventEmitter<SaveCredentialsEvent>();
  @Output() deleteCredentials = new EventEmitter<IntegrationStatusEntry>();
  @Output() toggleExpand = new EventEmitter<string>();
  @Output() toggleService = new EventEmitter<{ svc: IntegrationStatusEntry; event: Event }>();

  wizardState: WizardState = 'credentials';
  hostUrl = '';
  apiKey = '';
  validating = false;
  validationError = '';
  loadingEnumerations = false;
  enumerations: RedmineEnumerations | null = null;
  selectedProjectId: number | null = null;
  editedMappings: Record<string, number | null> = {};

  readonly mappingCategoryNames = Object.keys(MAPPING_CATEGORIES);

  private destroyed = false;
  private enumerationNonce = 0;
  private tauri = inject(TauriService);
  private cdr = inject(ChangeDetectorRef);

  /** Pre-populates fields and determines initial wizard state from inputs. */
  ngOnChanges(): void {
    if (this.svc) {
      if (!this.hostUrl && this.svc.current_values['host_url']) {
        this.hostUrl = this.svc.current_values['host_url'];
      }
      if (!this.apiKey && this.svc.current_values['api_key']) {
        this.apiKey = this.svc.current_values['api_key'];
      }
      if (this.svc.configured && this.wizardState === 'credentials') {
        this.wizardState = 'configured';
      }
      if (this.svc.mappings) {
        this.restoreMappingsFromService();
      }
      if (this.svc.current_values['project_id']) {
        const parsed = parseInt(this.svc.current_values['project_id'], 10);
        if (!isNaN(parsed) && this.selectedProjectId === null) {
          this.selectedProjectId = parsed;
        }
      }
    }
  }

  /** Cleans up component state to guard async callbacks. */
  ngOnDestroy(): void {
    this.destroyed = true;
  }

  /**
   * Extracts the input value from a DOM event.
   * @param event - the DOM input event
   * @returns the current input element value
   */
  asInputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  /**
   * Emits the toggleService event.
   * @param event - the checkbox change event
   */
  onToggle(event: Event): void {
    this.toggleService.emit({ svc: this.svc, event });
  }

  /** Validates credentials against the Redmine API. */
  async onValidate(): Promise<void> {
    if (this.validating) return;

    this.validating = true;
    this.validationError = '';
    this.cdr.markForCheck();

    try {
      const result = await this.tauri.invoke<RedmineValidationResult>(
        'validate_redmine_credentials',
        { hostUrl: this.hostUrl, apiKey: this.apiKey }
      );
      if (this.destroyed) return;

      if (result.valid) {
        this.wizardState = 'mappings';
        this.loadEnumerations();
      } else {
        this.validationError = result.error ?? 'Validation failed';
      }
    } catch (e: unknown) {
      if (this.destroyed) return;
      this.validationError = e instanceof Error ? e.message : String(e);
    }

    this.validating = false;
    this.cdr.markForCheck();
  }

  /**
   * Returns mapping keys for a category.
   * @param category - the mapping category name
   */
  getMappingKeys(category: string): string[] {
    return MAPPING_CATEGORIES[category] ?? [];
  }

  /**
   * Returns the current mapping value for a key.
   * @param key - the mapping key to look up
   */
  getMappingValue(key: string): number | null {
    return this.editedMappings[key] ?? null;
  }

  /**
   * Updates a mapping value.
   * @param key - the mapping key to update
   * @param value - the new value, or null for "Not mapped"
   */
  setMappingValue(key: string, value: number | null): void {
    this.editedMappings[key] = value;
  }

  /**
   * Returns the enum entries for a given category.
   * @param category - the mapping category name
   */
  getEntriesForCategory(category: string): RedmineEnumEntry[] {
    if (!this.enumerations) return [];
    switch (category) {
      case 'status':
        return this.enumerations.statuses;
      case 'tracker':
        return this.enumerations.trackers;
      case 'priority':
        return this.enumerations.priorities;
      case 'activity':
        return this.enumerations.activities;
      default:
        return [];
    }
  }

  /**
   * Formats a mapping key into a human-readable label.
   * @param key - the mapping key to format
   */
  formatMappingLabel(key: string): string {
    const idx = key.indexOf('_');
    if (idx < 0) return key;
    return key
      .substring(idx + 1)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Saves credentials and mappings, transitions to configured state. */
  onSaveMappings(): void {
    const credentials: Record<string, string> = {};
    if (this.hostUrl) credentials['host_url'] = this.hostUrl;
    if (this.apiKey) credentials['api_key'] = this.apiKey;

    if (this.selectedProjectId !== null) {
      credentials['project_id'] = String(this.selectedProjectId);
    }

    const mappings: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.editedMappings)) {
      if (value !== null) {
        mappings[key] = value;
      }
    }

    this.saveCredentials.emit({
      svc: this.svc,
      credentials,
      mappings: Object.keys(mappings).length > 0 ? mappings : null,
    });

    this.wizardState = 'configured';
    this.cdr.markForCheck();
  }

  /** Transitions back to credentials entry for editing. */
  onEdit(): void {
    this.wizardState = 'credentials';
    this.validationError = '';
    this.cdr.markForCheck();
  }

  /** Returns the configured project name or null. */
  getConfiguredProjectName(): string | null {
    if (this.selectedProjectId !== null && this.enumerations) {
      const proj = this.enumerations.projects.find((p) => p.id === this.selectedProjectId);
      if (proj) return proj.name;
    }
    return null;
  }

  /** Returns the count of configured (non-null) mappings. */
  getConfiguredMappingCount(): number {
    let count = 0;
    for (const value of Object.values(this.editedMappings)) {
      if (value !== null) count++;
    }
    if (count === 0 && this.svc.mappings) {
      return Object.keys(this.svc.mappings).length;
    }
    return count;
  }

  /** Fetches Redmine enumerations from the API. */
  private async loadEnumerations(): Promise<void> {
    const myNonce = ++this.enumerationNonce;
    this.loadingEnumerations = true;
    this.cdr.markForCheck();

    try {
      const result = await this.tauri.invoke<RedmineEnumerations>('fetch_redmine_enumerations', {
        hostUrl: this.hostUrl,
        apiKey: this.apiKey,
      });
      if (this.destroyed || myNonce !== this.enumerationNonce) return;

      this.enumerations = result;
      this.applyAutoMatching();
    } catch (e: unknown) {
      if (this.destroyed || myNonce !== this.enumerationNonce) return;
      this.validationError = e instanceof Error ? e.message : String(e);
      this.wizardState = 'credentials';
    }

    this.loadingEnumerations = false;
    this.cdr.markForCheck();
  }

  /** Applies auto-matching for all mapping categories. */
  private applyAutoMatching(): void {
    if (!this.enumerations) return;

    const existingMappings = (this.svc.mappings as Record<string, number>) ?? {};
    const hasExisting = Object.keys(existingMappings).length > 0;

    for (const category of this.mappingCategoryNames) {
      const keys = MAPPING_CATEGORIES[category];
      const entries = this.getEntriesForCategory(category);
      const autoMatched = autoMatchMappings(keys, entries);

      for (const key of keys) {
        if (hasExisting && key in existingMappings) {
          this.editedMappings[key] = existingMappings[key];
        } else if (!(key in this.editedMappings) || this.editedMappings[key] === null) {
          this.editedMappings[key] = autoMatched[key];
        }
      }
    }
  }

  /** Restores mapping values from service data. */
  private restoreMappingsFromService(): void {
    const mappings = this.svc.mappings as Record<string, number> | undefined;
    if (!mappings) return;
    for (const [key, value] of Object.entries(mappings)) {
      if (!(key in this.editedMappings)) {
        this.editedMappings[key] = value;
      }
    }
  }
}
