/** Direct host-fs access to a project's pin files (SPEED-545 teardown only) — no product
 * "clear pin" command exists, so cleanup pokes the files directly, `engine.ts`-style. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Resolves SPEEDWAVE_DATA_DIR the way the runtime does, default `~/.speedwave`
 *  (mirrors `engine.ts`'s private `dataDir()` — kept separate since both are
 *  thin one-liners and neither module imports from the other). */
function dataDir(): string {
  return process.env.SPEEDWAVE_DATA_DIR || path.join(os.homedir(), '.speedwave');
}

function settingsJsonPath(project: string): string {
  return path.join(dataDir(), 'claude-home', project, '.claude', 'settings.json');
}

function configJsonPath(): string {
  return path.join(dataDir(), 'config.json');
}

/** Removes the `model` key from a project's claude-home `settings.json`, if present. */
export function clearModelPinFile(project: string): void {
  const settingsPath = settingsJsonPath(project);
  if (!fs.existsSync(settingsPath)) return;
  const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  if (!('model' in raw)) return;
  delete raw['model'];
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
}

/** Removes `effort_pin` from a project's entry in `config.json`, if present. */
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
