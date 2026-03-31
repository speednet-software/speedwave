import { describe, it, expect } from 'vitest';
import { SETUP_GUIDANCE, notConfiguredMessage, withSetupGuidance } from './errors.js';

describe('errors', () => {
  describe('SETUP_GUIDANCE', () => {
    it('is a non-empty string', () => {
      expect(SETUP_GUIDANCE).toBeTruthy();
      expect(SETUP_GUIDANCE.length).toBeGreaterThan(0);
    });

    it('contains "Desktop" (points users to the Desktop app)', () => {
      expect(SETUP_GUIDANCE).toContain('Desktop');
    });

    it('does NOT contain "speedwave setup" (legacy CLI guidance removed)', () => {
      expect(SETUP_GUIDANCE).not.toContain('speedwave setup');
    });
  });

  describe('notConfiguredMessage', () => {
    it('returns expected message for GitLab', () => {
      expect(notConfiguredMessage('GitLab')).toBe(`GitLab not configured. ${SETUP_GUIDANCE}`);
    });

    it('returns expected message for Slack', () => {
      expect(notConfiguredMessage('Slack')).toBe(`Slack not configured. ${SETUP_GUIDANCE}`);
    });

    it('returns expected message for Redmine', () => {
      expect(notConfiguredMessage('Redmine')).toBe(`Redmine not configured. ${SETUP_GUIDANCE}`);
    });

    it('returns expected message for SharePoint', () => {
      expect(notConfiguredMessage('SharePoint')).toBe(
        `SharePoint not configured. ${SETUP_GUIDANCE}`
      );
    });

    it('handles empty service name', () => {
      expect(notConfiguredMessage('')).toBe(` not configured. ${SETUP_GUIDANCE}`);
    });
  });

  describe('withSetupGuidance', () => {
    it('appends guidance to an action message', () => {
      expect(withSetupGuidance('Check your token.')).toBe(`Check your token. ${SETUP_GUIDANCE}`);
    });

    it('handles empty action string', () => {
      expect(withSetupGuidance('')).toBe(` ${SETUP_GUIDANCE}`);
    });
  });
});
