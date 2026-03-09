import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from './session.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    // Spy on console.log to verify logging behavior
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
      manager = new SessionManager({ sessionTimeoutMs: 60000 }); // 1 minute
      expect(manager).toBeDefined();
    });

    it('creates manager with custom cleanup interval', () => {
      manager = new SessionManager({ cleanupIntervalMs: 10000 }); // 10 seconds
      expect(manager).toBeDefined();
    });

    it('creates manager with both custom options', () => {
      manager = new SessionManager({
        sessionTimeoutMs: 120000, // 2 minutes
        cleanupIntervalMs: 30000, // 30 seconds
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
      manager = new SessionManager({ sessionTimeoutMs: 60000 }); // 1 minute
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

      // Advance time by 10 seconds
      vi.advanceTimersByTime(10000);

      const session1 = manager.getSession(sessionId);
      const firstAccessTime = session1!.lastAccessedAt.getTime();

      // Advance time by another 10 seconds
      vi.advanceTimersByTime(10000);

      const session2 = manager.getSession(sessionId);
      const secondAccessTime = session2!.lastAccessedAt.getTime();

      expect(secondAccessTime).toBeGreaterThan(firstAccessTime);
      expect(secondAccessTime - firstAccessTime).toBe(10000);
    });

    it('returns null for expired session', () => {
      const sessionId = manager.createSession();

      // Advance time past session timeout (1 minute + 1ms)
      vi.advanceTimersByTime(60001);

      const session = manager.getSession(sessionId);
      expect(session).toBeNull();
    });

    it('logs expired session message', () => {
      const sessionId = manager.createSession();
      vi.clearAllMocks();

      // Advance time past session timeout
      vi.advanceTimersByTime(60001);

      manager.getSession(sessionId);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Session expired'));
    });

    it('deletes expired session from internal storage', () => {
      const sessionId = manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(1);

      // Advance time past session timeout
      vi.advanceTimersByTime(60001);

      manager.getSession(sessionId);
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('returns session just before timeout', () => {
      const sessionId = manager.createSession();

      // Advance time just before timeout (1 minute - 1ms)
      vi.advanceTimersByTime(59999);

      const session = manager.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.id).toBe(sessionId);
    });

    it('keeps session alive with repeated access', () => {
      const sessionId = manager.createSession();

      // Access session every 30 seconds for 3 minutes
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(30000);
        const session = manager.getSession(sessionId);
        expect(session).not.toBeNull();
      }

      // Total elapsed: 180 seconds (3 minutes)
      // Session should still be alive because we kept accessing it
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

      // Advance past timeout
      vi.advanceTimersByTime(60001);
      manager.getSession(sessionId);

      expect(manager.getActiveSessionCount()).toBe(0);
    });
  });

  describe('cleanupExpiredSessions (private)', () => {
    beforeEach(() => {
      manager = new SessionManager({
        sessionTimeoutMs: 60000, // 1 minute
        cleanupIntervalMs: 30000, // 30 seconds
      });
    });

    it('removes expired sessions on automatic cleanup', () => {
      const id1 = manager.createSession();
      const id2 = manager.createSession();

      expect(manager.getActiveSessionCount()).toBe(2);

      // Advance time past session timeout
      vi.advanceTimersByTime(60001);

      // Trigger cleanup interval
      vi.advanceTimersByTime(30000);

      expect(manager.getActiveSessionCount()).toBe(0);
      expect(manager.getSession(id1)).toBeNull();
      expect(manager.getSession(id2)).toBeNull();
    });

    it('keeps active sessions during cleanup', () => {
      const id1 = manager.createSession();

      // Advance time but not past timeout
      vi.advanceTimersByTime(30000);

      const id2 = manager.createSession();

      // Advance another 31 seconds (id1: 61s total=expired, id2: 31s total=active)
      vi.advanceTimersByTime(31000);

      // Trigger cleanup interval at 61s total
      // This runs cleanup immediately at the 61s mark
      // id1 has been idle for 61s (expired)
      // id2 has been idle for 31s (active)

      // Since cleanup happens at intervals, let's verify state before accessing
      expect(manager.getActiveSessionCount()).toBe(2); // Both still in map

      // Access id2 to keep it alive
      expect(manager.getSession(id2)).not.toBeNull();

      // id1 should be expired when accessed
      expect(manager.getSession(id1)).toBeNull();

      // Now only id2 remains
      expect(manager.getActiveSessionCount()).toBe(1);
    });

    it('logs cleanup message when sessions are cleaned', () => {
      manager.createSession();
      manager.createSession();
      manager.createSession();

      vi.clearAllMocks();

      // Advance past timeout
      vi.advanceTimersByTime(60001);

      // Trigger cleanup
      vi.advanceTimersByTime(30000);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Cleaned up 3 expired session(s)')
      );
    });

    it('does not log when no sessions need cleanup', () => {
      manager.createSession();

      vi.clearAllMocks();

      // Advance time but not past timeout
      vi.advanceTimersByTime(30000);

      // Trigger cleanup
      vi.advanceTimersByTime(30000);

      // Should not log anything as no sessions were cleaned
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Cleaned up'));
    });

    it('handles cleanup with no sessions', () => {
      vi.clearAllMocks();

      // Trigger cleanup with no sessions
      vi.advanceTimersByTime(30000);

      expect(console.log).not.toHaveBeenCalled();
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('cleans up only expired sessions in mixed state', () => {
      const id1 = manager.createSession();

      // Advance 40 seconds
      vi.advanceTimersByTime(40000);

      const id2 = manager.createSession();

      // Advance another 21 seconds (id1: 61s total, id2: 21s total)
      vi.advanceTimersByTime(21000);

      // Trigger cleanup interval
      vi.advanceTimersByTime(30000);

      // After cleanup, only id2 should remain
      expect(manager.getActiveSessionCount()).toBe(1);
      expect(manager.getSession(id1)).toBeNull(); // Expired and cleaned up
      expect(manager.getSession(id2)).not.toBeNull(); // Still valid
    });

    it('runs cleanup multiple times', () => {
      // Create and expire first batch
      manager.createSession();
      manager.createSession();
      vi.advanceTimersByTime(60001);
      vi.advanceTimersByTime(30000); // First cleanup

      expect(manager.getActiveSessionCount()).toBe(0);

      // Create and expire second batch
      manager.createSession();
      manager.createSession();
      manager.createSession();
      vi.advanceTimersByTime(60001);
      vi.advanceTimersByTime(30000); // Second cleanup

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

      // Calling stop again should not throw
      expect(() => manager.stop()).not.toThrow();
    });

    it('handles multiple stop calls', () => {
      manager = new SessionManager();

      manager.stop();
      manager.stop();
      manager.stop();

      // Should not throw
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

      // Advance time past cleanup interval
      vi.advanceTimersByTime(30001);

      // Cleanup should not run, so sessions should still be in memory
      // (even if expired, they won't be automatically cleaned)
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

      // Access all sessions
      for (const id of sessionIds) {
        expect(manager.getSession(id)).not.toBeNull();
      }
    });

    it('handles session at exact timeout boundary', () => {
      const sessionId = manager.createSession();

      // Advance exactly to timeout (not past)
      vi.advanceTimersByTime(60000);

      const session = manager.getSession(sessionId);
      expect(session).not.toBeNull();
    });

    it('preserves session data through access updates', () => {
      const clientInfo = { name: 'test-client', version: '2.5.1' };
      const sessionId = manager.createSession(clientInfo);

      // Access multiple times
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

      // At this point: id1=60s, id2=30s, id3=0s
      // Note: getSession updates lastAccessedAt, resetting the timeout
      const session1 = manager.getSession(id1);
      expect(session1).not.toBeNull(); // Just at boundary, resets timeout

      expect(manager.getSession(id2)).not.toBeNull();
      expect(manager.getSession(id3)).not.toBeNull();

      // Advance past timeout again from last access
      vi.advanceTimersByTime(60001);

      // Now id1 should expire (60.001s since last access)
      expect(manager.getSession(id1)).toBeNull();
      // id2 and id3 were accessed and their timeouts reset, so they need more time
    });
  });

  describe('integration scenarios', () => {
    it('simulates realistic session lifecycle', () => {
      manager = new SessionManager({
        sessionTimeoutMs: 1800000, // 30 minutes
        cleanupIntervalMs: 300000, // 5 minutes
      });

      // User connects
      const sessionId = manager.createSession({ name: 'claude-desktop', version: '1.0.0' });
      expect(manager.getSession(sessionId)).not.toBeNull();

      // User makes requests every 5 minutes
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(300000); // 5 minutes
        const session = manager.getSession(sessionId);
        expect(session).not.toBeNull();
      }

      // User disconnects (30 minutes of activity)
      // Wait for session to expire (30 more minutes of inactivity)
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

      // Client 1 stays active
      // Client 2 expires
      // Client 3 stays active

      vi.advanceTimersByTime(30000);
      manager.getSession(sessionIds[0]); // Client 1 access
      manager.getSession(sessionIds[2]); // Client 3 access

      vi.advanceTimersByTime(31000); // Total: 61s

      // Client 2 should be expired when accessed
      expect(manager.getSession(sessionIds[0])).not.toBeNull();
      expect(manager.getSession(sessionIds[1])).toBeNull();
      expect(manager.getSession(sessionIds[2])).not.toBeNull();
    });
  });
});
