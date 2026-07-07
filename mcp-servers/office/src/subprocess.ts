/**
 * Hardened `spawn` wrapper for the external tools the worker drives
 * (`markitdown`, `pdftotext`, `pandoc`, `weasyprint`, `soffice`, and the bundled
 * Python support-scripts). Adds wall-time timeout (SIGKILL), bounded stdout/stderr
 * capture, and a typed result; never runs anything through a shell.
 * @module mcp-office/subprocess
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  TIMEOUT_STANDARD_MS,
  MAX_SUBPROCESS_OUTPUT_BYTES,
  PYTHON_BIN,
  SCRIPTS_DIR,
} from './config.js';

/** Outcome of a subprocess run. `timedOut` is set when the process was killed for exceeding the timeout. */
export interface RunResult {
  /** Process exit code (null if the process was killed by a signal, e.g. on timeout). */
  code: number | null;
  /** Captured stdout (truncated to `MAX_SUBPROCESS_OUTPUT_BYTES`; `stdoutTruncated` indicates truncation). */
  stdout: string;
  /** Captured stderr (truncated to `MAX_SUBPROCESS_OUTPUT_BYTES`; `stderrTruncated` indicates truncation). */
  stderr: string;
  /** Whether stdout was truncated at the cap. */
  stdoutTruncated: boolean;
  /** Whether stderr was truncated at the cap. */
  stderrTruncated: boolean;
  /** Whether the process was killed for exceeding the wall-time timeout. */
  timedOut: boolean;
}

/** Thrown when a subprocess fails (non-zero exit, timeout, or spawn error). Carries the captured output for diagnostics. */
export class SubprocessError extends Error {
  /**
   * Construct a subprocess failure.
   * @param message - Human-readable failure summary.
   * @param result - The (partial) run result, when available.
   */
  constructor(
    message: string,
    public readonly result?: RunResult
  ) {
    super(message);
    this.name = 'SubprocessError';
  }
}

/** Options for {@link run}. */
export interface RunOptions {
  /** Wall-time limit in ms (default `TIMEOUT_STANDARD_MS`). On expiry the process is SIGKILLed and `timedOut` is set. */
  timeoutMs?: number;
  /** Working directory for the child (default: inherited). */
  cwd?: string;
  /** Extra environment entries merged over `process.env`. */
  env?: Record<string, string>;
  /** String to write to the child's stdin, then close it. */
  input?: string;
}

/**
 * Run `command` with `args`, capturing bounded stdout/stderr and enforcing a wall-time timeout. Never uses a shell.
 * @param command - Executable to run (resolved via PATH or an absolute path).
 * @param args - Argument vector (each element passed verbatim — no shell parsing).
 * @param opts - Run options (timeout, cwd, env, stdin input).
 * @returns The {@link RunResult} (does not throw on non-zero exit — inspect `code`).
 */
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_STANDARD_MS;
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    let settled = false;

    // Append `chunk` to `chunks` up to MAX_SUBPROCESS_OUTPUT_BYTES; returns [newLen, truncated].
    const collect = (chunks: Buffer[], len: number, chunk: Buffer): [number, boolean] => {
      if (len >= MAX_SUBPROCESS_OUTPUT_BYTES) {
        return [len, true];
      }
      const remaining = MAX_SUBPROCESS_OUTPUT_BYTES - len;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        return [len + chunk.length, false];
      }
      chunks.push(chunk.subarray(0, remaining));
      return [MAX_SUBPROCESS_OUTPUT_BYTES, true];
    };

    child.stdout.on('data', (c: Buffer) => {
      [outLen, outTrunc] = collect(outChunks, outLen, c);
    });
    child.stderr.on('data', (c: Buffer) => {
      [errLen, errTrunc] = collect(errChunks, errLen, c);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        stdoutTruncated: outTrunc,
        stderrTruncated: errTrunc,
        timedOut,
      });
    };

    child.on('error', (err) => {
      /* v8 ignore next 3 -- 'error' after close is not deterministically triggerable */
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new SubprocessError(`Failed to start ${command}: ${err.message}`));
    });
    child.on('close', (code) => finish(code));

    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Run `command`/`args` and throw {@link SubprocessError} unless it exits 0 and did not time out.
 * @param command - Executable to run.
 * @param args - Argument vector.
 * @param opts - Run options.
 * @returns The successful {@link RunResult}.
 * @throws {SubprocessError} On timeout, spawn failure, or non-zero exit (the error carries `stderr`/`stdout`).
 */
export async function runOk(
  command: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  const r = await run(command, args, opts);
  if (r.timedOut) {
    throw new SubprocessError(
      `${command} timed out after ${opts.timeoutMs ?? TIMEOUT_STANDARD_MS}ms`,
      r
    );
  }
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 2000);
    throw new SubprocessError(
      `${command} exited with code ${r.code}${detail ? `: ${detail}` : ''}`,
      r
    );
  }
  return r;
}

/**
 * Invoke a bundled Python support-script (`scripts/<name>`) with the project's venv interpreter.
 * The script convention: argv carries the file paths and a JSON spec/ops blob; stdout is a single JSON object
 * `{ ok: true, ... }` on success, or `{ ok: false, "error": "<one-line teaching message>" }` (plus a non-zero
 * exit) on failure, with the full traceback on stderr only. This helper parses stdout JSON directly — it does
 * NOT go through `runOk` — so a script's own `{ok:false,"error":...}` message reaches the caller verbatim even
 * though the process also exits non-zero and writes a (possibly much longer) traceback to stderr.
 * @param scriptName - Filename under `scripts/` (e.g. `"docx_build.py"`).
 * @param args - Arguments to pass after the script path.
 * @param opts - Run options.
 * @returns The parsed JSON object the script printed on stdout.
 * @throws {SubprocessError} On timeout, spawn failure, or when stdout is not a JSON object with `ok: true`.
 */
export async function runPythonScript(
  scriptName: string,
  args: string[],
  opts: RunOptions = {}
): Promise<Record<string, unknown>> {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const r = await run(PYTHON_BIN, [scriptPath, ...args], opts);
  if (r.timedOut) {
    throw new SubprocessError(
      `${PYTHON_BIN} timed out after ${opts.timeoutMs ?? TIMEOUT_STANDARD_MS}ms`,
      r
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim() || '{}');
  } catch {
    // No parseable JSON on stdout at all — fall back to the raw exit/stderr detail.
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().slice(0, 2000);
      throw new SubprocessError(
        `${scriptName} exited with code ${r.code}${detail ? `: ${detail}` : ''}`,
        r
      );
    }
    throw new SubprocessError(`${scriptName} did not return JSON on stdout`, r);
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { ok?: unknown }).ok !== true) {
    const error = (parsed as { error?: unknown }).error;
    const message = typeof error === 'string' ? error : JSON.stringify(parsed);
    throw new SubprocessError(`${scriptName} reported failure: ${message}`, r);
  }
  return parsed as Record<string, unknown>;
}
