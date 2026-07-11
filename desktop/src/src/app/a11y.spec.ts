/**
 * Accessibility sweep: mounts each top-level routed component in jsdom and asserts zero WCAG
 * 2.1 AA violations, across every (effective-mode × accent) pair; new views must join VIEWS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterModule } from '@angular/router';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import type { Type } from '@angular/core';
import type { AxeResults } from 'axe-core';
import axe from 'axe-core';

import { AppComponent } from './app.component';
import { ChatComponent } from './chat/chat.component';
import { SettingsComponent } from './settings/settings.component';
import { IntegrationsComponent } from './integrations/integrations.component';
import { PluginsComponent } from './plugins/plugins.component';
import { PluginDetailComponent } from './plugins/plugin-detail/plugin-detail.component';
import { SetupWizardComponent } from './setup/setup-wizard.component';
import { ShellComponent } from './shell/shell.component';
import { ErrorBlockComponent } from './chat/blocks/error-block.component';
import { ThinkingBlockComponent } from './chat/blocks/thinking-block.component';
import { TextBlockComponent } from './chat/blocks/text-block.component';
import { AskUserBlockComponent } from './chat/blocks/ask-user-block.component';
import { ToolBlockComponent } from './chat/blocks/tool-block.component';

import { TauriService } from './services/tauri.service';
import { MockTauriService } from './testing/mock-tauri.service';
import { THEME_IDS, THEME_MODES, type ThemeId, type EffectiveMode } from './services/theme.service';

// Derived from THEME_MODES so a future explicit (non-auto) mode is swept automatically.
const EFFECTIVE_MODES: readonly EffectiveMode[] = THEME_MODES.filter(
  (m): m is EffectiveMode => m !== 'auto'
);

/** Stubs `window.matchMedia` so ThemeService can construct in jsdom. */
function stubMatchMedia(): void {
  if (typeof window.matchMedia === 'function') return;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/**
 * Toggles `.dark` on <html> to match the effective mode under test.
 * @param mode Effective appearance mode (`auto` is resolved upstream).
 */
function activateMode(mode: EffectiveMode): void {
  if (mode === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

interface ViewUnderTest {
  readonly name: string;
  readonly component: Type<unknown>;
  readonly prepare?: (fixture: ComponentFixture<unknown>) => void;
}

/** Configurable mock responses for routed views during jsdom render. */
function buildMockTauri(): MockTauriService {
  const mock = new MockTauriService();
  mock.invokeHandler = async (cmd: string) => {
    switch (cmd) {
      case 'list_projects':
        return { projects: [{ name: 'demo', dir: '/tmp/demo' }], active_project: 'demo' };
      case 'get_llm_config':
        return { provider: 'anthropic', model: null, base_url: null, api_key_env: null };
      case 'get_update_settings':
        return { auto_check: true, check_interval_hours: 24 };
      case 'get_platform':
        return 'darwin';
      case 'get_auth_status':
        return { api_key_configured: false, oauth_authenticated: false };
      case 'get_integrations':
        return { services: [] };
      case 'get_plugins':
        return { plugins: [] };
      case 'get_wizard_progress':
        return { stage: 'idle' };
      case 'get_container_status':
        return { running: false, restart_required: false };
      case 'get_chat_history':
        return { conversations: [] };
      case 'list_conversations':
        return { conversations: [] };
      case 'get_project_memory':
        return '';
      case 'check_runtime':
        return { ready: true };
      case 'list_available_ides':
        return [];
      case 'get_selected_ide':
        return null;
      case 'get_integration_statuses':
        return { services: [] };
      default:
        return undefined;
    }
  };
  return mock;
}

/**
 * Sets `data-theme` to the given accent variant; no-op for the default `ember`.
 * @param id - Accent theme to activate via the `data-theme` attribute.
 */
function activateTheme(id: ThemeId): void {
  const html = document.documentElement;
  if (id === 'ember') {
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('data-theme', id);
  }
}

/**
 * Renders a component in a detached fixture for axe inspection.
 * @param view - The view under test.
 * @param mockTauri - The mock TauriService used for invoke/listen calls.
 */
async function render(view: ViewUnderTest, mockTauri: MockTauriService): Promise<HTMLElement> {
  await TestBed.configureTestingModule({
    imports: [view.component, RouterModule.forRoot([])],
    providers: [{ provide: TauriService, useValue: mockTauri }],
  }).compileComponents();

  const fixture = TestBed.createComponent(view.component);
  view.prepare?.(fixture);
  fixture.detectChanges();
  // Allow microtasks from ngOnInit to settle so conditional content renders.
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const VIEWS: readonly ViewUnderTest[] = [
  { name: 'AppComponent', component: AppComponent },
  { name: 'ShellComponent', component: ShellComponent },
  { name: 'ChatComponent', component: ChatComponent },
  { name: 'SettingsComponent', component: SettingsComponent },
  { name: 'IntegrationsComponent', component: IntegrationsComponent },
  { name: 'PluginsComponent', component: PluginsComponent },
  { name: 'PluginDetailComponent', component: PluginDetailComponent },
  { name: 'SetupWizardComponent', component: SetupWizardComponent },
  {
    name: 'ErrorBlockComponent',
    component: ErrorBlockComponent,
    prepare: (fixture) => {
      fixture.componentRef.setInput('content', 'Something failed');
    },
  },
  {
    name: 'ThinkingBlockComponent',
    component: ThinkingBlockComponent,
    prepare: (fixture) => {
      fixture.componentRef.setInput('content', 'reasoning');
    },
  },
  {
    name: 'TextBlockComponent',
    component: TextBlockComponent,
    prepare: (fixture) => {
      fixture.componentRef.setInput('content', 'Hello **world**.');
    },
  },
  {
    name: 'AskUserBlockComponent',
    component: AskUserBlockComponent,
    prepare: (fixture) => {
      fixture.componentRef.setInput('question', {
        tool_id: 'ask-1',
        questions: [
          {
            question: 'Choose one',
            header: '',
            options: [
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ],
            multi_select: false,
          },
        ],
        current_index: 0,
        answers: [null],
      });
    },
  },
  {
    name: 'ToolBlockComponent',
    component: ToolBlockComponent,
    prepare: (fixture) => {
      fixture.componentRef.setInput('tool', {
        type: 'tool_use',
        tool_id: 'tool-1',
        tool_name: 'Read',
        input_json: '{}',
        status: 'running',
      });
    },
  },
];

/**
 * Classifies axe serious violations, discarding fragment-only advisory rules.
 * @param results - The full axe-core scan results.
 */
function seriousViolations(results: AxeResults): AxeResults['violations'] {
  const advisoryOnFragments = new Set([
    'landmark-one-main',
    'region',
    'page-has-heading-one',
    'document-title',
    'html-has-lang',
    'html-lang-valid',
    'bypass',
    'meta-viewport',
  ]);
  return results.violations.filter((v) => !advisoryOnFragments.has(v.id));
}

describe('A11y sweep — axe-core on every reachable view', () => {
  let mockTauri: MockTauriService;

  beforeEach(() => {
    stubMatchMedia();
    mockTauri = buildMockTauri();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    activateTheme('ember');
    activateMode('dark');
  });

  for (const mode of EFFECTIVE_MODES) {
    for (const themeId of THEME_IDS) {
      describe(`mode=${mode} theme=${themeId}`, () => {
        beforeEach(() => {
          activateMode(mode);
          activateTheme(themeId);
        });

        for (const view of VIEWS) {
          it(`${view.name} has zero serious axe violations`, async () => {
            const root = await render(view, mockTauri);
            const results = await axe.run(root, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
            });
            const blocking = seriousViolations(results);
            if (blocking.length) {
              const summary = blocking
                .map((v) => `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`)
                .join('\n');
              throw new Error(
                `axe found ${blocking.length} violations in ${view.name} (mode=${mode}, theme=${themeId}):\n${summary}`
              );
            }
            expect(blocking).toEqual([]);
          });
        }
      });
    }
  }
});
