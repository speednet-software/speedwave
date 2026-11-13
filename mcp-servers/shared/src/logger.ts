/**
 * Simple logging utilities for MCP servers
 * @module shared/logger
 */

/**
 * Zero-pad a number's magnitude to two digits.
 * @param n - The value (sign ignored — used for date/time/offset components).
 */
function pad2(n: number): string {
  return String(Math.abs(n)).padStart(2, '0');
}

/** Returns `[<ISO 8601 with local offset>]` for log-line prefixes (local time, container `TZ`). */
export function ts(): string {
  const d = new Date();
  const offMin = -d.getTimezoneOffset();
  const sign = offMin < 0 ? '-' : '+';
  const offset =
    offMin === 0 ? '+00:00' : `${sign}${pad2(Math.trunc(offMin / 60))}:${pad2(offMin % 60)}`;
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `[${date}T${time}.${ms}${offset}]`;
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * `code=<CODE> name=<Name>` for a log line, never the message.
 * @param error - The caught value.
 */
export function describeError(error: unknown): string {
  const fields = (typeof error === 'object' && error !== null ? error : {}) as Record<
    string,
    unknown
  >;
  const code =
    typeof fields.code === 'string' && SAFE_TOKEN.test(fields.code)
      ? fields.code
      : Number.isInteger(fields.status)
        ? `HTTP_${String(fields.status)}`
        : 'UNKNOWN';
  const name = error instanceof Error && SAFE_TOKEN.test(error.name) ? ` name=${error.name}` : '';
  return `code=${code}${name}`;
}
