import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function dataDir(): string {
  return process.env.SPEEDWAVE_DATA_DIR || path.join(os.homedir(), '.speedwave');
}

function settingsJsonPath(project: string): string {
  return path.join(dataDir(), 'claude-home', project, '.claude', 'settings.json');
}

function configJsonPath(): string {
  return path.join(dataDir(), 'config.json');
}

export function clearModelPinFile(project: string): void {
  const settingsPath = settingsJsonPath(project);
  if (fs.existsSync(settingsPath)) {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    if ('model' in raw) {
      delete raw['model'];
      fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
    }
  }
  const configPath = configJsonPath();
  if (!fs.existsSync(configPath)) return;
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    projects?: Array<{ name: string; model_pin?: string | null }>;
  };
  const entry = cfg.projects?.find((proj) => proj.name === project);
  if (!entry || !('model_pin' in entry)) return;
  delete entry.model_pin;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

/** Reads the project's config `model_pin` (the default model for new tabs), or null. */
export function readModelPin(project: string): string | null {
  const configPath = configJsonPath();
  if (!fs.existsSync(configPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    projects?: Array<{ name: string; model_pin?: string | null }>;
  };
  return cfg.projects?.find((proj) => proj.name === project)?.model_pin ?? null;
}

export function clearEffortPinFile(project: string): void {
  const configPath = configJsonPath();
  if (!fs.existsSync(configPath)) return;
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    projects?: Array<{ name: string; effort_pin?: string | null }>;
  };
  const entry = cfg.projects?.find((proj) => proj.name === project);
  if (!entry || !('effort_pin' in entry)) return;
  delete entry.effort_pin;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

interface UserConfigWithUiPrefs {
  ui?: { beta_enabled?: boolean };
  [key: string]: unknown;
}

function readUserConfig(): UserConfigWithUiPrefs {
  const configPath = configJsonPath();
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as UserConfigWithUiPrefs;
}

/** Reads the persisted `ui.beta_enabled` flag, defaulting to `false` like the backend getter. */
export function readBetaEnabled(): boolean {
  return readUserConfig().ui?.beta_enabled ?? false;
}

/**
 * Writes `ui.beta_enabled` directly to `config.json`, the same file the Tauri
 * `get_beta_enabled`/`apply_beta_toggle_inner` pair reads and writes. A direct
 * file edit is not picked up by an already-running app (the frontend only
 * refetches on the `beta-changed` event) — pair this with
 * `restartAppAndReconnect()` from `app-restart.ts` so the fresh boot re-reads it.
 */
export function setBetaEnabled(enabled: boolean): void {
  const cfg = readUserConfig();
  cfg.ui = { ...cfg.ui, beta_enabled: enabled };
  fs.writeFileSync(configJsonPath(), JSON.stringify(cfg, null, 2));
}
