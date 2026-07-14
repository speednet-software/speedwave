import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SecuritySectionComponent } from './security-section.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import type {
  CategoryFlagPair,
  PiiCategoryPolicies,
  SecurityPolicyResponse,
  SecurityPolicyTemplateInfo,
  SecurityPolicyUpdate,
} from '../../models/security-policy';

function pair(tokenize: boolean, log = false): CategoryFlagPair {
  return { tokenize, log };
}

function allCategories(overrides: Partial<PiiCategoryPolicies> = {}): PiiCategoryPolicies {
  return {
    EMAIL: pair(true),
    PHONE_PL: pair(true),
    PESEL: pair(true),
    NIP: pair(true),
    IBAN: pair(true),
    CARD: pair(true),
    API_KEY: pair(true),
    SENSITIVE_FIELD: pair(true),
    ...overrides,
  };
}

function baseTemplates(): SecurityPolicyTemplateInfo[] {
  return [
    {
      id: 'strict',
      name: 'Strict',
      description: 'All categories on.',
      categories: allCategories(),
    },
    {
      id: 'gdpr-art32',
      name: 'GDPR Art. 32',
      description: 'EU PII protection.',
      categories: allCategories({ API_KEY: pair(false) }),
    },
  ];
}

function baseResponse(overrides: Partial<SecurityPolicyResponse> = {}): SecurityPolicyResponse {
  return {
    enabled_policies: ['strict'],
    forced_policies: [],
    effective_categories: allCategories(),
    custom_policies: [],
    ...overrides,
  };
}

describe('SecuritySectionComponent', () => {
  let component: SecuritySectionComponent;
  let fixture: ComponentFixture<SecuritySectionComponent>;
  let mockTauri: MockTauriService;

  function setup(resp: SecurityPolicyResponse, templates = baseTemplates()): void {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_security_policy_templates') return templates;
      if (cmd === 'get_security_policy') return resp;
      return undefined;
    };
  }

  async function create(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [SecuritySectionComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();
    fixture = TestBed.createComponent(SecuritySectionComponent);
    component = fixture.componentInstance;
  }

  function checkboxEvent(checked: boolean): Event {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    return { target: input } as unknown as Event;
  }

  beforeEach(() => {
    setup(baseResponse());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create', async () => {
    await create();
    expect(component).toBeTruthy();
  });

  it('loads templates and the current policy on init', async () => {
    await create();
    component.ngOnInit();
    await fixture.whenStable();
    expect(component.templates()).toHaveLength(2);
    expect(component.isBuiltinEnabled('strict')).toBe(true);
    expect(component.isBuiltinEnabled('gdpr-art32')).toBe(false);
    expect(component.effectiveCategories()).toEqual(allCategories());
  });

  it('renders one checklist row per built-in template plus each custom policy', async () => {
    setup(
      baseResponse({
        custom_policies: [
          {
            id: 'my-custom',
            name: 'My Custom',
            categories: allCategories(),
            custom_patterns: [],
            sensitive_keys_add: [],
          },
        ],
      })
    );
    await create();
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="security-policy-strict"]')
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="security-policy-gdpr-art32"]')
    ).not.toBeNull();
    expect(component.customPolicies()).toHaveLength(1);
    const key = component.customPolicies()[0].key;
    expect(
      fixture.nativeElement.querySelector(`[data-testid="security-custom-${key}"]`)
    ).not.toBeNull();
  });

  describe('forced (MDM) policies', () => {
    it('a forced built-in policy is checked, disabled, and shows a badge', async () => {
      setup(baseResponse({ enabled_policies: ['strict'], forced_policies: ['strict'] }));
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(component.isBuiltinEnabled('strict')).toBe(true);
      expect(component.isForced('strict')).toBe(true);
      const checkbox = fixture.nativeElement.querySelector(
        '[data-testid="security-policy-strict"]'
      ) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      expect(checkbox.disabled).toBe(true);
      expect(
        fixture.nativeElement.querySelector('[data-testid="security-forced-strict"]')
      ).not.toBeNull();
    });

    it('toggling a forced built-in policy is a no-op', async () => {
      setup(baseResponse({ enabled_policies: ['strict'], forced_policies: ['strict'] }));
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.toggleBuiltin('strict', checkboxEvent(false));
      expect(component.isBuiltinEnabled('strict')).toBe(true);
    });
  });

  describe('built-in checklist toggling', () => {
    it('toggling on a non-forced built-in policy enables it', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.toggleBuiltin('gdpr-art32', checkboxEvent(true));
      expect(component.isBuiltinEnabled('gdpr-art32')).toBe(true);
    });

    it('toggling off an enabled built-in policy disables it', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.toggleBuiltin('strict', checkboxEvent(false));
      expect(component.isBuiltinEnabled('strict')).toBe(false);
    });
  });

  describe('custom policy rows', () => {
    it('adds and removes a custom policy row', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.addCustomPolicy();
      expect(component.customPolicies()).toHaveLength(1);
      const key = component.customPolicies()[0].key;
      component.removeCustomPolicy(key);
      expect(component.customPolicies()).toHaveLength(0);
    });

    it('names a custom policy row and toggles its enabled state', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.addCustomPolicy();
      const key = component.customPolicies()[0].key;
      component.onCustomNameInput(key, 'Employee Roster');
      expect(component.customPolicies()[0].name).toBe('Employee Roster');
      component.toggleCustom(key, checkboxEvent(false));
      expect(component.customPolicies()[0].enabled).toBe(false);
    });

    it('toggles a category tokenize/log pair independently', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.addCustomPolicy();
      const key = component.customPolicies()[0].key;
      component.onCustomCategoryToggle(key, 'EMAIL', 'tokenize', checkboxEvent(true));
      component.onCustomCategoryToggle(key, 'EMAIL', 'log', checkboxEvent(true));
      const cats = component.customPolicies()[0].categories;
      expect(cats.EMAIL).toEqual({ tokenize: true, log: true });
      expect(cats.PHONE_PL).toEqual({ tokenize: false, log: false });
    });
  });

  describe('custom pattern rows', () => {
    it('adds and removes a pattern row on a custom policy', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.addCustomPolicy();
      const key = component.customPolicies()[0].key;
      component.addPattern(key);
      expect(component.customPolicies()[0].patterns).toHaveLength(1);
      component.removePattern(key, 0);
      expect(component.customPolicies()[0].patterns).toHaveLength(0);
    });

    it('flags a syntactically invalid regex inline and blocks Save', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.addCustomPolicy();
      const key = component.customPolicies()[0].key;
      component.onCustomNameInput(key, 'Custom');
      component.addPattern(key);
      component.onPatternNameInput(key, 0, 'Bad');
      component.onPatternRegexInput(key, 0, '(unclosed');
      expect(component.patternErrorsFor(key)[0]).not.toBeNull();
      expect(component.canSave()).toBe(false);
    });

    it('accepts a valid regex and clears the row error', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.addCustomPolicy();
      const key = component.customPolicies()[0].key;
      component.addPattern(key);
      component.onPatternNameInput(key, 0, 'Employee ID');
      component.onPatternRegexInput(key, 0, '\\bEMP-\\d{4,8}\\b');
      expect(component.patternErrorsFor(key)[0]).toBeNull();
    });
  });

  describe('sensitive key rows', () => {
    it('adds and removes a key row on a custom policy', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.addCustomPolicy();
      const key = component.customPolicies()[0].key;
      component.addKey(key);
      component.onKeyInput(key, 0, 'Salary');
      expect(component.customPolicies()[0].sensitiveKeys).toEqual(['Salary']);
      component.removeKey(key, 0);
      expect(component.customPolicies()[0].sensitiveKeys).toHaveLength(0);
    });
  });

  describe('dirty gating of Save', () => {
    it('the form and Save button are absent until get_security_policy resolves', async () => {
      let resolvePolicy!: (r: SecurityPolicyResponse) => void;
      mockTauri = new MockTauriService();
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_security_policy_templates') return baseTemplates();
        if (cmd === 'get_security_policy') {
          return new Promise<SecurityPolicyResponse>((r) => {
            resolvePolicy = r;
          });
        }
        return undefined;
      };
      await create();
      component.ngOnInit();
      fixture.detectChanges();
      expect(component.loaded()).toBe(false);
      expect(component.canSave()).toBe(false);
      expect(fixture.nativeElement.querySelector('[data-testid="security-save"]')).toBeNull();
      resolvePolicy(baseResponse());
      await new Promise((r) => setTimeout(r, 0));
      fixture.detectChanges();
      expect(component.loaded()).toBe(true);
      expect(fixture.nativeElement.querySelector('[data-testid="security-save"]')).not.toBeNull();
    });

    it('Save starts disabled right after load', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      expect(component.canSave()).toBe(false);
    });

    it('toggling a built-in policy enables Save', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.toggleBuiltin('gdpr-art32', checkboxEvent(true));
      expect(component.canSave()).toBe(true);
    });

    it('an unnamed custom policy row blocks Save', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.addCustomPolicy();
      expect(component.canSave()).toBe(false);
    });
  });

  describe('save', () => {
    it('sends only built-in ids in policies and full definitions in custom_policies', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.toggleBuiltin('gdpr-art32', checkboxEvent(true));
      component.addCustomPolicy();
      const key = component.customPolicies()[0].key;
      component.onCustomNameInput(key, 'Employee Roster');
      component.addKey(key);
      component.onKeyInput(key, 0, 'Salary');
      const spy = vi.spyOn(mockTauri, 'invoke');
      await component.save();
      const call = spy.mock.calls.find((c) => c[0] === 'update_security_policy');
      expect(call).toBeDefined();
      const update = (call?.[1] as { update: SecurityPolicyUpdate }).update;
      expect(update.policies.sort()).toEqual(['gdpr-art32', 'strict']);
      expect(update.custom_policies).toHaveLength(1);
      expect(update.custom_policies[0].name).toBe('Employee Roster');
      expect(update.custom_policies[0].enabled).toBe(true);
      expect(update.custom_policies[0].sensitive_keys_add).toEqual(['salary']);
    });

    it('never sends a forced policy id, even when it was in enabled_policies', async () => {
      setup(baseResponse({ enabled_policies: ['strict'], forced_policies: ['strict'] }));
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.toggleBuiltin('gdpr-art32', checkboxEvent(true));
      const spy = vi.spyOn(mockTauri, 'invoke');
      await component.save();
      const call = spy.mock.calls.find((c) => c[0] === 'update_security_policy');
      expect(call).toBeDefined();
      const update = (call?.[1] as { update: SecurityPolicyUpdate }).update;
      expect(update.policies).toEqual(['gdpr-art32']);
    });

    it('requests a container restart on success', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.toggleBuiltin('gdpr-art32', checkboxEvent(true));
      const projectState = TestBed.inject(ProjectStateService);
      const spy = vi.spyOn(projectState, 'requestRestart');
      await component.save();
      expect(spy).toHaveBeenCalledOnce();
      expect(component.saved()).toBe(true);
    });

    it('surfaces a save error and does not request a restart', async () => {
      mockTauri.invokeHandler = async (cmd: string) => {
        if (cmd === 'list_security_policy_templates') return baseTemplates();
        if (cmd === 'get_security_policy') return baseResponse();
        if (cmd === 'update_security_policy') throw new Error('save failed');
        return undefined;
      };
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.toggleBuiltin('gdpr-art32', checkboxEvent(true));
      const projectState = TestBed.inject(ProjectStateService);
      const spy = vi.spyOn(projectState, 'requestRestart');
      await component.save();
      expect(spy).not.toHaveBeenCalled();
      expect(component.saveError()).toBe('save failed');
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="security-save-error"]')
      ).not.toBeNull();
    });
  });

  it('reloads the policy when the active project becomes ready', async () => {
    await create();
    component.ngOnInit();
    await fixture.whenStable();
    let calls = 0;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_security_policy_templates') return baseTemplates();
      if (cmd === 'get_security_policy') {
        calls += 1;
        return baseResponse({ enabled_policies: ['gdpr-art32'] });
      }
      return undefined;
    };
    const projectState = TestBed.inject(ProjectStateService);
    const readyCb = (projectState as unknown as { readyListeners: Array<() => void> })
      .readyListeners[0];
    expect(readyCb).toBeDefined();
    readyCb();
    await fixture.whenStable();
    expect(calls).toBe(1);
    expect(component.isBuiltinEnabled('gdpr-art32')).toBe(true);
    expect(component.isBuiltinEnabled('strict')).toBe(false);
  });

  it('unsubscribes the project-ready listener on destroy', async () => {
    await create();
    component.ngOnInit();
    await fixture.whenStable();
    const projectState = TestBed.inject(ProjectStateService);
    const before = (projectState as unknown as { readyListeners: unknown[] }).readyListeners.length;
    expect(before).toBeGreaterThan(0);
    component.ngOnDestroy();
    const after = (projectState as unknown as { readyListeners: unknown[] }).readyListeners.length;
    expect(after).toBe(before - 1);
  });

  it('refresh() surfaces an error and emits errorOccurred when loading fails', async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async () => {
      throw new Error('boom');
    };
    await create();
    const emitted: string[] = [];
    component.errorOccurred.subscribe((m) => emitted.push(m));
    component.ngOnInit();
    await fixture.whenStable();
    expect(component.error()).toBe('boom');
    expect(emitted).toContain('boom');
  });
});
