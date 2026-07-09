import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SecuritySectionComponent } from './security-section.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import type {
  PiiCategoryFlags,
  SecurityPolicyResponse,
  SecurityPolicyTemplateInfo,
} from '../../models/security-policy';

function allOn(overrides: Partial<PiiCategoryFlags> = {}): PiiCategoryFlags {
  return {
    EMAIL: true,
    PHONE_PL: true,
    PESEL: true,
    NIP: true,
    IBAN: true,
    CARD: true,
    API_KEY: true,
    SENSITIVE_FIELD: true,
    ...overrides,
  };
}

function baseTemplates(): SecurityPolicyTemplateInfo[] {
  return [
    { id: 'strict', name: 'Strict', description: 'All categories on.', categories: allOn() },
    {
      id: 'gdpr-art32',
      name: 'GDPR Art. 32',
      description: 'EU PII protection.',
      categories: allOn({ API_KEY: false }),
    },
  ];
}

function baseResponse(overrides: Partial<SecurityPolicyResponse> = {}): SecurityPolicyResponse {
  return {
    template: 'strict',
    categories: allOn(),
    custom_patterns: [],
    sensitive_keys_add: [],
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
    expect(component.selectedTemplate()).toBe('strict');
    expect(component.categories()).toEqual(allOn());
  });

  it('renders one radio card per built-in template plus a Custom card', async () => {
    await create();
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="security-template-strict"]')
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="security-template-gdpr-art32"]')
    ).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="security-template-custom"]')
    ).not.toBeNull();
  });

  it('selecting a built-in template shows its categories read-only', async () => {
    await create();
    component.ngOnInit();
    await fixture.whenStable();
    component.selectTemplate('gdpr-art32', allOn({ API_KEY: false }));
    expect(component.isCustom()).toBe(false);
    expect(component.categories()['API_KEY']).toBe(false);
    fixture.detectChanges();
    const checkbox = fixture.nativeElement.querySelector(
      '[data-testid="security-category-API_KEY"]'
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it('selecting Custom exposes editable category checkboxes and the pattern/key sections', async () => {
    await create();
    component.ngOnInit();
    await fixture.whenStable();
    component.selectCustom();
    fixture.detectChanges();
    expect(component.isCustom()).toBe(true);
    const checkbox = fixture.nativeElement.querySelector(
      '[data-testid="security-category-EMAIL"]'
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    expect(
      fixture.nativeElement.querySelector('[data-testid="security-pattern-add"]')
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="security-key-add"]')).not.toBeNull();
  });

  describe('onCategoryToggle', () => {
    function checkboxEvent(checked: boolean): Event {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      return { target: input } as unknown as Event;
    }

    it('turning a category OFF requires a confirm', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      component.onCategoryToggle('EMAIL', checkboxEvent(false));
      expect(spy).toHaveBeenCalledOnce();
      expect(component.categories()['EMAIL']).toBe(false);
    });

    it('cancelling the confirm reverts the checkbox and keeps the category on', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const ev = checkboxEvent(false);
      component.onCategoryToggle('EMAIL', ev);
      expect(component.categories()['EMAIL']).toBe(true);
      expect((ev.target as HTMLInputElement).checked).toBe(true);
    });

    it('turning a category ON never prompts', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      component.onCategoryToggle('API_KEY', checkboxEvent(false));
      const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      component.onCategoryToggle('API_KEY', checkboxEvent(true));
      expect(spy).not.toHaveBeenCalled();
      expect(component.categories()['API_KEY']).toBe(true);
    });
  });

  describe('custom pattern rows', () => {
    it('adds and removes a pattern row', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      component.addPattern();
      expect(component.customPatterns()).toHaveLength(1);
      component.removePattern(0);
      expect(component.customPatterns()).toHaveLength(0);
    });

    it('flags a syntactically invalid regex inline and blocks Save', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      component.addPattern();
      component.onPatternNameInput(0, 'Bad');
      component.onPatternRegexInput(0, '(unclosed');
      expect(component.patternErrors()[0]).not.toBeNull();
      expect(component.canSave()).toBe(false);
    });

    it('accepts a valid regex and clears the row error', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      component.addPattern();
      component.onPatternNameInput(0, 'Employee ID');
      component.onPatternRegexInput(0, '\\bEMP-\\d{4,8}\\b');
      expect(component.patternErrors()[0]).toBeNull();
    });
  });

  describe('sensitive key rows', () => {
    it('adds and removes a key row', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      component.addKey();
      component.onKeyInput(0, 'Salary');
      expect(component.sensitiveKeys()).toEqual(['Salary']);
      component.removeKey(0);
      expect(component.sensitiveKeys()).toHaveLength(0);
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

    it('editing a category enables Save', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      component.onCategoryToggle('API_KEY', { target: { checked: false } } as unknown as Event);
      expect(component.canSave()).toBe(true);
    });
  });

  describe('save', () => {
    it('invokes update_security_policy with { update } and lowercases sensitive keys', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
      component.addKey();
      component.onKeyInput(0, 'Salary');
      const spy = vi.spyOn(mockTauri, 'invoke');
      await component.save();
      const call = spy.mock.calls.find((c) => c[0] === 'update_security_policy');
      expect(call).toBeDefined();
      const update = (call?.[1] as { update: { sensitive_keys_add: string[] } }).update;
      expect(update.sensitive_keys_add).toEqual(['salary']);
    });

    it('requests a container restart on success', async () => {
      await create();
      component.ngOnInit();
      await fixture.whenStable();
      component.selectCustom();
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
      component.selectCustom();
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
        return baseResponse({ template: 'gdpr-art32', categories: allOn({ API_KEY: false }) });
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
    expect(component.selectedTemplate()).toBe('gdpr-art32');
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
