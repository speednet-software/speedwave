/**
 * MCP Session Management
 * Cryptographically secure session tracking
 */

import { randomUUID } from 'crypto';
import type { Session } from './types.js';
import { ts } from './logger.js';

/**
 * Configuration options for session manager behavior.
 * Controls session timeout and cleanup frequency.
 */
export interface SessionManagerOptions {
  /** Session timeout in milliseconds (default: 30 minutes) */
  sessionTimeoutMs?: number;
  /** Cleanup interval in milliseconds (default: 5 minutes) */
  cleanupIntervalMs?: number;
}

/**
 * Manages active MCP sessions with automatic expiration.
 * Tracks client connections and enforces session timeouts.
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private readonly sessionTimeoutMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * Creates a new session manager with specified timeout settings
   * @param options - Configuration for session management behavior
   */
  constructor(options: SessionManagerOptions = {}) {
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 30 * 60 * 1000; // 30 minutes
    const cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60 * 1000; // 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), cleanupIntervalMs);
  }

  /**
   * Create a new session
   * @param clientInfo - Optional client information
   * @param clientInfo.name - Name of the client application
   * @param clientInfo.version - Version of the client application
   * @returns Session ID (UUID)
   */
  public createSession(clientInfo?: { name: string; version: string }): string {
    const sessionId = randomUUID();
    const now = new Date();

    const session: Session = {
      id: sessionId,
      createdAt: now,
      lastAccessedAt: now,
      clientInfo,
    };

    this.sessions.set(sessionId, session);
    console.log(
      `${ts()} ✅ Session created: ${sessionId.substring(0, 8)}... (${clientInfo?.name || 'unknown'})`
    );
    return sessionId;
  }

  /**
   * Get session by ID, updating last accessed time
   * @param sessionId Session ID
   * @returns Session or null if not found/expired
   */
  public getSession(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    const now = new Date();
    const elapsed = now.getTime() - session.lastAccessedAt.getTime();

    if (elapsed > this.sessionTimeoutMs) {
      console.log(`${ts()} ⚠️  Session expired: ${sessionId.substring(0, 8)}...`);
      this.sessions.delete(sessionId);
      return null;
    }

    session.lastAccessedAt = now;
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Destroy a session explicitly (e.g., on logout).
   * Sessions also expire automatically via TTL, but this allows immediate termination.
   * @param sessionId Session ID to destroy
   */
  public destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      console.log(`${ts()} 🗑️  Session destroyed: ${sessionId.substring(0, 8)}...`);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Get count of active sessions
   */
  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = new Date();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const elapsed = now.getTime() - session.lastAccessedAt.getTime();

      if (elapsed > this.sessionTimeoutMs) {
        this.sessions.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`${ts()} 🧹 Cleaned up ${cleanedCount} expired session(s)`);
    }
  }

  /**
   * Stop the cleanup interval
   */
  public stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Default global session manager instance
export const sessionManager = new SessionManager();
