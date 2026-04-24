import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SkillsViewComponent } from './skills-view.component';
import { SkillsService, type Skill } from '../services/skills.service';
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

describe('SkillsViewComponent', () => {
  let component: SkillsViewComponent;
  let fixture: ComponentFixture<SkillsViewComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    await TestBed.configureTestingModule({
      imports: [SkillsViewComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    // Reset the singleton's signal between tests so state does not leak.
    const svc = TestBed.inject(SkillsService);
    (svc as unknown as { _discovered: { set(v: readonly Skill[]): void } })._discovered.set([]);

    fixture = TestBed.createComponent(SkillsViewComponent);
    component = fixture.componentInstance;
  });

  it('creates the component', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('renders the empty-state placeholder when the catalog is empty', async () => {
    // Stub SkillsService.refresh to keep the internal signal empty.
    const svc = TestBed.inject(SkillsService);
    svc.refresh = async () => [];
    (svc as unknown as { _discovered: { set(v: readonly Skill[]): void } })._discovered.set([]);
    await component.ngOnInit();
    (svc as unknown as { _discovered: { set(v: readonly Skill[]): void } })._discovered.set([]);
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
    // Stub refresh so ngOnInit leaves the custom list intact, and seed a single
    // entry with an empty description.
    const svc = TestBed.inject(SkillsService);
    const modified: readonly Skill[] = [
      testSkill({ id: 'no-desc', name: 'no-desc', description: '' }),
    ];
    svc.refresh = async () => modified;
    (svc as unknown as { _discovered: { set(v: readonly Skill[]): void } })._discovered.set(
      modified
    );
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
