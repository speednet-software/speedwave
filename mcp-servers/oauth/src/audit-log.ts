/**
 * Append-only audit log for OAuth refresh/forget events (ADR-060 §"Threat model").
 *
 * One line per event, ISO-8601 timestamp, no token contents. Log file mode 0o600.
 * Rotates to `<logPath>.1` when it exceeds {@link DEFAULT_MAX_BYTES}.
 */
import { appendFile, chmod, rename, stat } from 'node:fs/promises';

/** Tool that produced the event. */
export type AuditAction = 'refresh' | 'forget';
/** Outcome — either 'ok' or an error with a short code. */
export type AuditOutcome = 'ok' | { error: string };

/** One row of the append-only audit log. */
export interface AuditEvent {
  ts: string;
  project: string;
  service: string;
  action: AuditAction;
  outcome: AuditOutcome;
}

/** Rotation threshold in bytes; one historical copy kept as `<logPath>.1`. */
export const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Rotate `<logPath>` to `<logPath>.1` when it grows past `maxBytes`. Best-effort.
 * @param logPath - the live log path
 * @param maxBytes - rotate when current size strictly exceeds this value
 */
export async function rotateIfNeeded(logPath: string, maxBytes: number): Promise<void> {
  let size: number;
  try {
    const st = await stat(logPath);
    size = st.size;
  } catch {
    // No live file yet — nothing to rotate.
    return;
  }
  if (size <= maxBytes) return;
  try {
    await rename(logPath, `${logPath}.1`);
  } catch (err) {
    console.error(
      `oauth audit-log rotation failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Append a single event to the audit log. Best-effort: write failures go to stderr.
 * @param logPath - absolute path to the audit log file
 * @param event - the event to record (timestamps generated at call site)
 * @param maxBytes - optional rotation threshold (override for tests)
 */
export async function appendAuditEvent(
  logPath: string,
  event: AuditEvent,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<void> {
  const outcomeStr = event.outcome === 'ok' ? 'ok' : `error:${event.outcome.error}`;
  const line = `${event.ts} project=${event.project} service=${event.service} action=${event.action} outcome=${outcomeStr}\n`;
  await rotateIfNeeded(logPath, maxBytes);
  try {
    await appendFile(logPath, line, { mode: 0o600 });
    // chmod again — appendFile mode only applies on file creation.
    await chmod(logPath, 0o600);
  } catch (err) {
    console.error(
      `oauth audit-log append failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
