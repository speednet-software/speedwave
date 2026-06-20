import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEvent, rotateIfNeeded } from './audit-log.js';

describe('appendAuditEvent', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'audit-test-'));
    logPath = join(dir, 'audit.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes one line per call', async () => {
    await appendAuditEvent(logPath, {
      ts: '2026-05-15T12:00:00.000Z',
      project: 'p',
      service: 'sharepoint',
      action: 'refresh',
      outcome: 'ok',
    });
    const content = await readFile(logPath, 'utf8');
    expect(content).toBe(
      '2026-05-15T12:00:00.000Z project=p service=sharepoint action=refresh outcome=ok\n'
    );
  });

  it('serializes error outcome as error:<code>', async () => {
    await appendAuditEvent(logPath, {
      ts: '2026-05-15T12:00:00.000Z',
      project: 'p',
      service: 'sharepoint',
      action: 'refresh',
      outcome: { error: 'rate_limited' },
    });
    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('outcome=error:rate_limited');
  });

  it('appends successive events without overwriting', async () => {
    await appendAuditEvent(logPath, {
      ts: 't1',
      project: 'p',
      service: 's',
      action: 'refresh',
      outcome: 'ok',
    });
    await appendAuditEvent(logPath, {
      ts: 't2',
      project: 'p',
      service: 's',
      action: 'forget',
      outcome: 'ok',
    });
    const content = await readFile(logPath, 'utf8');
    expect(content.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it.runIf(process.platform !== 'win32')('creates the log file with mode 0o600', async () => {
    await appendAuditEvent(logPath, {
      ts: 't',
      project: 'p',
      service: 's',
      action: 'refresh',
      outcome: 'ok',
    });
    const st = await stat(logPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('does not throw if the directory does not exist (best-effort)', async () => {
    const path = join(dir, 'missing', 'audit.log');
    await expect(
      appendAuditEvent(path, {
        ts: 't',
        project: 'p',
        service: 's',
        action: 'refresh',
        outcome: 'ok',
      })
    ).resolves.not.toThrow();
  });
});

describe('audit-log rotation', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'audit-rotate-test-'));
    logPath = join(dir, 'audit.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rotateIfNeeded is a no-op when the file does not exist', async () => {
    await expect(rotateIfNeeded(logPath, 10)).resolves.not.toThrow();
  });

  it('rotateIfNeeded does nothing when size is at or below threshold', async () => {
    await writeFile(logPath, 'a'.repeat(10));
    await rotateIfNeeded(logPath, 10);
    // Live log preserved, no .1 created.
    const live = await readFile(logPath, 'utf8');
    expect(live).toBe('a'.repeat(10));
    await expect(stat(`${logPath}.1`)).rejects.toThrow();
  });

  it('rotateIfNeeded renames live → .1 when size strictly exceeds threshold', async () => {
    await writeFile(logPath, 'a'.repeat(11));
    await rotateIfNeeded(logPath, 10);
    const rotated = await readFile(`${logPath}.1`, 'utf8');
    expect(rotated).toBe('a'.repeat(11));
    // Live log gone (next append will recreate it).
    await expect(stat(logPath)).rejects.toThrow();
  });

  it.runIf(process.platform !== 'win32')(
    'rotateIfNeeded swallows rename errors (best-effort, covers audit-log.ts:55)',
    async () => {
      // Make rotation fail: `${logPath}.1` is a non-empty directory.
      const { mkdir } = await import('node:fs/promises');
      await writeFile(logPath, 'a'.repeat(20));
      await mkdir(`${logPath}.1`);
      await mkdir(`${logPath}.1/inner`); // non-empty so rename fails on POSIX

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(rotateIfNeeded(logPath, 10)).resolves.not.toThrow();
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringMatching(/oauth audit-log rotation failed/)
        );
      } finally {
        consoleSpy.mockRestore();
      }
    }
  );

  it('rotateIfNeeded overwrites a stale .1 instead of leaking copies', async () => {
    await writeFile(`${logPath}.1`, 'stale');
    await writeFile(logPath, 'a'.repeat(11));
    await rotateIfNeeded(logPath, 10);
    const rotated = await readFile(`${logPath}.1`, 'utf8');
    expect(rotated).toBe('a'.repeat(11));
  });

  it('appendAuditEvent rotates before append when over threshold', async () => {
    await writeFile(logPath, 'a'.repeat(100));
    await appendAuditEvent(
      logPath,
      {
        ts: 't1',
        project: 'p',
        service: 's',
        action: 'refresh',
        outcome: 'ok',
      },
      50 // tiny threshold
    );
    // Old contents moved to .1
    const rotated = await readFile(`${logPath}.1`, 'utf8');
    expect(rotated).toBe('a'.repeat(100));
    // New live log starts fresh with just one line.
    const live = await readFile(logPath, 'utf8');
    expect(live.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it.runIf(process.platform !== 'win32')(
    'fresh log after rotation is created with mode 0o600',
    async () => {
      await writeFile(logPath, 'a'.repeat(100), { mode: 0o600 });
      await appendAuditEvent(
        logPath,
        {
          ts: 't1',
          project: 'p',
          service: 's',
          action: 'refresh',
          outcome: 'ok',
        },
        50
      );
      const st = await stat(logPath);
      expect(st.mode & 0o777).toBe(0o600);
    }
  );

  it('appendAuditEvent does NOT rotate when under threshold', async () => {
    await writeFile(logPath, 'a'.repeat(10));
    await appendAuditEvent(
      logPath,
      {
        ts: 't1',
        project: 'p',
        service: 's',
        action: 'refresh',
        outcome: 'ok',
      },
      1000
    );
    await expect(stat(`${logPath}.1`)).rejects.toThrow();
    const live = await readFile(logPath, 'utf8');
    expect(live.startsWith('a'.repeat(10))).toBe(true);
    expect(live).toContain('action=refresh');
  });
});
