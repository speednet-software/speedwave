import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  RedmineConfigComponent,
  RedmineEnumerations,
  MAPPING_CATEGORIES,
  autoMatchMappings,
  RedmineEnumEntry,
} from './redmine-config.component';
import { IntegrationStatusEntry } from '../../models/integration';
import { TauriService } from '../../services/tauri.service';

function makeRedmineSvc(overrides?: Partial<IntegrationStatusEntry>): IntegrationStatusEntry {
  return {
    service: 'redmine',
    enabled: false,
    configured: false,
    display_name: 'Redmine',
    description: 'Project management',
    auth_fields: [
      {
        key: 'api_key',
        label: 'API Key',
        field_type: 'password',
        placeholder: 'abcdef1234567890...',
        oauth_flow: false,
        optional: false,
      },
      {
        key: 'host_url',
        label: 'Redmine URL',
        field_type: 'url',
        placeholder: 'https://redmine.company.com',
        oauth_flow: false,
        optional: false,
      },
      {
        key: 'project_id',
        label: 'Project ID',
        field_type: 'text',
        placeholder: 'my-project',
        oauth_flow: false,
        optional: true,
      },
    ],
    current_values: {},
    mappings: undefined,
    ...overrides,
  };
}

function makeEnumerations(overrides?: Partial<RedmineEnumerations>): RedmineEnumerations {
  return {
    projects: [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ],
    statuses: [
      { id: 1, name: 'New' },
      { id: 2, name: 'In Progress' },
      { id: 3, name: 'Resolved' },
      { id: 4, name: 'Feedback' },
      { id: 5, name: 'Closed' },
      { id: 6, name: 'Rejected' },
    ],
    trackers: [
      { id: 1, name: 'Bug' },
      { id: 2, name: 'Feature' },
      { id: 3, name: 'Task' },
      { id: 4, name: 'Support' },
    ],
    priorities: [
      { id: 1, name: 'Low' },
      { id: 2, name: 'Normal' },
      { id: 3, name: 'High' },
      { id: 4, name: 'Urgent' },
      { id: 5, name: 'Immediate' },
    ],
    activities: [
      { id: 9, name: 'Design' },
      { id: 10, name: 'Development' },
    ],
    ...overrides,
  };
}

describe('RedmineConfigComponent', () => {
  let component: RedmineConfigComponent;
  let fixture: ComponentFixture<RedmineConfigComponent>;
  let tauriSpy: { invoke: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    tauriSpy = {
      invoke: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [RedmineConfigComponent],
      providers: [{ provide: TauriService, useValue: tauriSpy }],
    }).compileComponents();

    fixture = TestBed.createComponent(RedmineConfigComponent);
    component = fixture.componentInstance;
    component.svc = makeRedmineSvc();
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should render service name and description', () => {
    fixture.detectChanges();
    const el = fixture.nativeElement;
    expect(el.querySelector('[data-testid="service-name"]').textContent).toContain('Redmine');
    expect(el.querySelector('[data-testid="card-description"]').textContent).toContain(
      'Project management'
    );
  });

  it('should show not-configured badge when not configured', () => {
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('[data-testid="badge"]');
    expect(badge.textContent.trim()).toBe('Not Configured');
    expect(badge.getAttribute('data-status')).toBe('not-configured');
  });

  it('should show configured badge when configured', () => {
    component.svc = makeRedmineSvc({ configured: true });
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('[data-testid="badge"]');
    expect(badge.textContent.trim()).toBe('Configured');
    expect(badge.getAttribute('data-status')).toBe('configured');
  });

  it('should emit toggleExpand when header button is clicked', () => {
    fixture.detectChanges();
    const spy = vi.spyOn(component.toggleExpand, 'emit');
    fixture.nativeElement.querySelector('[data-testid="card-header-btn"]').click();
    expect(spy).toHaveBeenCalledWith('redmine');
  });

  it('should not show card-body when not expanded', () => {
    component.expanded = false;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="card-body"]')).toBeNull();
  });

  it('should show card-body when expanded', () => {
    component.expanded = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="card-body"]')).not.toBeNull();
  });

  describe('State transitions', () => {
    it('starts in credentials state', () => {
      component.expanded = true;
      fixture.detectChanges();
      expect(component.wizardState).toBe('credentials');
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-state-credentials"]')
      ).not.toBeNull();
    });

    it('transitions to configured state on init when svc is configured', () => {
      component.svc = makeRedmineSvc({
        configured: true,
        current_values: { host_url: 'https://redmine.test', api_key: 'key123' },
      });
      component.ngOnChanges();
      fixture.detectChanges();
      expect(component.wizardState).toBe('configured');
    });

    it('transitions from credentials to mappings on successful validation', async () => {
      component.expanded = true;
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'valid-key';
      fixture.detectChanges();

      tauriSpy.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'validate_redmine_credentials') {
          return Promise.resolve({ valid: true, user: { id: 1, login: 'admin' }, error: null });
        }
        if (cmd === 'fetch_redmine_enumerations') {
          return Promise.resolve(makeEnumerations());
        }
        return Promise.resolve();
      });

      await component.onValidate();
      fixture.detectChanges();

      expect(component.wizardState).toBe('mappings');
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-state-mappings"]')
      ).not.toBeNull();
    });

    it('transitions from mappings to configured on save', async () => {
      component.expanded = true;
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'valid-key';
      component.wizardState = 'mappings';
      component.enumerations = makeEnumerations();
      fixture.detectChanges();

      const spy = vi.spyOn(component.saveCredentials, 'emit');
      component.onSaveMappings();
      fixture.detectChanges();

      expect(component.wizardState).toBe('configured');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('transitions from configured to credentials on edit', () => {
      component.expanded = true;
      component.wizardState = 'configured';
      fixture.detectChanges();

      component.onEdit();
      fixture.detectChanges();

      expect(component.wizardState).toBe('credentials');
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-state-credentials"]')
      ).not.toBeNull();
    });

    it('transitions from edit back to mappings on re-validate', async () => {
      component.expanded = true;
      component.wizardState = 'configured';
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'valid-key';

      tauriSpy.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'validate_redmine_credentials') {
          return Promise.resolve({ valid: true, user: { id: 1, login: 'admin' }, error: null });
        }
        if (cmd === 'fetch_redmine_enumerations') {
          return Promise.resolve(makeEnumerations());
        }
        return Promise.resolve();
      });

      component.onEdit();
      await component.onValidate();
      fixture.detectChanges();

      expect(component.wizardState).toBe('mappings');
    });
  });

  describe('Validation errors', () => {
    beforeEach(() => {
      component.expanded = true;
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'bad-key';
      fixture.detectChanges();
    });

    it('shows error for invalid credentials (401)', async () => {
      tauriSpy.invoke.mockResolvedValue({
        valid: false,
        user: null,
        error: 'HTTP 401: Unauthorized',
      });

      await component.onValidate();
      fixture.detectChanges();

      expect(component.wizardState).toBe('credentials');
      expect(component.validationError).toBe('HTTP 401: Unauthorized');
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-validation-error"]')
      ).not.toBeNull();
    });

    it('shows error for bad URL', async () => {
      component.hostUrl = 'not-a-url';
      tauriSpy.invoke.mockRejectedValue(new Error('Invalid URL'));

      await component.onValidate();
      fixture.detectChanges();

      expect(component.wizardState).toBe('credentials');
      expect(component.validationError).toBe('Invalid URL');
    });

    it('shows error for network failure', async () => {
      tauriSpy.invoke.mockRejectedValue(new Error('Network error: connection refused'));

      await component.onValidate();
      fixture.detectChanges();

      expect(component.wizardState).toBe('credentials');
      expect(component.validationError).toContain('Network error');
    });

    it('handles string error from Tauri', async () => {
      tauriSpy.invoke.mockRejectedValue('Something went wrong');

      await component.onValidate();
      fixture.detectChanges();

      expect(component.validationError).toBe('Something went wrong');
    });
  });

  describe('Concurrency', () => {
    it('double-click validate is no-op while validating', async () => {
      component.expanded = true;
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'key';
      fixture.detectChanges();

      let resolveFirst!: (value: unknown) => void;
      tauriSpy.invoke.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
      );

      const firstCall = component.onValidate();
      expect(component.validating).toBe(true);

      // Second call should be a no-op
      await component.onValidate();
      expect(tauriSpy.invoke).toHaveBeenCalledTimes(1);

      resolveFirst({ valid: true, user: { id: 1, login: 'admin' }, error: null });
      tauriSpy.invoke.mockResolvedValue(makeEnumerations());
      await firstCall;
    });

    it('component destroyed during validation produces no errors', async () => {
      component.expanded = true;
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'key';
      fixture.detectChanges();

      let resolveValidation!: (value: unknown) => void;
      tauriSpy.invoke.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveValidation = resolve;
        })
      );

      const validatePromise = component.onValidate();
      component.ngOnDestroy();

      resolveValidation({ valid: true, user: { id: 1, login: 'admin' }, error: null });
      await validatePromise;

      // Should not transition state after destroy
      expect(component.wizardState).toBe('credentials');
    });

    it('component destroyed during enumeration fetch produces no errors', async () => {
      component.expanded = true;
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'key';
      fixture.detectChanges();

      let resolveEnumerations!: (value: unknown) => void;
      const enumPromise = new Promise((resolve) => {
        resolveEnumerations = resolve;
      });

      tauriSpy.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'validate_redmine_credentials') {
          return Promise.resolve({ valid: true, user: { id: 1, login: 'admin' }, error: null });
        }
        if (cmd === 'fetch_redmine_enumerations') {
          return enumPromise;
        }
        return Promise.resolve();
      });

      // Validate succeeds, triggers loadEnumerations (fire-and-forget)
      await component.onValidate();

      expect(component.wizardState).toBe('mappings');
      expect(component.loadingEnumerations).toBe(true);

      // Destroy while enumeration fetch is pending
      component.ngOnDestroy();

      // Resolve the pending enumeration fetch
      resolveEnumerations(makeEnumerations());
      await enumPromise;

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 0));

      // Should remain in loading state — destroyed guard prevents state update
      expect(component.loadingEnumerations).toBe(true);
      expect(component.enumerations).toBeNull();
    });

    it('rapid transitions: stale enumeration fetch does not overwrite newer result', async () => {
      component.expanded = true;
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'key';
      fixture.detectChanges();

      const staleEnumerations = makeEnumerations({
        projects: [{ id: 99, name: 'Stale' }],
      });
      const freshEnumerations = makeEnumerations({
        projects: [{ id: 42, name: 'Fresh' }],
      });

      let resolveFirstEnum!: (value: unknown) => void;
      const firstEnumPromise = new Promise((resolve) => {
        resolveFirstEnum = resolve;
      });
      let resolveSecondEnum!: (value: unknown) => void;
      const secondEnumPromise = new Promise((resolve) => {
        resolveSecondEnum = resolve;
      });

      let enumCallCount = 0;
      tauriSpy.invoke.mockImplementation((cmd: string) => {
        if (cmd === 'validate_redmine_credentials') {
          return Promise.resolve({ valid: true, user: { id: 1, login: 'admin' }, error: null });
        }
        if (cmd === 'fetch_redmine_enumerations') {
          enumCallCount++;
          return enumCallCount === 1 ? firstEnumPromise : secondEnumPromise;
        }
        return Promise.resolve();
      });

      // First validate -> succeeds -> loadEnumerations #1 starts (deferred)
      await component.onValidate();
      expect(component.wizardState).toBe('mappings');
      expect(component.loadingEnumerations).toBe(true);

      // User clicks Edit (back to credentials), then re-validates
      component.onEdit();
      expect(component.wizardState).toBe('credentials');
      expect(component.validating).toBe(false);

      // Second validate -> succeeds -> loadEnumerations #2 starts (deferred)
      await component.onValidate();
      expect(component.wizardState).toBe('mappings');

      // Now resolve the FIRST (stale) enum fetch
      resolveFirstEnum(staleEnumerations);
      await firstEnumPromise;
      await new Promise((r) => setTimeout(r, 0));

      // Stale result must be ignored — enumerations should still be null
      expect(component.enumerations).toBeNull();
      expect(component.loadingEnumerations).toBe(true);

      // Resolve the SECOND (fresh) enum fetch
      resolveSecondEnum(freshEnumerations);
      await secondEnumPromise;
      await new Promise((r) => setTimeout(r, 0));

      // Fresh result is applied
      expect(component.enumerations).not.toBeNull();
      expect(component.enumerations!.projects[0].name).toBe('Fresh');
      expect(component.loadingEnumerations).toBe(false);
    });
  });

  describe('Dropdowns', () => {
    beforeEach(() => {
      component.expanded = true;
      component.wizardState = 'mappings';
      component.enumerations = makeEnumerations();
      component.loadingEnumerations = false;
      fixture.detectChanges();
    });

    it('renders project dropdown with All projects first', () => {
      const select = fixture.nativeElement.querySelector(
        '[data-testid="redmine-project-dropdown"]'
      );
      expect(select).not.toBeNull();
      const options = select.querySelectorAll('option');
      expect(options[0].textContent.trim()).toBe('All projects');
      expect(options.length).toBe(3); // All projects + 2 projects
    });

    it('renders 0 projects as only All projects option', () => {
      component.enumerations = makeEnumerations({ projects: [] });
      fixture.detectChanges();
      const select = fixture.nativeElement.querySelector(
        '[data-testid="redmine-project-dropdown"]'
      );
      const options = select.querySelectorAll('option');
      expect(options.length).toBe(1);
      expect(options[0].textContent.trim()).toBe('All projects');
    });

    it('renders all 4 mapping categories', () => {
      for (const category of Object.keys(MAPPING_CATEGORIES)) {
        const section = fixture.nativeElement.querySelector(
          `[data-testid="redmine-mapping-category-${category}"]`
        );
        expect(section).not.toBeNull();
      }
    });

    it('renders Not mapped option on each mapping dropdown', () => {
      const firstKey = MAPPING_CATEGORIES['status'][0];
      const select = fixture.nativeElement.querySelector(
        `[data-testid="redmine-mapping-${firstKey}"]`
      );
      expect(select).not.toBeNull();
      const options = select.querySelectorAll('option');
      expect(options[0].textContent.trim()).toBe('Not mapped');
    });

    it('has correct data-testid attributes for mapping dropdowns', () => {
      for (const keys of Object.values(MAPPING_CATEGORIES)) {
        for (const key of keys) {
          expect(
            fixture.nativeElement.querySelector(`[data-testid="redmine-mapping-${key}"]`)
          ).not.toBeNull();
        }
      }
    });

    it('shows note when 100 or more projects (API limit reached)', () => {
      const limitProjects = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        name: `Project ${i + 1}`,
      }));
      component.enumerations = makeEnumerations({ projects: limitProjects });
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-projects-note"]')
      ).not.toBeNull();
    });

    it('does not show note when fewer than 100 projects', () => {
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-projects-note"]')
      ).toBeNull();
    });
  });

  describe('Save', () => {
    it('emits correct payload with all mapped values', () => {
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'key123';
      component.selectedProjectId = 1;
      component.enumerations = makeEnumerations();
      component.editedMappings = { status_new: 1, tracker_bug: 1 };

      const spy = vi.spyOn(component.saveCredentials, 'emit');
      component.onSaveMappings();

      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0];
      expect(payload.credentials['host_url']).toBe('https://redmine.test');
      expect(payload.credentials['api_key']).toBe('key123');
      expect(payload.credentials['project_id']).toBe('1');
      expect(payload.credentials['project_name']).toBeUndefined();
      expect(payload.mappings).toEqual({ status_new: 1, tracker_bug: 1 });
    });

    it('emits only mapped keys, skipping Not mapped', () => {
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'key123';
      component.editedMappings = { status_new: 1, status_in_progress: null, tracker_bug: null };

      const spy = vi.spyOn(component.saveCredentials, 'emit');
      component.onSaveMappings();

      const payload = spy.mock.calls[0][0];
      expect(payload.mappings).toEqual({ status_new: 1 });
    });

    it('emits null mappings when all are Not mapped', () => {
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'key123';
      component.editedMappings = { status_new: null, tracker_bug: null };

      const spy = vi.spyOn(component.saveCredentials, 'emit');
      component.onSaveMappings();

      expect(spy.mock.calls[0][0].mappings).toBeNull();
    });

    it('does not include project_id when All projects selected', () => {
      component.hostUrl = 'https://redmine.test';
      component.apiKey = 'key123';
      component.selectedProjectId = null;

      const spy = vi.spyOn(component.saveCredentials, 'emit');
      component.onSaveMappings();

      expect(spy.mock.calls[0][0].credentials['project_id']).toBeUndefined();
    });
  });

  describe('Configured state', () => {
    beforeEach(() => {
      component.expanded = true;
      component.wizardState = 'configured';
      component.svc = makeRedmineSvc({
        configured: true,
        current_values: { host_url: 'https://redmine.test', api_key: 'key' },
      });
    });

    it('shows configured state elements', () => {
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-state-configured"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-edit-btn"]')
      ).not.toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="integrations-remove-redmine"]')
      ).not.toBeNull();
    });

    it('shows host URL', () => {
      fixture.detectChanges();
      const host = fixture.nativeElement.querySelector('[data-testid="redmine-configured-host"]');
      expect(host.textContent.trim()).toBe('https://redmine.test');
    });

    it('shows mapping count', () => {
      component.editedMappings = { status_new: 1, tracker_bug: 2 };
      fixture.detectChanges();
      const count = fixture.nativeElement.querySelector(
        '[data-testid="redmine-configured-mappings"]'
      );
      expect(count.textContent.trim()).toBe('2');
    });

    it('emits deleteCredentials on remove click', () => {
      fixture.detectChanges();
      const spy = vi.spyOn(component.deleteCredentials, 'emit');
      fixture.nativeElement.querySelector('[data-testid="integrations-remove-redmine"]').click();
      expect(spy).toHaveBeenCalledWith(component.svc);
    });

    it('edit button transitions to credentials state', () => {
      fixture.detectChanges();
      fixture.nativeElement.querySelector('[data-testid="redmine-edit-btn"]').click();
      fixture.detectChanges();
      expect(component.wizardState).toBe('credentials');
    });
  });

  describe('Pre-population', () => {
    it('pre-populates host_url and api_key from current_values', () => {
      component.svc = makeRedmineSvc({
        current_values: { host_url: 'https://existing.test', api_key: 'existing-key' },
      });
      component.ngOnChanges();
      expect(component.hostUrl).toBe('https://existing.test');
      expect(component.apiKey).toBe('existing-key');
    });

    it('pre-populates project_id from current_values', () => {
      component.svc = makeRedmineSvc({
        current_values: { host_url: 'h', api_key: 'k', project_id: '42' },
      });
      component.ngOnChanges();
      expect(component.selectedProjectId).toBe(42);
    });

    it('restores mappings from svc.mappings', () => {
      component.svc = makeRedmineSvc({
        mappings: { status_new: 1, tracker_bug: 3 },
      });
      component.ngOnChanges();
      expect(component.editedMappings['status_new']).toBe(1);
      expect(component.editedMappings['tracker_bug']).toBe(3);
    });
  });

  describe('Toggle', () => {
    it('emits toggleService on checkbox change', () => {
      component.svc = makeRedmineSvc({ configured: true, enabled: true });
      fixture.detectChanges();
      const spy = vi.spyOn(component.toggleService, 'emit');
      const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
      checkbox.dispatchEvent(new Event('change'));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].svc).toBe(component.svc);
    });

    it('disables toggle when not configured', () => {
      fixture.detectChanges();
      const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]');
      expect(checkbox.disabled).toBe(true);
    });
  });

  describe('Enumeration loading spinner', () => {
    it('shows spinner while loading enumerations', () => {
      component.expanded = true;
      component.wizardState = 'mappings';
      component.loadingEnumerations = true;
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-enum-spinner"]')
      ).not.toBeNull();
    });

    it('hides spinner when enumerations loaded', () => {
      component.expanded = true;
      component.wizardState = 'mappings';
      component.loadingEnumerations = false;
      component.enumerations = makeEnumerations();
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-enum-spinner"]')
      ).toBeNull();
    });
  });

  describe('Validation button', () => {
    it('shows spinner during validation', () => {
      component.expanded = true;
      component.validating = true;
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="redmine-validate-spinner"]')
      ).not.toBeNull();
      const btn = fixture.nativeElement.querySelector('[data-testid="redmine-validate-btn"]');
      expect(btn.disabled).toBe(true);
    });

    it('is enabled when not validating', () => {
      component.expanded = true;
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="redmine-validate-btn"]');
      expect(btn.disabled).toBe(false);
    });
  });

  describe('formatMappingLabel()', () => {
    it('formats status_in_progress to In Progress', () => {
      expect(component.formatMappingLabel('status_in_progress')).toBe('In Progress');
    });

    it('formats tracker_bug to Bug', () => {
      expect(component.formatMappingLabel('tracker_bug')).toBe('Bug');
    });

    it('handles key without underscore', () => {
      expect(component.formatMappingLabel('standalone')).toBe('standalone');
    });
  });

  describe('getConfiguredMappingCount()', () => {
    it('returns count of non-null editedMappings', () => {
      component.editedMappings = { a: 1, b: null, c: 3 };
      expect(component.getConfiguredMappingCount()).toBe(2);
    });

    it('falls back to svc.mappings count when editedMappings are all null', () => {
      component.editedMappings = {};
      component.svc = makeRedmineSvc({ mappings: { x: 1, y: 2, z: 3 } });
      expect(component.getConfiguredMappingCount()).toBe(3);
    });

    it('returns 0 when no mappings anywhere', () => {
      component.editedMappings = {};
      expect(component.getConfiguredMappingCount()).toBe(0);
    });
  });
});

describe('autoMatchMappings()', () => {
  it('exact match: "New" auto-selects', () => {
    const entries: RedmineEnumEntry[] = [{ id: 1, name: 'New' }];
    const result = autoMatchMappings(['status_new'], entries);
    expect(result['status_new']).toBe(1);
  });

  it('case-insensitive: "IN PROGRESS" matches', () => {
    const entries: RedmineEnumEntry[] = [{ id: 2, name: 'IN PROGRESS' }];
    const result = autoMatchMappings(['status_in_progress'], entries);
    expect(result['status_in_progress']).toBe(2);
  });

  it('underscore normalization: in_progress matches "In Progress"', () => {
    const entries: RedmineEnumEntry[] = [{ id: 3, name: 'In Progress' }];
    const result = autoMatchMappings(['status_in_progress'], entries);
    expect(result['status_in_progress']).toBe(3);
  });

  it('no match: "Otwarte" results in Not mapped', () => {
    const entries: RedmineEnumEntry[] = [{ id: 1, name: 'Otwarte' }];
    const result = autoMatchMappings(['status_new'], entries);
    expect(result['status_new']).toBeNull();
  });

  it('duplicate names: two "New" entries, first wins (id=1)', () => {
    const entries: RedmineEnumEntry[] = [
      { id: 1, name: 'New' },
      { id: 5, name: 'New' },
    ];
    const result = autoMatchMappings(['status_new'], entries);
    expect(result['status_new']).toBe(1);
  });

  it('empty enum list results in all Not mapped', () => {
    const keys = ['status_new', 'status_in_progress', 'status_resolved'];
    const result = autoMatchMappings(keys, []);
    for (const key of keys) {
      expect(result[key]).toBeNull();
    }
  });

  it('matches multiple keys correctly', () => {
    const entries: RedmineEnumEntry[] = [
      { id: 1, name: 'Low' },
      { id: 2, name: 'Normal' },
      { id: 3, name: 'High' },
    ];
    const keys = ['priority_low', 'priority_normal', 'priority_high', 'priority_urgent'];
    const result = autoMatchMappings(keys, entries);
    expect(result['priority_low']).toBe(1);
    expect(result['priority_normal']).toBe(2);
    expect(result['priority_high']).toBe(3);
    expect(result['priority_urgent']).toBeNull();
  });

  it('handles mixed case entries', () => {
    const entries: RedmineEnumEntry[] = [
      { id: 1, name: 'bug' },
      { id: 2, name: 'FEATURE' },
      { id: 3, name: 'Task' },
    ];
    const result = autoMatchMappings(['tracker_bug', 'tracker_feature', 'tracker_task'], entries);
    expect(result['tracker_bug']).toBe(1);
    expect(result['tracker_feature']).toBe(2);
    expect(result['tracker_task']).toBe(3);
  });

  it('empty keys array returns empty object', () => {
    const result = autoMatchMappings([], [{ id: 1, name: 'New' }]);
    expect(result).toEqual({});
  });
});
