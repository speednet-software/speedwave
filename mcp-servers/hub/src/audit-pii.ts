/**
 * PII detection audit writer: appends JSONL rows to `$AUDIT_DIR/audit-hub.jsonl` — one line per
 * (layer, category, action, tool) per executeCode invocation, carrying zero data values.
 * @module audit-pii
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Detection } from '@speedwave/policy-engine';
import { ts } from '@speedwave/mcp-shared';

/** Sandbox boundary a detection crossed: bridge result, or the sandbox code's own return value. */
export type AuditLayer = 'B-result' | 'sandbox-return';

/** One audit row: category/action/count metadata only, never the scanned data itself. */
export interface PiiAuditEvent {
  layer: AuditLayer;
  category: string;
  action: 'tokenized' | 'passed';
  count: number;
  tool?: string | null;
  session?: string | null;
}

/** Filename mirrors Rust `consts::AUDIT_HUB_FILE` (crates/speedwave-runtime/src/consts.rs). */
const AUDIT_FILE_NAME = 'audit-hub.jsonl';

/** One raw scan's detections, tagged with the boundary and tool that produced them. */
export interface DetectionBatch {
  /** Audit boundary the detections were found at. */
  layer: AuditLayer;
  /** Service/tool that produced the scanned value (`service.tool`), or null. */
  tool: string | null;
  /** Raw detections from a single tokenize() call. */
  detections: Detection[];
}

/**
 * Aggregate raw detections from every batch collected during one executeCode invocation into one
 * event per (layer, category, action, tool), summing counts. Two calls to the same tool collapse
 * into one row; two different tools reporting the same category stay separate (attribution).
 * @param batches - Every raw detection batch collected during the invocation.
 * @param session - Session/request id, or null when the hub has none available.
 */
export function aggregateDetections(
  batches: DetectionBatch[],
  session: string | null = null
): PiiAuditEvent[] {
  const byKey = new Map<string, PiiAuditEvent>();
  for (const batch of batches) {
    for (const detection of batch.detections) {
      const key = JSON.stringify([batch.layer, detection.category, detection.action, batch.tool]);
      const existing = byKey.get(key);
      if (existing) {
        existing.count += detection.count;
      } else {
        byKey.set(key, {
          layer: batch.layer,
          category: detection.category,
          action: detection.action,
          count: detection.count,
          tool: batch.tool,
          session,
        });
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Append one JSONL line per event to `$AUDIT_DIR/audit-hub.jsonl`; no-op when `AUDIT_DIR` is
 * unset. Never throws into the caller: a write failure warns on stderr and is swallowed.
 * @param events - PII-audit events to append.
 */
export function writePiiAudit(events: PiiAuditEvent[]): void {
  if (events.length === 0) return;

  const auditDir = process.env.AUDIT_DIR;
  if (!auditDir) return;

  try {
    mkdirSync(auditDir, { recursive: true });
    const lines = events
      .map((event) =>
        JSON.stringify({
          ts: ts(),
          layer: event.layer,
          category: event.category,
          action: event.action,
          count: event.count,
          tool: event.tool ?? null,
          session: event.session ?? null,
        })
      )
      .concat('')
      .join('\n');
    appendFileSync(join(auditDir, AUDIT_FILE_NAME), lines);
  } catch (err) {
    console.error(
      `${ts()} [audit-pii] failed to write PII audit event: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
