import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCREENSHOT_DIR = join(process.cwd(), 'screenshots');

export const config = {
  runner: 'local',
  specs: [
    './specs/01-app-lifecycle.spec.ts',
    './specs/02-setup-wizard.spec.ts',
    './specs/03-navigation.spec.ts',
    './specs/04-settings.spec.ts',
    './specs/05-project-management.spec.ts',
  ],
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

  afterTest: async function (
    _test: unknown,
    _context: unknown,
    { passed, error }: { passed: boolean; error?: Error },
  ) {
    if (!passed) {
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
