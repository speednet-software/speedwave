/**
 * Path mapping between the container's `/workspace` and a host project directory, for MCP servers that run on the host: rewrites arguments, refuses container-only paths, hides the host directory in results.
 * @module shared/workspace-paths
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { teachingErrorResult } from './teaching-errors.js';

/** Host path flavour of the project directory. */
export type PathStyle = 'posix' | 'windows' | 'unc';

/** How a string argument is treated. */
export type PathClass =
  | 'ok-workspace'
  | 'refuse-tmp'
  | 'refuse-home'
  | 'refuse-relative'
  | 'refuse-escape'
  | 'refuse-outside-workspace'
  | 'passthrough';

/** Options for {@link createWorkspacePathMapper}. */
export interface WorkspacePathMapperOptions {
  /** Raw project directory on the host (`/Users/a/proj`, `C:\Users\a\proj`, `\\wsl.localhost\Ubuntu\home\a\proj`). */
  hostDir: string;
  /** Path flavour of `hostDir`. */
  style: PathStyle;
}

/** Outcome of {@link WorkspacePathMapper.rewriteArgs}. */
export type RewriteArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | {
      ok: false;
      error: ReturnType<typeof teachingErrorResult>;
      param: string;
      reason: Exclude<PathClass, 'ok-workspace' | 'passthrough'>;
    };

/** Bidirectional `/workspace` ↔ host directory mapper. */
export interface WorkspacePathMapper {
  /** Host path for a `/workspace` path, or null when the value is not a path inside `/workspace`. */
  toHostPath(workspacePath: string): string | null;
  /** `/workspace` path for a host path inside the project directory, or null. */
  toWorkspacePath(hostPath: string): string | null;
  /** Classify one string argument; relative and absolute non-`/workspace` values are refused only when `pathLike`. */
  classify(value: string, pathLike?: boolean): PathClass;
  /** Rewrite every `/workspace` string leaf of the arguments to the host directory, or refuse the call. */
  rewriteArgs(args: Record<string, unknown>, inputSchema?: unknown): RewriteArgsResult;
  /** Replace the host directory with `/workspace` in every string leaf of a result. */
  rewriteResult<T>(result: T): T;
}

/** The project mount point inside containers. */
export const WORKSPACE_ROOT = '/workspace';

/** Home directory of the Claude container user. */
export const CONTAINER_HOME = '/home/speedwave';

const MAX_DEPTH = 64;
const SEPARATOR_PATTERN = '(?:\\\\\\\\|\\\\|/)';
const UNC_SERVER_PATTERN = '(?:wsl\\.localhost|wsl\\$)';
const LEADING_BOUNDARY = '(?<![\\p{L}\\p{N}_.~+@\\-\\\\/])';
const TRAILING_BOUNDARY = '(?![\\p{L}\\p{N}_~+@\\-]|\\.[\\p{L}\\p{N}_~+@.\\-])';
const PATH_LIKE_CAMEL_RE = /[a-z0-9](?:Path|File|Dir|Folder)s?$/;
const PATH_LIKE_PLAIN_RE = /(?:^|[_\-.])(?:path|file|dir|folder)s?$/i;
const PATH_FORMATS: ReadonlySet<string> = new Set(['path', 'uri']);

const REFUSAL_STEPS: Record<Exclude<PathClass, 'ok-workspace' | 'passthrough'>, string> = {
  'refuse-tmp':
    'Paths under /tmp exist only inside the Claude container and this server runs on the host, so it cannot see them. Save the file under /workspace and pass that path.',
  'refuse-home':
    'Paths under /home/speedwave or ~ exist only inside the Claude container and this server runs on the host, so it cannot see them. Use a path under /workspace.',
  'refuse-relative':
    'This server runs on the host and cannot resolve relative paths. Pass an absolute path under /workspace, for example /workspace/src/index.ts.',
  'refuse-escape':
    'The path leaves /workspace once ".." segments are resolved. Pass a path inside /workspace.',
  'refuse-outside-workspace':
    'This server runs on the host and may only receive paths inside the project, which the container sees as /workspace. Pass a path under /workspace, for example /workspace/src/index.ts.',
};

/** Thrown inside the argument walk to stop at the first refused value. */
class PathRefusal extends Error {
  /**
   * Record which parameter was refused and why.
   * @param param - Dotted parameter path (e.g. `files[0]`).
   * @param reason - Refusal class.
   */
  constructor(
    readonly param: string,
    readonly reason: Exclude<PathClass, 'ok-workspace' | 'passthrough'>
  ) {
    super(reason);
  }
}

/**
 * Escape a string for use inside a Unicode-mode regular expression.
 * @param text - Literal text.
 */
function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * Whether a value is a non-null, non-array object.
 * @param value - Value to test.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a property is path-like: schema `format` `path`/`uri`, or a name ending in path/file/dir/folder at a word boundary.
 * @param name - Property name.
 * @param schema - Property schema, if any.
 */
export function isPathLikeProperty(name: string, schema?: unknown): boolean {
  if (isRecord(schema) && typeof schema.format === 'string' && PATH_FORMATS.has(schema.format)) {
    return true;
  }
  return PATH_LIKE_PLAIN_RE.test(name) || PATH_LIKE_CAMEL_RE.test(name);
}

/**
 * Validate and normalize the host directory into its segments (drive or UNC server/share included).
 * @param hostDir - Raw host directory.
 * @param style - Path flavour.
 */
function hostSegments(hostDir: string, style: PathStyle): string[] {
  if (style === 'posix') {
    if (!hostDir.startsWith('/')) throw new Error('posix hostDir must be absolute');
    const segments = hostDir.split('/').filter((s) => s !== '');
    if (segments.length === 0) throw new Error('hostDir must not be the filesystem root');
    return segments;
  }
  if (style === 'windows') {
    if (!/^[A-Za-z]:[\\/]/.test(hostDir))
      throw new Error('windows hostDir must start with a drive');
    const segments = hostDir.split(/[\\/]/).filter((s) => s !== '');
    if (segments.length < 2) throw new Error('hostDir must not be a drive root');
    return segments;
  }
  if (!/^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(hostDir)) {
    throw new Error('unc hostDir must start with \\\\wsl.localhost\\ or \\\\wsl$\\');
  }
  const segments = hostDir.split(/[\\/]/).filter((s) => s !== '');
  if (segments.length < 3)
    throw new Error('hostDir must name a directory inside a WSL distribution');
  return segments;
}

/**
 * Resolve `.` and `..` segments from the root; null when `..` climbs above it or a Windows-ambiguous dot segment appears.
 * @param path - Absolute POSIX-style path.
 * @param windowsSeparators - Whether `\` also separates segments (host is Windows).
 */
function resolveSegments(path: string, windowsSeparators: boolean): string[] | null {
  const resolved: string[] = [];
  for (const segment of path.split(windowsSeparators ? /[\\/]/ : '/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    if (windowsSeparators && /^[. ]+$/.test(segment)) return null;
    resolved.push(segment);
  }
  return resolved;
}

/**
 * Whether a resolved path equals or lies under the given root segments.
 * @param segments - Resolved path segments.
 * @param root - Root segments.
 */
function isUnder(segments: readonly string[], root: readonly string[]): boolean {
  return root.every((part, i) => segments[i] === part);
}

/**
 * Whether a string starts with a literal absolute prefix at a segment boundary.
 * @param value - Candidate path.
 * @param prefix - Absolute prefix without trailing slash.
 */
function hasPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}

/**
 * Whether a value looks like a relative filesystem path (not absolute, not a URL, not empty).
 * @param value - Candidate value.
 */
function looksRelative(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/**
 * Create a mapper for one project directory.
 * @param options - Host directory and its path flavour.
 */
export function createWorkspacePathMapper(
  options: WorkspacePathMapperOptions
): WorkspacePathMapper {
  const { style } = options;
  const windowsHost = style !== 'posix';
  const hostParts = hostSegments(options.hostDir, style);
  const hostRoot =
    style === 'posix'
      ? `/${hostParts.join('/')}`
      : style === 'windows'
        ? hostParts.join('\\')
        : `\\\\${hostParts.join('\\')}`;
  const workspaceParts = WORKSPACE_ROOT.split('/').filter((s) => s !== '');
  const tmpParts = ['tmp'];
  const homeParts = CONTAINER_HOME.split('/').filter((s) => s !== '');

  const segmentPatterns = hostParts.map((part, i) =>
    style === 'unc' && i === 0 ? UNC_SERVER_PATTERN : escapeRegex(part)
  );
  const separator = style === 'posix' ? '/' : SEPARATOR_PATTERN;
  const lead = style === 'posix' ? '/' : style === 'unc' ? `${SEPARATOR_PATTERN}{2}` : '';
  const plainPattern = `${lead}${segmentPatterns.join(separator)}`;
  const encodedHref = pathToFileURL(hostRoot, { windows: windowsHost }).href;
  const filePrefix = style === 'posix' ? 'file://' : style === 'windows' ? 'file:///' : 'file:';
  const encodedPattern = `file:\\/\\/${encodedHref
    .slice('file://'.length)
    .split('/')
    .map((part, i) => (style === 'unc' && i === 0 ? UNC_SERVER_PATTERN : escapeRegex(part)))
    .join('\\/')}`;
  const flags = windowsHost ? 'giu' : 'gu';
  const fileRe = new RegExp(
    `(?:${escapeRegex(filePrefix)}${plainPattern}|${encodedPattern})${TRAILING_BOUNDARY}`,
    flags
  );
  const pathRe = new RegExp(`${LEADING_BOUNDARY}${plainPattern}${TRAILING_BOUNDARY}`, flags);
  const anchoredRe = new RegExp(`^${plainPattern}(?=$|${separator})`, windowsHost ? 'iu' : 'u');

  function classifyAbsolute(path: string, workspacePrefixed: boolean): PathClass {
    const resolved = resolveSegments(path, windowsHost);
    if (workspacePrefixed) {
      return resolved !== null && isUnder(resolved, workspaceParts)
        ? 'ok-workspace'
        : 'refuse-escape';
    }
    if (hasPrefix(path, '/tmp')) return 'refuse-tmp';
    if (hasPrefix(path, CONTAINER_HOME)) return 'refuse-home';
    if (
      resolved !== null &&
      (isUnder(resolved, workspaceParts) ||
        isUnder(resolved, tmpParts) ||
        isUnder(resolved, homeParts))
    ) {
      return 'refuse-escape';
    }
    return 'passthrough';
  }

  function fileUrlPath(value: string): { path: string | null; workspacePrefixed: boolean } {
    const workspacePrefixed = /^file:\/*workspace(?:\/|$)/.test(value);
    try {
      return { path: fileURLToPath(value, { windows: false }), workspacePrefixed };
    } catch {
      return { path: null, workspacePrefixed };
    }
  }

  function confine(verdict: PathClass, pathLike: boolean): PathClass {
    return pathLike && verdict === 'passthrough' ? 'refuse-outside-workspace' : verdict;
  }

  function classify(value: string, pathLike = false): PathClass {
    if (/^file:/i.test(value)) {
      const { path, workspacePrefixed } = fileUrlPath(value);
      if (path === null)
        return workspacePrefixed ? 'refuse-escape' : confine('passthrough', pathLike);
      return confine(classifyAbsolute(path, workspacePrefixed), pathLike);
    }
    if (value.startsWith('/')) {
      return confine(classifyAbsolute(value, hasPrefix(value, WORKSPACE_ROOT)), pathLike);
    }
    if (pathLike && value.startsWith('~')) return 'refuse-home';
    if (pathLike && (value.startsWith('\\') || /^[A-Za-z]:/.test(value))) {
      return 'refuse-outside-workspace';
    }
    if (pathLike && looksRelative(value)) return 'refuse-relative';
    return 'passthrough';
  }

  function hostPathOf(workspacePath: string): string {
    const resolved = resolveSegments(workspacePath, windowsHost) as string[];
    const rest = resolved.slice(workspaceParts.length);
    if (rest.length === 0) return hostRoot;
    return style === 'posix' ? `${hostRoot}/${rest.join('/')}` : `${hostRoot}\\${rest.join('\\')}`;
  }

  function toHostPath(workspacePath: string): string | null {
    if (classify(workspacePath) !== 'ok-workspace' || /^file:/i.test(workspacePath)) return null;
    return hostPathOf(workspacePath);
  }

  function rewriteString(value: string, pathLike: boolean, param: string): string {
    const verdict = classify(value, pathLike);
    if (verdict === 'passthrough') return value;
    if (verdict !== 'ok-workspace') throw new PathRefusal(param, verdict);
    if (!/^file:/i.test(value)) return hostPathOf(value);
    const hostPath = hostPathOf(fileUrlPath(value).path as string);
    return pathToFileURL(hostPath, { windows: windowsHost }).href;
  }

  function walkArgs(
    value: unknown,
    schema: unknown,
    name: string,
    param: string,
    depth: number
  ): unknown {
    if (depth > MAX_DEPTH) return value;
    if (typeof value === 'string')
      return rewriteString(value, isPathLikeProperty(name, schema), param);
    if (Array.isArray(value)) {
      const items = isRecord(schema) ? schema.items : undefined;
      return value.map((item, i) => walkArgs(item, items, name, `${param}[${i}]`, depth + 1));
    }
    if (!isRecord(value)) return value;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = Object.hasOwn(properties, key) ? properties[key] : undefined;
      const childParam = param === '' ? key : `${param}.${key}`;
      Object.defineProperty(out, key, {
        value: walkArgs(value[key], child, key, childParam, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  function rewriteText(text: string): string {
    return text.replace(fileRe, 'file:///workspace').replace(pathRe, WORKSPACE_ROOT);
  }

  function walkResult(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return value;
    if (typeof value === 'string') return rewriteText(value);
    if (Array.isArray(value)) return value.map((item) => walkResult(item, depth + 1));
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: walkResult(value[key], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  return {
    toHostPath,

    toWorkspacePath(hostPath) {
      const match = anchoredRe.exec(hostPath);
      if (!match) return null;
      const rest = hostPath
        .slice(match[0].length)
        .split(windowsHost ? /[\\/]/ : '/')
        .filter((s) => s !== '');
      return rest.length === 0 ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${rest.join('/')}`;
    },

    classify,

    rewriteArgs(args, inputSchema) {
      try {
        return {
          ok: true,
          args: walkArgs(args, inputSchema, '', '', 0) as Record<string, unknown>,
        };
      } catch (error) {
        if (!(error instanceof PathRefusal)) throw error;
        return {
          ok: false,
          param: error.param,
          reason: error.reason,
          error: teachingErrorResult({
            paramName: error.param,
            nextStep: REFUSAL_STEPS[error.reason],
          }),
        };
      }
    },

    rewriteResult<T>(result: T): T {
      return walkResult(result, 0) as T;
    },
  };
}
