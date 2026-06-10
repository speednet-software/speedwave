/**
 * Child-process environment for `host_exec` recipes — a strict allowlist, never
 * the worker's own `process.env` (which carries `HOST_EXEC_AUTH_TOKEN`,
 * `HOST_EXEC_CONFIG_PATH`, `PORT` — none of which must reach `build.gradle` /
 * `node_modules` / etc.). This is the `SAFE_ENV_KEYS` + `buildChildEnv` pattern
 * from `mcp-servers/os/src/platform-runner.ts`, extended for build tooling
 * (`JAVA_HOME`, `DOCKER_HOST`, …), plus the recipe's own `env` map
 * (validated Rust-side: no key in `RESERVED_ENV_KEYS`). See ADR-054.
 * @module host_exec/env
 */

import { BASE_SAFE_ENV_KEYS } from '@speedwave/mcp-shared';

/**
 * Environment variable names safe to pass through from the worker's environment
 * to a recipe child. Anything not on this list — and explicitly any
 * `HOST_EXEC_*` — is dropped. `PATH` here is the *recovered login-shell PATH*
 * the Tauri side passed to the worker (a GUI-launched Desktop app's bare PATH
 * lacks `/opt/homebrew/bin` etc.).
 *
 * Built from the shared 14-key core ({@link BASE_SAFE_ENV_KEYS}) plus the extra
 * keys build tooling needs (TERM, Windows locators, JVM/Go/Rust/Docker).
 */
export const SAFE_ENV_KEYS: readonly string[] = [
  ...BASE_SAFE_ENV_KEYS,
  // Terminal (some tools format differently with no TERM; harmless to pass)
  'TERM',
  // Windows
  'USERPROFILE',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PATHEXT',
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // Build toolchains — pure locators (point at an install dir or cache; not
  // code-injection vectors).
  'JAVA_HOME',
  'GRADLE_USER_HOME',
  'M2_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  // JVM-launcher modifiers — can carry `-javaagent:` (arbitrary Java code into
  // the build JVM). Trust level = user's login shell, same as the rest.
  'MAVEN_OPTS',
  'GRADLE_OPTS',
  // The host's Docker — a `docker` recipe needs this to find the daemon when
  // it's not the default socket (Colima/OrbStack/etc.). Not on RESERVED_ENV_KEYS.
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'COLIMA_HOME',
];

/**
 * Build the environment object for a recipe child process: the allowlisted
 * subset of the worker's environment, then the recipe's own `env` overrides on
 * top. `HOST_EXEC_*` keys are never included (they are not on `SAFE_ENV_KEYS`,
 * and this asserts it defensively).
 * @param recipeEnv - The recipe's `env` map (already validated Rust-side), or undefined.
 * @returns The child process environment.
 */
export function buildRecipeEnv(recipeEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    // `SAFE_ENV_KEYS` is a fixed const with no `HOST_EXEC_*` entry (asserted by
    // a unit test), so the allowlist alone keeps the worker's auth token /
    // config path / port out of recipe children.
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (recipeEnv) {
    for (const [k, v] of Object.entries(recipeEnv)) {
      // Defence-in-depth: catch any future `HOST_EXEC_*` even if the Rust
      // RESERVED_ENV_KEYS list misses it.
      if (k.toUpperCase().startsWith('HOST_EXEC_')) continue;
      env[k] = v;
    }
  }
  return env;
}
