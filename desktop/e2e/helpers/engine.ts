/**
 * Rig-side access to the bundled container engine (nerdctl) for dirty-state
 * self-heal specs — bundled limactl shell on macOS, `wsl.exe` on Windows.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Same sentinel content the P2 bats suite (`engine-contract.bats`) plants. */
export const DEAD_ID = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** nerdctl name-store dir; hash pinned by `consts::tests::nerdctl_addr_hash_matches_default_socket_digest`. */
export function nameStoreDir(): string {
  return '/var/lib/nerdctl/1935db59/names/default';
}

/** Mirrors `consts::compose_prefix()`: data-dir basename, leading dots stripped. */
export function composePrefix(): string {
  const dataDir = process.env.SPEEDWAVE_DATA_DIR || join(homedir(), '.speedwave');
  const basename =
    dataDir
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || '';
  return basename.replace(/^\.+/, '');
}

/**
 * Runs argv as root inside the engine namespace and returns trimmed UTF-8 stdout.
 * darwin: bundled limactl `shell speedwave -- sudo <argv>`; win32: `wsl.exe -d Speedwave -u root --`.
 */
export function engineExec(argv: string[]): string {
  if (process.platform === 'darwin') {
    const limactl = '/Applications/Speedwave.app/Contents/Resources/lima/bin/limactl';
    const env = { ...process.env, LIMA_HOME: join(homedir(), '.speedwave', 'lima') };
    return execFileSync(limactl, ['shell', 'speedwave', '--', 'sudo', ...argv], {
      env,
      encoding: 'utf8',
    }).trim();
  }
  if (process.platform === 'win32') {
    const env = { ...process.env, WSL_UTF8: '1' };
    return execFileSync('wsl.exe', ['-d', 'Speedwave', '-u', 'root', '--', ...argv], {
      env,
      encoding: 'utf8',
    }).trim();
  }
  throw new Error(`engineExec: unsupported platform '${process.platform}'`);
}

/** Reads the name-store dir into filename → 64-hex content. */
export function storeSnapshot(): Map<string, string> {
  const dir = nameStoreDir();
  const names = readdirSync(dir);
  const snapshot = new Map<string, string>();
  for (const name of names) {
    const content = readFileSync(join(dir, name), 'utf8').trim();
    snapshot.set(name, content);
  }
  return snapshot;
}

function inspectSucceeds(id: string): boolean {
  try {
    engineExec(['nerdctl', 'inspect', id]);
    return true;
  } catch {
    return false;
  }
}

/** Removes the live container and leaves a dead reservation behind it (0600). */
export function plantGhost(containerName: string): void {
  engineExec(['nerdctl', 'rm', '-f', containerName]);
  const path = join(nameStoreDir(), containerName);
  writeFileSync(path, DEAD_ID, 'utf8');
  chmodSync(path, 0o600);
}

/**
 * Every ghost name must be gone, or its current content must have been
 * re-acquired by a live container (differs from DEAD_ID and inspects clean).
 */
export function assertStoreHealed(ghosts: string[]): void {
  const after = storeSnapshot();
  for (const name of ghosts) {
    const content = after.get(name);
    if (content === undefined) continue;
    if (content === DEAD_ID) {
      throw new Error(`assertStoreHealed: '${name}' still holds the dead reservation ${DEAD_ID}`);
    }
    if (!inspectSucceeds(content)) {
      throw new Error(
        `assertStoreHealed: '${name}' now points at '${content}', but 'nerdctl inspect ${content}' failed`
      );
    }
  }
}

/**
 * Every non-ghost entry captured in `before` must still be present and must
 * still resolve to a live container (before-id or a current re-acquired id).
 */
export function assertLiveEntriesIntact(before: Map<string, string>, ghosts: string[]): void {
  const after = storeSnapshot();
  const ghostSet = new Set(ghosts);
  for (const [name, beforeId] of before) {
    if (ghostSet.has(name)) continue;
    const currentId = after.get(name);
    if (currentId === undefined) {
      throw new Error(`assertLiveEntriesIntact: '${name}' disappeared from the name store`);
    }
    if (!inspectSucceeds(currentId)) {
      throw new Error(
        `assertLiveEntriesIntact: '${name}' -> '${currentId}' does not inspect; expected id ` +
          `'${beforeId}' to still be live`
      );
    }
  }
}
