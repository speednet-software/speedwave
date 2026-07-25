/**
 * Service List - Dynamic service enumeration.
 * Parses ENABLED_SERVICES env var; zero hub-module imports.
 */

/**
 * Get explicitly enabled service names from ENABLED_SERVICES env var.
 * @returns Array of enabled service names
 */
export function getAllServiceNames(): string[] {
  const envVal = process.env.ENABLED_SERVICES;
  if (!envVal) return [];
  return envVal
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Camel-cases dashes out of a service name: a dashed slug (`my-plugin`) is an invalid
 * AsyncFunction parameter and breaks the sandbox. Caller (`executor.ts`) validates the result.
 * @param service - Service name as it appears in ENABLED_SERVICES
 * @returns The service name with dashes removed and following chars upper-cased
 */
export function sandboxGlobalName(service: string): string {
  return service.replace(/-+([a-zA-Z0-9])?/g, (_, c: string | undefined) =>
    c ? c.toUpperCase() : ''
  );
}

/**
 * Legal parameter names that still break the sandbox when shadowed: value globals (a service
 * named `undefined` silently makes every `x === undefined` false) and contextual keywords.
 */
const UNSAFE_SANDBOX_GLOBALS: ReadonlySet<string> = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'let',
  'of',
  'yield',
  'arguments',
  'eval',
]);

const AsyncFunction: new (...args: string[]) => unknown = Object.getPrototypeOf(
  async function () {}
).constructor;

/**
 * True when `name` works as an AsyncFunction parameter; reserved words throw at construction.
 * @param name - Candidate sandbox global name
 */
function isUsableIdentifier(name: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  try {
    new AsyncFunction(name, '');
    return true;
  } catch {
    return false;
  }
}

/** Outcome of {@link resolveSandboxGlobals}: injectable services and why the rest were dropped. */
export interface SandboxGlobalResolution {
  /** Service name → sandbox global, for services the sandbox can safely expose. */
  usable: Map<string, string>;
  /** Service name → reason it is not exposed. */
  skipped: Map<string, string>;
}

/**
 * Map services to sandbox globals, dropping unusable names and collisions. A service whose own
 * name is already the global wins the tie, so a `redmine-` plugin cannot shadow built-in `redmine`.
 * @param services - Enabled service names
 * @param reserved - Global names the sandbox itself injects (helpers, console)
 */
export function resolveSandboxGlobals(
  services: readonly string[],
  reserved: ReadonlySet<string>
): SandboxGlobalResolution {
  const usable = new Map<string, string>();
  const skipped = new Map<string, string>();
  const byGlobal = new Map<string, string[]>();

  for (const service of services) {
    const global = sandboxGlobalName(service);
    if (!isUsableIdentifier(global)) {
      skipped.set(service, `maps to invalid sandbox global '${global}' (reserved word or empty)`);
    } else if (reserved.has(global) || UNSAFE_SANDBOX_GLOBALS.has(global)) {
      skipped.set(service, `sandbox global '${global}' is a built-in or unsafe JS global`);
    } else {
      byGlobal.set(global, [...(byGlobal.get(global) ?? []), service]);
    }
  }

  for (const [global, owners] of byGlobal) {
    const winner = owners.length === 1 ? owners[0] : owners.find((s) => s === global);
    for (const owner of owners) {
      if (owner === winner) {
        usable.set(owner, global);
      } else {
        const others = owners.filter((o) => o !== owner).join(', ');
        skipped.set(owner, `sandbox global '${global}' collides with ${others}`);
      }
    }
  }

  return { usable, skipped };
}
