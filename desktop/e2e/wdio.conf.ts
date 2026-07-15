import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runPreflight } from './helpers/preflight';

const SCREENSHOT_DIR = join(process.cwd(), 'screenshots');

// Rigs split the run around factory-reset so engine-level bats suites get a live-project
// window between the last non-destructive spec and 07-factory-reset.spec.ts.
const FACTORY_RESET_SPEC = './specs/07-factory-reset.spec.ts';
const ALL_SPECS = [
  './specs/01-app-lifecycle.spec.ts',
  './specs/02-setup-wizard.spec.ts',
  './specs/03-container-health.spec.ts',
  './specs/04-navigation.spec.ts',
  './specs/05-settings.spec.ts',
  './specs/06-project-management.spec.ts',
  './specs/08-chat-cost-reconciliation.spec.ts',
  './specs/09-chat-conversation.spec.ts',
  './specs/10-second-project-no-llm.spec.ts',
  './specs/11-local-provider-resume.spec.ts',
  './specs/12-provider-errors.spec.ts',
  './specs/13-chat-controls.spec.ts',
  './specs/14-usage-per-project.spec.ts',
  './specs/15-integration-toggle.spec.ts',
  './specs/16-restart-deferral.spec.ts',
  './specs/17-logs-diagnostics.spec.ts',
  './specs/18-anthropic-oauth-login.spec.ts',
  './specs/19-dirty-state-self-heal.spec.ts',
  FACTORY_RESET_SPEC,
];

function resolveSpecs(): string[] {
  const phase = process.env.SPW_E2E_SPEC_PHASE ?? 'all';
  if (phase === 'pre-reset') return ALL_SPECS.filter((s) => s !== FACTORY_RESET_SPEC);
  if (phase === 'reset-only') return [FACTORY_RESET_SPEC];
  if (phase !== 'all') throw new Error(`unknown SPW_E2E_SPEC_PHASE: ${phase}`);
  return ALL_SPECS;
}

export const config = {
  runner: 'local',
  specs: resolveSpecs(),
  maxInstances: 1,
  bail: 1,

  // App embeds tauri-plugin-webdriver on port 4445 — no external tauri-driver needed.
  // The app must be launched before wdio (Makefile / e2e-vm.sh handles this).
  capabilities: [{}],

  hostname: '127.0.0.1',
  port: 4445,
  path: '/',

  framework: 'mocha',
  mochaOpts: {
    // Default per-test timeout. Individual specs override with this.timeout().
    // 45 min accommodates slow first-time builds on cold machines.
    timeout: 2_700_000,
    ui: 'bdd',
  },

  reporters: ['spec'],

  logLevel: 'warn',

  // Fail fast on a broken external dependency: an exhausted OpenRouter account or
  // an unreachable local LLM otherwise surfaces mid-suite as an unrelated timeout.
  onPrepare: async function () {
    const failures = await runPreflight();
    if (failures.length === 0) return;
    const detail = failures.map((f) => `  ✖ ${f.service}: ${f.reason}`).join('\n');
    throw new Error(`E2E preflight failed — the suite cannot produce a valid result:\n${detail}`);
  },

  afterTest: async function (
    _test: unknown,
    _context: unknown,
    { passed, error }: { passed: boolean; error?: Error }
  ) {
    if (!passed) {
      if (error) console.error(`Test failed: ${error.message}`);
      try {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filepath = join(SCREENSHOT_DIR, `FAIL-${timestamp}.png`);
        await browser.saveScreenshot(filepath);
        console.log(`Screenshot saved: ${filepath}`);
      } catch (e) {
        console.error(`Failed to save screenshot: ${e}`);
      }
    }
  },
};
