import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TauriService } from './tauri.service';
import { AuditorService } from './auditor.service';
import { complianceLabel, riskLabel, type AuditorStatus } from '../models/auditor';
import { ModelSelectorComponent } from '../chat/composer/model-selector/model-selector.component';
import { ChatHeaderComponent } from '../chat/header/chat-header.component';
import { AuditorPanelComponent } from '../settings/llm-provider/auditor-panel.component';
import type { ActiveProviderSummary } from '../models/llm';
import { ModelPickerService } from './model-picker.service';

const managed: AuditorStatus = {
  managed: true,
  reachable: true,
  error: null,
  auditor_url: 'http://127.0.0.1:30080',
  agent_version: '1.0.3',
  latency_ms: 42,
  checked_at: '2026-10-05T08:00:00Z',
  organization: 'Speednet',
  host: { id: 'h', name: 'MacBook (Speedwave)' },
  access: { state: 'ALLOWED', models: [], pinned_model: 'claude-opus-4-8' },
  deployments: [],
  use_cases: [],
  project: {
    name: 'proj-1',
    use_case: {
      node_id: 'n-1',
      name: 'Coding assistant',
      attribution: 'rule',
      state: 'ALLOWED',
      compliance: { state: 'AWAITING_PROFILES', open: 0, riskCategory: 'NOT_CLASSIFIED' },
    },
    deployment: {
      id: 'd',
      name: 'Claude Code subscription',
      deploymentType: 'SUBSCRIPTION',
      providerName: 'Anthropic',
      providerCode: 'anthropic',
      region: null,
    },
    models: ['claude-opus-4-8'],
    default_model: 'claude-opus-4-8',
    pinned: true,
    access: 'ALLOWED',
  },
  package_version: '1.0.3',
};

const summary: ActiveProviderSummary = {
  provider_id: 'anthropic',
  kind: 'anthropic_oauth',
  model: null,
  base_url: null,
  effort_levels: ['low', 'medium', 'high'],
};

function tauri(status: AuditorStatus | null) {
  return vi.fn(async (cmd: string) => {
    if (cmd === 'get_auditor_status')
      return status ?? { ...managed, managed: false, project: null };
    if (cmd === 'get_active_provider_summary') return summary;
    if (cmd === 'get_effort_pin') return null;
    if (cmd === 'get_model_hint') return null;
    if (cmd === 'list_anthropic_models') return [];
    if (cmd === 'get_chat_session_info') return { state: 'unavailable' };
    if (cmd === 'list_model_picker') return { rows: [] };
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

async function settle(fixture: {
  whenStable(): Promise<unknown>;
  detectChanges(): void;
}): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }
}

describe('Auditor labels', () => {
  it('names the registry approval and the risk category', () => {
    expect(complianceLabel({ state: 'INCOMPLETE', open: 3 })).toBe('Evidence incomplete · 3 open');
    expect(complianceLabel({ state: 'AWAITING_PROFILES' })).toBe('Awaiting profiles');
    expect(complianceLabel(null)).toBe('Compliance unknown');
    expect(riskLabel('NOT_CLASSIFIED')).toBe('Not classified');
    expect(riskLabel('HIGH')).toBe('High');
  });
});

describe('Speedwave under Auditor', () => {
  let invoke: ReturnType<typeof vi.fn>;

  function setup(status: AuditorStatus | null): void {
    invoke = tauri(status);
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { invoke } }],
    });
  }

  it('the store asks the desktop backend about a project and keeps the answer', async () => {
    setup(managed);
    const auditor = TestBed.inject(AuditorService);
    await auditor.refresh('proj-1');
    expect(invoke).toHaveBeenCalledWith('get_auditor_status', { project: 'proj-1', force: false });
    expect(auditor.statusFor('proj-1')?.project?.use_case?.name).toBe('Coding assistant');
    expect(auditor.managed()).toBe(true);
  });

  it('the model list holds only the models Auditor allows, marked with the Auditor mark', async () => {
    setup(managed);
    const fixture = TestBed.createComponent(ModelSelectorComponent);
    fixture.componentRef.setInput('projectId', 'proj-1');
    await settle(fixture);
    const badge = fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]'));
    const label = TestBed.inject(ModelPickerService).label('claude-opus-4-8', 'proj-1');
    expect(badge.nativeElement.textContent).toContain(label);
    expect(
      fixture.debugElement.query(By.css('[data-testid="composer-model-auditor-mark"]'))
    ).not.toBeNull();
    badge.nativeElement.click();
    await settle(fixture);
    const ids = fixture.debugElement
      .queryAll(By.css('[data-testid^="model-selector-option-"]'))
      .map((o) => o.nativeElement.getAttribute('data-testid'));
    expect(ids).toEqual(['model-selector-option-claude-opus-4-8']);
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-auditor"]')).nativeElement
        .textContent
    ).toContain('Speednet');
  });

  it('without the policy the model list is Speedwave’s own', async () => {
    setup(null);
    const fixture = TestBed.createComponent(ModelSelectorComponent);
    fixture.componentRef.setInput('projectId', 'proj-1');
    await settle(fixture);
    expect(
      fixture.debugElement.query(By.css('[data-testid="composer-model-auditor-mark"]'))
    ).toBeNull();
  });

  it('the project header shows the use case and its compliance', async () => {
    setup(managed);
    const auditor = TestBed.inject(AuditorService);
    await auditor.refresh('');
    const fixture = TestBed.createComponent(ChatHeaderComponent);
    await settle(fixture);
    const chip = fixture.debugElement.query(By.css('[data-testid="chat-header-auditor"]'));
    expect(chip.nativeElement.textContent).toContain('Coding assistant');
    expect(chip.nativeElement.textContent).toContain('Awaiting profiles');
  });

  it('Settings › LLM providers shows what Auditor applies, read-only', async () => {
    setup(managed);
    const fixture = TestBed.createComponent(AuditorPanelComponent);
    fixture.componentRef.setInput('project', 'proj-1');
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Managed by Speednet');
    expect(text).toContain('Claude Code subscription · Anthropic · subscription');
    expect(text).toContain(TestBed.inject(ModelPickerService).label('claude-opus-4-8', 'proj-1'));
    expect(text).toContain('pinned by Speednet');
    expect(text).toContain('Coding assistant');
    expect(text).toContain('Auditor for macOS 1.0.3');
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });
});
