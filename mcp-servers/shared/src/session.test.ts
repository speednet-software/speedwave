import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from './session.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (manager) {
      manager.stop();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('creates manager with default timeout (30 minutes)', () => {
      manager = new SessionManager();
      expect(manager).toBeDefined();
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('creates manager with custom session timeout', () => {
      manager = new SessionManager({ sessionTimeoutMs: 60000 });
      expect(manager).toBeDefined();
    });

    it('creates manager with custom cleanup interval', () => {
      manager = new SessionManager({ cleanupIntervalMs: 10000 });
      expect(manager).toBeDefined();
    });

    it('creates manager with both custom options', () => {
      manager = new SessionManager({
        sessionTimeoutMs: 120000,
        cleanupIntervalMs: 30000,
      });
      expect(manager).toBeDefined();
    });

    it('starts cleanup interval on construction', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      manager = new SessionManager({ cleanupIntervalMs: 5000 });
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    });
  });

  describe('createSession', () => {
    beforeEach(() => {
      manager = new SessionManager();
    });

    it('creates session without client info', () => {
      const sessionId = manager.createSession();

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('creates session with client info', () => {
      const clientInfo = { name: 'test-client', version: '1.0.0' };
      const sessionId = manager.createSession(clientInfo);

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
    });

    it('logs session creation with client name', () => {
      const clientInfo = { name: 'test-client', version: '1.0.0' };
      manager.createSession(clientInfo);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Session created'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('test-client'));
    });

    it('logs session creation with "unknown" when no client info', () => {
      manager.createSession();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Session created'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('unknown'));
    });

    it('creates unique session IDs', () => {
      const id1 = manager.createSession();
      const id2 = manager.createSession();
      const id3 = manager.createSession();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    it('increments active session count', () => {
      expect(manager.getActiveSessionCount()).toBe(0);

      manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(1);

      manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(2);

      manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(3);
    });

    it('sets createdAt timestamp', () => {
      const beforeCreation = new Date();
      const sessionId = manager.createSession();
      const session = manager.getSession(sessionId);
      const afterCreation = new Date();

      expect(session).not.toBeNull();
      expect(session!.createdAt).toBeInstanceOf(Date);
      expect(session!.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreation.getTime());
      expect(session!.createdAt.getTime()).toBeLessThanOrEqual(afterCreation.getTime());
    });

    it('sets lastAccessedAt equal to createdAt initially', () => {
      const sessionId = manager.createSession();
      const session = manager.getSession(sessionId);

      expect(session).not.toBeNull();
      expect(session!.lastAccessedAt.getTime()).toBe(session!.createdAt.getTime());
    });
  });

  describe('getSession', () => {
    beforeEach(() => {
      manager = new SessionManager({ sessionTimeoutMs: 60000 });
    });

    it('returns null for non-existent session', () => {
      const session = manager.getSession('non-existent-id');
      expect(session).toBeNull();
    });

    it('returns session for valid ID', () => {
      const sessionId = manager.createSession({ name: 'test', version: '1.0' });
      const session = manager.getSession(sessionId);

      expect(session).not.toBeNull();
      expect(session!.id).toBe(sessionId);
      expect(session!.clientInfo).toEqual({ name: 'test', version: '1.0' });
    });

    it('updates lastAccessedAt on access', () => {
      const sessionId = manager.createSession();

      vi.advanceTimersByTime(10000);

      const session1 = manager.getSession(sessionId);
      const firstAccessTime = session1!.lastAccessedAt.getTime();

      vi.advanceTimersByTime(10000);

      const session2 = manager.getSession(sessionId);
      const secondAccessTime = session2!.lastAccessedAt.getTime();

      expect(secondAccessTime).toBeGreaterThan(firstAccessTime);
      expect(secondAccessTime - firstAccessTime).toBe(10000);
    });

    it('returns null for expired session', () => {
      const sessionId = manager.createSession();

      vi.advanceTimersByTime(60001);

      const session = manager.getSession(sessionId);
      expect(session).toBeNull();
    });

    it('logs expired session message', () => {
      const sessionId = manager.createSession();
      vi.clearAllMocks();

      vi.advanceTimersByTime(60001);

      manager.getSession(sessionId);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Session expired'));
    });

    it('deletes expired session from internal storage', () => {
      const sessionId = manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(1);

      vi.advanceTimersByTime(60001);

      manager.getSession(sessionId);
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('returns session just before timeout', () => {
      const sessionId = manager.createSession();

      vi.advanceTimersByTime(59999);

      const session = manager.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.id).toBe(sessionId);
    });

    it('keeps session alive with repeated access', () => {
      const sessionId = manager.createSession();

      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(30000);
        const session = manager.getSession(sessionId);
        expect(session).not.toBeNull();
      }
    });

    it('does not update createdAt on access', () => {
      const sessionId = manager.createSession();
      const session1 = manager.getSession(sessionId);
      const originalCreatedAt = session1!.createdAt.getTime();

      vi.advanceTimersByTime(30000);

      const session2 = manager.getSession(sessionId);
      expect(session2!.createdAt.getTime()).toBe(originalCreatedAt);
    });
  });

  describe('destroySession', () => {
    beforeEach(() => {
      manager = new SessionManager();
    });

    it('destroys existing session', () => {
      const sessionId = manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(1);

      manager.destroySession(sessionId);

      expect(manager.getActiveSessionCount()).toBe(0);
      expect(manager.getSession(sessionId)).toBeNull();
    });

    it('logs session destruction', () => {
      const sessionId = manager.createSession();
      vi.clearAllMocks();

      manager.destroySession(sessionId);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Session destroyed'));
    });

    it('does nothing for non-existent session', () => {
      vi.clearAllMocks();

      manager.destroySession('non-existent-id');

      expect(console.log).not.toHaveBeenCalled();
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('does not log when destroying non-existent session', () => {
      vi.clearAllMocks();

      manager.destroySession('non-existent-id');

      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Session destroyed'));
    });

    it('handles destroying already destroyed session', () => {
      const sessionId = manager.createSession();
      manager.destroySession(sessionId);

      vi.clearAllMocks();

      manager.destroySession(sessionId);

      expect(console.log).not.toHaveBeenCalled();
    });

    it('destroys multiple sessions independently', () => {
      const id1 = manager.createSession();
      const id2 = manager.createSession();
      const id3 = manager.createSession();

      expect(manager.getActiveSessionCount()).toBe(3);

      manager.destroySession(id2);

      expect(manager.getActiveSessionCount()).toBe(2);
      expect(manager.getSession(id1)).not.toBeNull();
      expect(manager.getSession(id2)).toBeNull();
      expect(manager.getSession(id3)).not.toBeNull();
    });
  });

  describe('getActiveSessionCount', () => {
    beforeEach(() => {
      manager = new SessionManager();
    });

    it('returns 0 for empty manager', () => {
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('returns correct count after creating sessions', () => {
      manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(1);

      manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(2);

      manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(3);
    });

    it('returns correct count after destroying sessions', () => {
      const id1 = manager.createSession();
      const id2 = manager.createSession();
      const id3 = manager.createSession();

      expect(manager.getActiveSessionCount()).toBe(3);

      manager.destroySession(id1);
      expect(manager.getActiveSessionCount()).toBe(2);

      manager.destroySession(id3);
      expect(manager.getActiveSessionCount()).toBe(1);

      manager.destroySession(id2);
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('decrements when expired session is accessed', () => {
      manager = new SessionManager({ sessionTimeoutMs: 60000 });
      const sessionId = manager.createSession();

      expect(manager.getActiveSessionCount()).toBe(1);

      vi.advanceTimersByTime(60001);
      manager.getSession(sessionId);

      expect(manager.getActiveSessionCount()).toBe(0);
    });
  });

  describe('cleanupExpiredSessions (private)', () => {
    beforeEach(() => {
      manager = new SessionManager({
        sessionTimeoutMs: 60000,
        cleanupIntervalMs: 30000,
      });
    });

    it('removes expired sessions on automatic cleanup', () => {
      const id1 = manager.createSession();
      const id2 = manager.createSession();

      expect(manager.getActiveSessionCount()).toBe(2);

      vi.advanceTimersByTime(60001);

      vi.advanceTimersByTime(30000);

      expect(manager.getActiveSessionCount()).toBe(0);
      expect(manager.getSession(id1)).toBeNull();
      expect(manager.getSession(id2)).toBeNull();
    });

    it('keeps active sessions during cleanup', () => {
      const id1 = manager.createSession();

      vi.advanceTimersByTime(30000);

      const id2 = manager.createSession();

      vi.advanceTimersByTime(31000);

      expect(manager.getActiveSessionCount()).toBe(2);

      expect(manager.getSession(id2)).not.toBeNull();

      expect(manager.getSession(id1)).toBeNull();

      expect(manager.getActiveSessionCount()).toBe(1);
    });

    it('logs cleanup message when sessions are cleaned', () => {
      manager.createSession();
      manager.createSession();
      manager.createSession();

      vi.clearAllMocks();

      vi.advanceTimersByTime(60001);

      vi.advanceTimersByTime(30000);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Cleaned up 3 expired session(s)')
      );
    });

    it('does not log when no sessions need cleanup', () => {
      manager.createSession();

      vi.clearAllMocks();

      vi.advanceTimersByTime(30000);

      vi.advanceTimersByTime(30000);

      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Cleaned up'));
    });

    it('handles cleanup with no sessions', () => {
      vi.clearAllMocks();

      vi.advanceTimersByTime(30000);

      expect(console.log).not.toHaveBeenCalled();
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('cleans up only expired sessions in mixed state', () => {
      const id1 = manager.createSession();

      vi.advanceTimersByTime(40000);

      const id2 = manager.createSession();

      vi.advanceTimersByTime(21000);

      vi.advanceTimersByTime(30000);

      expect(manager.getActiveSessionCount()).toBe(1);
      expect(manager.getSession(id1)).toBeNull();
      expect(manager.getSession(id2)).not.toBeNull();
    });

    it('runs cleanup multiple times', () => {
      manager.createSession();
      manager.createSession();
      vi.advanceTimersByTime(60001);
      vi.advanceTimersByTime(30000);

      expect(manager.getActiveSessionCount()).toBe(0);

      manager.createSession();
      manager.createSession();
      manager.createSession();
      vi.advanceTimersByTime(60001);
      vi.advanceTimersByTime(30000);

      expect(manager.getActiveSessionCount()).toBe(0);
    });
  });

  describe('stop', () => {
    it('stops cleanup interval', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      manager = new SessionManager();

      manager.stop();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('sets cleanup interval to null after stopping', () => {
      manager = new SessionManager();
      manager.stop();

      expect(() => manager.stop()).not.toThrow();
    });

    it('handles multiple stop calls', () => {
      manager = new SessionManager();

      manager.stop();
      manager.stop();
      manager.stop();

      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('prevents cleanup after stop', () => {
      manager = new SessionManager({
        sessionTimeoutMs: 60000,
        cleanupIntervalMs: 30000,
      });

      manager.createSession();
      manager.createSession();

      manager.stop();

      vi.clearAllMocks();

      vi.advanceTimersByTime(30001);

      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Cleaned up'));
    });
  });

  describe('edge cases and concurrent access', () => {
    beforeEach(() => {
      manager = new SessionManager({ sessionTimeoutMs: 60000 });
    });

    it('handles rapid session creation and access', () => {
      const sessionIds: string[] = [];

      for (let i = 0; i < 100; i++) {
        const id = manager.createSession({ name: `client-${i}`, version: '1.0' });
        sessionIds.push(id);
      }

      expect(manager.getActiveSessionCount()).toBe(100);

      for (const id of sessionIds) {
        expect(manager.getSession(id)).not.toBeNull();
      }
    });

    it('handles session at exact timeout boundary', () => {
      const sessionId = manager.createSession();

      vi.advanceTimersByTime(60000);

      const session = manager.getSession(sessionId);
      expect(session).not.toBeNull();
    });

    it('preserves session data through access updates', () => {
      const clientInfo = { name: 'test-client', version: '2.5.1' };
      const sessionId = manager.createSession(clientInfo);

      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(5000);
        const session = manager.getSession(sessionId);
        expect(session!.clientInfo).toEqual(clientInfo);
      }
    });

    it('handles session without client info throughout lifecycle', () => {
      const sessionId = manager.createSession();

      const session1 = manager.getSession(sessionId);
      expect(session1!.clientInfo).toBeUndefined();

      vi.advanceTimersByTime(30000);

      const session2 = manager.getSession(sessionId);
      expect(session2!.clientInfo).toBeUndefined();
    });

    it('correctly expires sessions with different creation times', () => {
      const id1 = manager.createSession();

      vi.advanceTimersByTime(30000);
      const id2 = manager.createSession();

      vi.advanceTimersByTime(30000);
      const id3 = manager.createSession();

      const session1 = manager.getSession(id1);
      expect(session1).not.toBeNull();

      expect(manager.getSession(id2)).not.toBeNull();
      expect(manager.getSession(id3)).not.toBeNull();

      vi.advanceTimersByTime(60001);

      expect(manager.getSession(id1)).toBeNull();
    });
  });

  describe('integration scenarios', () => {
    it('simulates realistic session lifecycle', () => {
      manager = new SessionManager({
        sessionTimeoutMs: 1800000,
        cleanupIntervalMs: 300000,
      });

      const sessionId = manager.createSession({ name: 'claude-desktop', version: '1.0.0' });
      expect(manager.getSession(sessionId)).not.toBeNull();

      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(300000);
        const session = manager.getSession(sessionId);
        expect(session).not.toBeNull();
      }

      vi.advanceTimersByTime(1800001);

      expect(manager.getSession(sessionId)).toBeNull();
    });

    it('handles multiple concurrent clients', () => {
      manager = new SessionManager({ sessionTimeoutMs: 60000 });

      const clients = [
        { name: 'client-1', version: '1.0.0' },
        { name: 'client-2', version: '2.0.0' },
        { name: 'client-3', version: '1.5.0' },
      ];

      const sessionIds = clients.map((client) => manager.createSession(client));

      expect(manager.getActiveSessionCount()).toBe(3);

      vi.advanceTimersByTime(30000);
      manager.getSession(sessionIds[0]);
      manager.getSession(sessionIds[2]);

      vi.advanceTimersByTime(31000);

      expect(manager.getSession(sessionIds[0])).not.toBeNull();
      expect(manager.getSession(sessionIds[1])).toBeNull();
      expect(manager.getSession(sessionIds[2])).not.toBeNull();
    });
  });
});
