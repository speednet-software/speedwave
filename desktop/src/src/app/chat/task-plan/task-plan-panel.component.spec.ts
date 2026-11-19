import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TaskPlanPanelComponent } from './task-plan-panel.component';
import type { PlannedTask } from './task-plan';

const PLAN: readonly PlannedTask[] = [
  { id: '1', subject: 'Read code', status: 'completed' },
  { id: '2', subject: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
  { id: '3', subject: 'Ship', status: 'pending' },
];

describe('TaskPlanPanelComponent', () => {
  let fixture: ComponentFixture<TaskPlanPanelComponent>;
  let expandedChanges: boolean[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TaskPlanPanelComponent] }).compileComponents();
    fixture = TestBed.createComponent(TaskPlanPanelComponent);
    expandedChanges = [];
    fixture.componentInstance.expandedChange.subscribe((v) => expandedChanges.push(v));
  });

  function render(
    plan: readonly PlannedTask[] | null,
    streaming = true,
    expanded = false
  ): HTMLElement {
    fixture.componentRef.setInput('plan', plan);
    fixture.componentRef.setInput('streaming', streaming);
    fixture.componentRef.setInput('expanded', expanded);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function q(el: HTMLElement, id: string): HTMLElement | null {
    return el.querySelector(`[data-testid="${id}"]`);
  }

  it('renders nothing without a plan', () => {
    expect(q(render(null), 'task-plan-panel')).toBeNull();
  });

  it('shows one collapsed line with the count and the task in progress', () => {
    const el = render(PLAN);
    expect(q(el, 'task-plan-count')?.textContent?.trim()).toBe('Tasks 1/3');
    expect(q(el, 'task-plan-current')?.textContent?.trim()).toBe('Fixing bug');
    expect(q(el, 'task-plan-list')).toBeNull();
    expect(q(el, 'task-plan-toggle')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('names the subject when the task in progress has no active form, and nothing when none is', () => {
    let el = render([{ id: '1', subject: 'Fix bug', status: 'in_progress' }]);
    expect(q(el, 'task-plan-current')?.textContent?.trim()).toBe('Fix bug');
    el = render([{ id: '1', subject: 'Fix bug', status: 'pending' }]);
    expect(q(el, 'task-plan-current')).toBeNull();
  });

  it('asks to expand on a click of the line', () => {
    q(render(PLAN), 'task-plan-toggle')?.click();
    expect(expandedChanges).toEqual([true]);
  });

  it('lists every task with its glyph when expanded, and asks to collapse on a click', () => {
    const el = render(PLAN, true, true);
    const items = Array.from(el.querySelectorAll('[data-testid="task-plan-item"]')).map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim()
    );
    expect(items).toEqual(['✓ Read code', '▸ Fixing bug', '○ Ship']);
    expect(q(el, 'task-plan-toggle')?.getAttribute('aria-expanded')).toBe('true');
    q(el, 'task-plan-toggle')?.click();
    expect(expandedChanges).toEqual([false]);
  });

  it('stays while the turn streams once every task is done, and hides after it ends', () => {
    const done = PLAN.map((t) => ({ ...t, status: 'completed' }));
    expect(q(render(done, true), 'task-plan-count')?.textContent?.trim()).toBe('Tasks 3/3');
    expect(q(render(done, false), 'task-plan-panel')).toBeNull();
  });

  it('stays after the turn ends while a task is open', () => {
    expect(q(render(PLAN, false), 'task-plan-panel')).not.toBeNull();
  });
});
