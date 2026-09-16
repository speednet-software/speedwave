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
  if (!fs.existsSync(settingsPath)) return;
  const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  if (!('model' in raw)) return;
  delete raw['model'];
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
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
