import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { SkillsViewComponent } from './skills-view.component';
import { SkillsService, HARDCODED_FALLBACK, type Skill } from '../services/skills.service';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

function testSkill(overrides: Partial<Skill>): Skill {
  return {
    id: 'help',
    name: 'help',
    source: 'built-in',
    kind: 'builtin',
    description: 'Show help',
    argumentHint: null,
    plugin: null,
    ...overrides,
  };
}

/**
 * Test stub that mirrors the SkillsService public API. Tests drive state
 * via the writable `discovered` signal directly — no reaching into private
 * fields, no type casts.
 */
class SkillsServiceStub {
  readonly discovered: WritableSignal<readonly Skill[]> = signal<readonly Skill[]>([]);
  refreshResult: readonly Skill[] = [];
  async refresh(): Promise<readonly Skill[]> {
    this.discovered.set(this.refreshResult);
    return this.refreshResult;
  }
}

describe('SkillsViewComponent', () => {
  let component: SkillsViewComponent;
  let fixture: ComponentFixture<SkillsViewComponent>;
  let mockTauri: MockTauriService;
  let svc: SkillsServiceStub;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    svc = new SkillsServiceStub();
    // Default to the production fallback so the empty-state and table tests
    // reflect the real consumer contract.
    svc.refreshResult = HARDCODED_FALLBACK;
    await TestBed.configureTestingModule({
      imports: [SkillsViewComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: SkillsService, useValue: svc },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SkillsViewComponent);
    component = fixture.componentInstance;
  });

  it('creates the component', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('renders the empty-state placeholder when the catalog is empty', async () => {
    svc.refreshResult = [];
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    expect(svc.discovered().length).toBe(0);
    const empty = fixture.nativeElement.querySelector('[data-testid="skills-empty"]');
    expect(empty).not.toBeNull();
  });

  it('renders the fallback list after ngOnInit', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="skills-row"]');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('shows the visually-hidden caption for screen readers', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const caption = fixture.nativeElement.querySelector('caption');
    expect(caption).not.toBeNull();
    expect(caption.classList.contains('sr-only')).toBe(true);
    expect(caption.textContent).toContain('Slash commands');
  });

  it('uses the mockup table scaffolding (ring-1, rounded, mono, border-collapse)', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const wrapper = fixture.nativeElement.querySelector('[data-testid="skills-table-wrapper"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper.classList.contains('rounded')).toBe(true);
    expect(wrapper.classList.contains('ring-1')).toBe(true);
    expect(wrapper.classList.contains('overflow-hidden')).toBe(true);

    const table = wrapper.querySelector('[data-testid="skills-table"]');
    expect(table.classList.contains('mono')).toBe(true);
    expect(table.classList.contains('border-collapse')).toBe(true);
  });

  it('renders the name column with a leading slash', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const firstName = fixture.nativeElement.querySelector('[data-testid="skills-row-name"]');
    expect(firstName.textContent.trim().startsWith('/')).toBe(true);
  });

  it('updates the header count after refresh', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const count = fixture.nativeElement.querySelector('[data-testid="skills-count"]');
    expect(count.textContent).toMatch(/\d+ entries/);
  });

  describe('badge helpers', () => {
    it('labels plugin-prefixed entries as plugin:<slug>', () => {
      const skill = testSkill({ plugin: 'code-review-pack', source: 'plugin', kind: 'plugin' });
      expect((component as unknown as { badgeLabel(s: Skill): string }).badgeLabel(skill)).toBe(
        'plugin:code-review-pack'
      );
    });

    it('uses teal for skill source', () => {
      const skill = testSkill({ source: 'skill', kind: 'skill' });
      expect(
        (component as unknown as { badgeClass(s: Skill): string }).badgeClass(skill)
      ).toContain('teal');
    });

    it('uses amber for agent source', () => {
      const skill = testSkill({ source: 'agent', kind: 'agent' });
      expect(
        (component as unknown as { badgeClass(s: Skill): string }).badgeClass(skill)
      ).toContain('amber');
    });

    it('uses violet for plugin-tagged entries regardless of source', () => {
      const skill = testSkill({ plugin: 'jira-bridge', source: 'skill', kind: 'skill' });
      expect(
        (component as unknown as { badgeClass(s: Skill): string }).badgeClass(skill)
      ).toContain('violet');
    });

    it('degrades gracefully for unknown source', () => {
      const skill = testSkill({ source: 'built-in', kind: 'builtin' });
      expect((component as unknown as { badgeLabel(s: Skill): string }).badgeLabel(skill)).toBe(
        'built-in'
      );
    });
  });

  it('shows a dash for empty descriptions', async () => {
    svc.refreshResult = [testSkill({ id: 'no-desc', name: 'no-desc', description: '' })];
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const descCells = fixture.nativeElement.querySelectorAll(
      '[data-testid="skills-row-description"]'
    );
    expect(descCells.length).toBeGreaterThan(0);
    expect(descCells[0].textContent.trim()).toBe('—');
  });
});
