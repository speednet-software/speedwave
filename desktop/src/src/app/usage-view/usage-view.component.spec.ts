import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UsageViewComponent } from './usage-view.component';
import { ProjectStateService } from '../services/project-state.service';
import { TauriService } from '../services/tauri.service';

/**
 * Drains microtasks so the hosted LlmUsageComponent's project effect settles.
 * @param cycles - Number of ticks to drain.
 */
async function flushMicrotasks(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
}

function emptySummary() {
  return { days: {}, hours: {}, totals: bucket(), skipped_lines: 0 };
}

function bucket() {
  return {
    requests: 0,
    failures: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: 0,
    throughput_completion_tokens: 0,
    decode_latency_ms_sum: 0,
  };
}

describe('UsageViewComponent', () => {
  async function setup(activeProject: string | null) {
    const invoke = vi.fn().mockResolvedValue(emptySummary());
    const projectState = {
      activeProject,
      projects: activeProject ? [{ name: activeProject }] : [],
      onChange: () => () => undefined,
      onProjectReady: () => () => undefined,
    };
    await TestBed.configureTestingModule({
      imports: [UsageViewComponent],
      providers: [
        { provide: TauriService, useValue: { invoke } },
        { provide: ProjectStateService, useValue: projectState },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(UsageViewComponent);
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();
    return { fixture, invoke };
  }

  it('renders the title and hosts the usage dashboard when a project is active', async () => {
    const { fixture, invoke } = await setup('proj');
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="usage-title"]')?.textContent).toContain('LLM usage');
    expect(el.querySelector('[data-testid="usage-no-project"]')).toBeNull();
    // The hosted dashboard fetched usage for the active project.
    expect(invoke).toHaveBeenCalledWith('get_llm_usage', { project: 'proj' });
  });

  it('shows the no-project state and skips the dashboard when no project is active', async () => {
    const { fixture, invoke } = await setup(null);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="usage-no-project"]')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('get_llm_usage', expect.anything());
  });
});
