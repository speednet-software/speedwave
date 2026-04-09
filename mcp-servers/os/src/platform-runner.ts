/**
 * Platform Runner — Cross-platform CLI binary dispatcher
 *
 * Detects the current platform and resolves the correct native CLI binary
 * for OS integrations (Reminders, Calendar, Mail, Notes).
 *
 * Platforms:
 * - macOS: 4 Swift binaries (reminders-cli, calendar-cli, mail-cli, notes-cli)
 * - Linux/Windows: 1 Rust binary (native-os-cli) with domain.command syntax
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

import { ALLOWED_COMMANDS } from './tools/index.js';

const execFileAsync = promisify(execFileCb);

//=============================================================================
// Types
//=============================================================================

/** OS domain identifier for native CLI routing. */
export type OsDomain = 'reminders' | 'calendar' | 'mail' | 'notes';

/** Result of running a native CLI command. */
export interface RunResult {
  /** Raw stdout output from the CLI binary. */
  stdout: string;
  /** Parsed JSON output. */
  parsed: unknown;
}

/** Resolved filesystem paths to native CLI binaries for each OS domain. */
export interface PlatformPaths {
  /** Path to the reminders CLI binary. */
  reminders: string;
  /** Path to the calendar CLI binary. */
  calendar: string;
  /** Path to the mail CLI binary. */
  mail: string;
  /** Path to the notes CLI binary. */
  notes: string;
}

//=============================================================================
// Binary Resolution
//=============================================================================

/**
 * Detect whether we are running in dev mode or production (bundled).
 * Dev: binaries are in native/macos/<pkg>/.build/release/ or target/release/
 * Prod: binaries are alongside the app (Resources/ on macOS)
 */
function isDevMode(): boolean {
  // In production, __dirname would be inside .app bundle or dist/
  // In dev, we run from mcp-servers/os/dist/ or src/
  return !process.env.SPEEDWAVE_PROD;
}

/**
 * Resolve the project root directory.
 * In dev mode, this is the monorepo root (parent of mcp-servers/).
 */
function resolveProjectRoot(): string {
  // platform-runner.ts lives at mcp-servers/os/src/ (dev) or mcp-servers/os/dist/ (built)
  // Project root is 3 levels up from src/ or dist/
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

/**
 * Resolve native CLI binary paths for macOS (Swift binaries).
 * SYNC: binary paths must match desktop/src-tauri/src/integrations_cmd.rs::resolve_native_cli_binary()
 */
function resolveDarwinPaths(): PlatformPaths {
  if (isDevMode()) {
    const root = resolveProjectRoot();
    return {
      reminders: path.join(
        root,
        'native',
        'macos',
        'reminders',
        '.build',
        'release',
        'reminders-cli'
      ),
      calendar: path.join(root, 'native', 'macos', 'calendar', '.build', 'release', 'calendar-cli'),
      mail: path.join(root, 'native', 'macos', 'mail', '.build', 'release', 'mail-cli'),
      notes: path.join(root, 'native', 'macos', 'notes', '.build', 'release', 'notes-cli'),
    };
  }

  // Production: binaries bundled in Resources/ alongside the app
  const resourcesDir =
    process.env.SPEEDWAVE_RESOURCES_DIR || path.join(import.meta.dirname, '..', 'Resources');
  return {
    reminders: path.join(resourcesDir, 'reminders-cli'),
    calendar: path.join(resourcesDir, 'calendar-cli'),
    mail: path.join(resourcesDir, 'mail-cli'),
    notes: path.join(resourcesDir, 'notes-cli'),
  };
}

/**
 * Resolve native CLI binary path for Linux/Windows (single Rust binary).
 */
function resolveNativePaths(): PlatformPaths {
  const ext = process.platform === 'win32' ? '.exe' : '';

  if (isDevMode()) {
    const root = resolveProjectRoot();
    const bin = path.join(root, 'target', 'release', `native-os-cli${ext}`);
    return { reminders: bin, calendar: bin, mail: bin, notes: bin };
  }

  const resourcesDir =
    process.env.SPEEDWAVE_RESOURCES_DIR || path.join(import.meta.dirname, '..', 'Resources');
  const bin = path.join(resourcesDir, `native-os-cli${ext}`);
  return { reminders: bin, calendar: bin, mail: bin, notes: bin };
}

/**
 * Resolve platform-specific binary paths.
 */
export function resolvePaths(): PlatformPaths {
  if (process.platform === 'darwin') {
    return resolveDarwinPaths();
  }
  return resolveNativePaths();
}

//=============================================================================
// Execution
//=============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Allowlist of environment variable names safe to pass to CLI child processes.
 * Prevents leaking secrets (MCP_OS_AUTH_TOKEN, API keys, etc.) to subprocesses.
 */
export const SAFE_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  // macOS: required by Swift runtime / Xcode toolchain
  'DEVELOPER_DIR',
  'SDKROOT',
  '__CF_USER_TEXT_ENCODING',
  // Linux: XDG dirs for D-Bus / CalDAV discovery
  'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
];

/** Build a filtered environment object containing only safe keys. */
export function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/**
 * Run a native CLI command and parse JSON output.
 * @param domain - OS domain (reminders, calendar, mail, notes)
 * @param command - Command name (e.g., list_reminders, create_event)
 * @param args - JSON-serializable arguments
 * @param timeoutMs - Execution timeout in milliseconds
 */
export async function runCommand(
  domain: OsDomain,
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<RunResult> {
  const allowed = ALLOWED_COMMANDS[domain];
  if (!allowed || !allowed.has(command)) {
    throw new Error('Unknown command.');
  }

  const paths = resolvePaths();
  const binaryPath = paths[domain];

  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Native CLI binary not found: ${binaryPath}. ` +
        `Run 'make build-os-cli' to build the ${process.platform === 'darwin' ? 'Swift' : 'Rust'} CLI binaries.`
    );
  }

  // macOS: separate binaries with <command> [json-args]
  // Linux/Windows: single binary with <domain>.<command> [json-args]
  const execArgs: string[] =
    process.platform === 'darwin'
      ? [command, JSON.stringify(args)]
      : [`${domain}.${command}`, JSON.stringify(args)];

  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, execArgs, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: buildChildEnv(),
    });

    if (stderr && stderr.trim()) {
      console.warn(`[mcp-os] ${domain}.${command} stderr: ${stderr.trim()}`);
    }

    const parsed = JSON.parse(stdout);
    return { stdout, parsed };
  } catch (error: unknown) {
    const err = error as { killed?: boolean; code?: string; stderr?: string; message?: string };

    if (err.killed) {
      throw new Error(
        `${domain}.${command} timed out after ${timeoutMs}ms. ` +
          'This may happen on first run when macOS permission dialogs appear.',
        { cause: error }
      );
    }

    if (err.stderr) {
      throw new Error(`${domain}.${command} failed: ${err.stderr.trim()}`, { cause: error });
    }

    throw new Error(`${domain}.${command} failed: ${err.message || String(error)}`, {
      cause: error,
    });
  }
}
