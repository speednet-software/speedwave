import { describe, it, expect } from 'vitest';
import { notConfiguredMessage, withSetupGuidance } from './errors.js';

const EXPECTED_GUIDANCE =
  'Configure this integration in the Speedwave Desktop app (Integrations tab).';

describe('errors', () => {
  describe('notConfiguredMessage', () => {
    it('returns expected message for GitLab', () => {
      expect(notConfiguredMessage('GitLab')).toBe(`GitLab not configured. ${EXPECTED_GUIDANCE}`);
    });

    it('returns expected message for Slack', () => {
      expect(notConfiguredMessage('Slack')).toBe(`Slack not configured. ${EXPECTED_GUIDANCE}`);
    });

    it('returns expected message for Redmine', () => {
      expect(notConfiguredMessage('Redmine')).toBe(`Redmine not configured. ${EXPECTED_GUIDANCE}`);
    });

    it('returns expected message for SharePoint', () => {
      expect(notConfiguredMessage('SharePoint')).toBe(
        `SharePoint not configured. ${EXPECTED_GUIDANCE}`
      );
    });

    it('handles empty service name', () => {
      expect(notConfiguredMessage('')).toBe(` not configured. ${EXPECTED_GUIDANCE}`);
    });

    it('contains "Desktop" (points users to the Desktop app)', () => {
      expect(notConfiguredMessage('GitLab')).toContain('Desktop');
    });

    it('does NOT contain "speedwave setup" (legacy CLI guidance removed)', () => {
      expect(notConfiguredMessage('GitLab')).not.toContain('speedwave setup');
    });
  });

  describe('withSetupGuidance', () => {
    it('appends guidance to an action message', () => {
      expect(withSetupGuidance('Check your token.')).toBe(`Check your token. ${EXPECTED_GUIDANCE}`);
    });

    it('handles empty action string', () => {
      expect(withSetupGuidance('')).toBe(` ${EXPECTED_GUIDANCE}`);
    });

    it('contains "Desktop" (points users to the Desktop app)', () => {
      expect(withSetupGuidance('Check your token.')).toContain('Desktop');
    });

    it('does NOT contain "speedwave setup" (legacy CLI guidance removed)', () => {
      expect(withSetupGuidance('Check your token.')).not.toContain('speedwave setup');
    });
  });
});
