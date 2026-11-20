import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { AgentPanelComponent } from './agent-panel.component';
import type { AgentView } from './agents';

function agent(overrides: Partial<AgentView>): AgentView {
  return {
    id: 'a1',
    label: 'Explore code',
    type: null,
    background: false,
    status: 'running',
    toolCount: 0,
    lastActivity: '',
    result: null,
    ...overrides,
  };
}

const AGENTS: readonly AgentView[] = [
  agent({
    id: 'a1',
    label: 'Explore code',
    type: 'Explore',
    toolCount: 2,
    lastActivity: 'Bash $ make test',
  }),
  agent({ id: 'a2', label: 'Review', status: 'running', toolCount: 1 }),
  agent({ id: 'a3', label: 'Lint', status: 'completed', toolCount: 3 }),
];

describe('AgentPanelComponent', () => {
  let fixture: ComponentFixture<AgentPanelComponent>;
  let expandedChanges: boolean[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AgentPanelComponent] }).compileComponents();
    fixture = TestBed.createComponent(AgentPanelComponent);
    expandedChanges = [];
    fixture.componentInstance.expandedChange.subscribe((v) => expandedChanges.push(v));
  });

  function render(agents: readonly AgentView[], expanded = false): HTMLElement {
    fixture.componentRef.setInput('agents', agents);
    fixture.componentRef.setInput('expanded', expanded);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function q(el: HTMLElement, id: string): HTMLElement | null {
    return el.querySelector(`[data-testid="${id}"]`);
  }

  it('renders nothing without agents', () => {
    expect(q(render([]), 'agent-panel')).toBeNull();
  });

  it('shows one collapsed line with how many agents run and how many are done', () => {
    const el = render(AGENTS);
    expect(q(el, 'agent-panel-summary')?.textContent?.trim()).toBe('Agents 2 running, 1 done');
    expect(q(el, 'agent-panel-list')).toBeNull();
    expect(q(el, 'agent-panel-toggle')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('names failed and stopped agents in the line and leaves out a zero count', () => {
    const el = render([
      agent({ id: 'a1', status: 'error' }),
      agent({ id: 'a2', status: 'stopped' }),
      agent({ id: 'a3', status: 'stopped' }),
    ]);
    expect(q(el, 'agent-panel-summary')?.textContent?.trim()).toBe('Agents 1 failed, 2 stopped');
  });

  it('asks to expand on a click and to collapse on a click when expanded', () => {
    q(render(AGENTS), 'agent-panel-toggle')?.click();
    q(render(AGENTS, true), 'agent-panel-toggle')?.click();
    expect(expandedChanges).toEqual([true, false]);
  });

  it('is a button, so Enter and Space reach it from the keyboard', () => {
    expect(q(render(AGENTS), 'agent-panel-toggle')?.tagName).toBe('BUTTON');
  });

  it('lists every agent separately with its status, tool count and last activity when expanded', () => {
    const el = render(AGENTS, true);
    const items = Array.from(el.querySelectorAll('[data-testid="agent-panel-item"]'));
    expect(items.map((li) => li.getAttribute('data-status'))).toEqual([
      'running',
      'running',
      'completed',
    ]);
    expect(
      items.map((li) => li.querySelector('[data-testid="agent-panel-label"]')?.textContent)
    ).toEqual(['Explore code', 'Review', 'Lint']);
    expect(items[0].querySelector('[data-testid="agent-panel-type"]')?.textContent?.trim()).toBe(
      'Explore'
    );
    expect(
      items.map((li) =>
        li
          .querySelector('[data-testid="agent-panel-meta"]')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim()
      )
    ).toEqual(['running · 2 tools', 'running · 1 tool', 'completed · 3 tools']);
    expect(
      items[0].querySelector('[data-testid="agent-panel-activity"]')?.textContent?.trim()
    ).toBe('Bash $ make test');
    expect(items[1].querySelector('[data-testid="agent-panel-activity"]')).toBeNull();
    expect(q(el, 'agent-panel-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('links the toggle to the list it opens', () => {
    const el = render(AGENTS, true);
    const list = q(el, 'agent-panel-list');
    expect(q(el, 'agent-panel-toggle')?.getAttribute('aria-controls')).toBe(list?.id);
  });
});
