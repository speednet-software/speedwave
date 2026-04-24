import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SkillsService } from './skills.service';

describe('SkillsService', () => {
  let service: SkillsService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(SkillsService);
  });

  it('starts with an empty discovered list', () => {
    expect(service.discovered()).toEqual([]);
  });

  it('refresh() populates discovered with the hardcoded fallback', async () => {
    const result = await service.refresh();

    expect(result.length).toBeGreaterThan(0);
    expect(service.discovered()).toEqual(result);
  });

  it('fallback list always contains the core built-ins', () => {
    const ids = service.fallback().map((s) => s.id);
    expect(ids).toContain('help');
    expect(ids).toContain('clear');
    expect(ids).toContain('compact');
    expect(ids).toContain('resume');
    expect(ids).toContain('cost');
    expect(ids).toContain('context');
    expect(ids).toContain('memory');
  });

  it('every fallback entry is marked source=built-in and kind=builtin', () => {
    for (const skill of service.fallback()) {
      expect(skill.source).toBe('built-in');
      expect(skill.kind).toBe('builtin');
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.plugin).toBeNull();
    }
  });

  it('refresh() returns a stable list across calls (idempotent)', async () => {
    const first = await service.refresh();
    const second = await service.refresh();
    expect(second).toEqual(first);
  });

  it('keeps discovered() stable between refresh calls (no spurious re-emits)', async () => {
    await service.refresh();
    const snapshot = service.discovered();
    // Reading twice returns the same reference, so OnPush consumers skip rerender.
    expect(service.discovered()).toBe(snapshot);
  });
});
