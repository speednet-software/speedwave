import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Detection } from '@speedwave/policy-engine';
import { aggregateDetections, writePiiAudit, type DetectionBatch } from './audit-pii.js';

let dir: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('aggregateDetections', () => {
  it('sums counts for repeated categories within one batch', () => {
    const detections: Detection[] = [
      { category: 'EMAIL', action: 'tokenized', count: 2 },
      { category: 'EMAIL', action: 'tokenized', count: 1 },
      { category: 'EMAIL', action: 'tokenized', count: 3 },
    ];

    const events = aggregateDetections(
      [{ layer: 'tool-result', tool: 'slack.sendChannel', detections }],
      'sess-1'
    );

    expect(events).toEqual([
      {
        layer: 'tool-result',
        category: 'EMAIL',
        action: 'tokenized',
        count: 6,
        tool: 'slack.sendChannel',
        session: 'sess-1',
      },
    ]);
  });

  it('keeps different categories as separate events', () => {
    const detections: Detection[] = [
      { category: 'EMAIL', action: 'tokenized', count: 1 },
      { category: 'PHONE_PL', action: 'passed', count: 4 },
    ];

    const events = aggregateDetections([{ layer: 'sandbox-return', tool: null, detections }]);

    expect(events).toHaveLength(2);
    expect(events.find((e) => e.category === 'EMAIL')).toMatchObject({
      action: 'tokenized',
      count: 1,
    });
    expect(events.find((e) => e.category === 'PHONE_PL')).toMatchObject({
      action: 'passed',
      count: 4,
    });
  });

  it('preserves the action of each category', () => {
    const detections: Detection[] = [{ category: 'IBAN', action: 'passed', count: 1 }];
    const events = aggregateDetections([{ layer: 'tool-result', tool: null, detections }]);
    expect(events[0].action).toBe('passed');
  });

  it('returns an empty array for an empty batch list', () => {
    expect(aggregateDetections([])).toEqual([]);
  });

  it('defaults session to null when omitted', () => {
    const events = aggregateDetections([
      {
        layer: 'tool-result',
        tool: null,
        detections: [{ category: 'EMAIL', action: 'tokenized', count: 1 }],
      },
    ]);
    expect(events[0].tool).toBeNull();
    expect(events[0].session).toBeNull();
  });

  it('merges two batches for the same (layer, tool) into one summed event per category', () => {
    const batches: DetectionBatch[] = [
      {
        layer: 'tool-result',
        tool: 'slack.sendChannel',
        detections: [{ category: 'EMAIL', action: 'tokenized', count: 1 }],
      },
      {
        layer: 'tool-result',
        tool: 'slack.sendChannel',
        detections: [{ category: 'EMAIL', action: 'tokenized', count: 1 }],
      },
    ];

    const events = aggregateDetections(batches);

    expect(events).toEqual([
      {
        layer: 'tool-result',
        category: 'EMAIL',
        action: 'tokenized',
        count: 2,
        tool: 'slack.sendChannel',
        session: null,
      },
    ]);
  });

  it('keeps two different tools reporting the same category as separate events (attribution)', () => {
    const batches: DetectionBatch[] = [
      {
        layer: 'tool-result',
        tool: 'slack.sendChannel',
        detections: [{ category: 'EMAIL', action: 'tokenized', count: 1 }],
      },
      {
        layer: 'tool-result',
        tool: 'sharepoint.uploadFile',
        detections: [{ category: 'EMAIL', action: 'tokenized', count: 1 }],
      },
    ];

    const events = aggregateDetections(batches);

    expect(events).toHaveLength(2);
    expect(events.find((e) => e.tool === 'slack.sendChannel')).toMatchObject({
      category: 'EMAIL',
      count: 1,
    });
    expect(events.find((e) => e.tool === 'sharepoint.uploadFile')).toMatchObject({
      category: 'EMAIL',
      count: 1,
    });
  });

  it('keeps the same (layer, category, tool) with different actions as separate events', () => {
    const batches: DetectionBatch[] = [
      {
        layer: 'tool-result',
        tool: 'slack.sendChannel',
        detections: [
          { category: 'EMAIL', action: 'tokenized', count: 1 },
          { category: 'EMAIL', action: 'passed', count: 2 },
        ],
      },
    ];

    const events = aggregateDetections(batches);

    expect(events).toHaveLength(2);
    expect(events.find((e) => e.action === 'tokenized')).toMatchObject({ count: 1 });
    expect(events.find((e) => e.action === 'passed')).toMatchObject({ count: 2 });
  });
});

describe('writePiiAudit', () => {
  it('writes parsable JSONL lines with zero PII data values, given AUDIT_DIR', () => {
    dir = mkdtempSync(join(tmpdir(), 'audit-pii-'));
    vi.stubEnv('AUDIT_DIR', dir);

    writePiiAudit([
      {
        layer: 'tool-result',
        category: 'EMAIL',
        action: 'tokenized',
        count: 2,
        tool: 'slack.sendChannel',
        session: null,
      },
      { layer: 'sandbox-return', category: 'PHONE_PL', action: 'passed', count: 1 },
    ]);

    const filePath = join(dir, 'audit-hub.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const rows = lines.map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({
      layer: 'tool-result',
      category: 'EMAIL',
      action: 'tokenized',
      count: 2,
      tool: 'slack.sendChannel',
      session: null,
    });
    expect(typeof rows[0].ts).toBe('string');
    expect(rows[1]).toMatchObject({
      layer: 'sandbox-return',
      category: 'PHONE_PL',
      action: 'passed',
      count: 1,
      tool: null,
      session: null,
    });

    // No data values ever appear: only category/action/count/layer/tool/session/ts keys.
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['action', 'category', 'count', 'layer', 'session', 'tool', 'ts'].sort()
    );
    expect(content).not.toContain('alice@example.com');
  });

  it('appends to an existing file across multiple calls', () => {
    dir = mkdtempSync(join(tmpdir(), 'audit-pii-'));
    vi.stubEnv('AUDIT_DIR', dir);

    writePiiAudit([{ layer: 'tool-result', category: 'EMAIL', action: 'tokenized', count: 1 }]);
    writePiiAudit([{ layer: 'tool-result', category: 'EMAIL', action: 'tokenized', count: 1 }]);

    const content = readFileSync(join(dir, 'audit-hub.jsonl'), 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(2);
  });

  it('is a no-op (no file, no throw) when AUDIT_DIR is unset', () => {
    vi.stubEnv('AUDIT_DIR', undefined);
    dir = mkdtempSync(join(tmpdir(), 'audit-pii-'));

    expect(() =>
      writePiiAudit([{ layer: 'tool-result', category: 'EMAIL', action: 'tokenized', count: 1 }])
    ).not.toThrow();

    expect(existsSync(join(dir, 'audit-hub.jsonl'))).toBe(false);
  });

  it('is a no-op for an empty events array even with AUDIT_DIR set', () => {
    dir = mkdtempSync(join(tmpdir(), 'audit-pii-'));
    vi.stubEnv('AUDIT_DIR', dir);

    writePiiAudit([]);

    expect(existsSync(join(dir, 'audit-hub.jsonl'))).toBe(false);
  });

  it('never throws and warns on stderr when AUDIT_DIR points at a file, not a directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'audit-pii-'));
    const notADir = join(dir, 'not-a-dir');
    writeFileSync(notADir, 'x');
    vi.stubEnv('AUDIT_DIR', notADir);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      writePiiAudit([{ layer: 'tool-result', category: 'EMAIL', action: 'tokenized', count: 1 }])
    ).not.toThrow();

    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0]).toContain('[audit-pii]');
    errSpy.mockRestore();
  });
});
