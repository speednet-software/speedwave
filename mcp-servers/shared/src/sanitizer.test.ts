import { describe, expect, it } from 'vitest';
import { sanitize, RULE_COUNT } from './sanitizer';

describe('sanitize', () => {
  it('rule count matches Rust SSOT EXPECTED_RULE_COUNT', () => {
    // Mirrors `EXPECTED_RULE_COUNT` in crates/speedwave-runtime/src/log_sanitizer.rs.
    // Bump both together when adding a rule.
    expect(RULE_COUNT).toBe(22);
  });

  it('redacts Bearer tokens', () => {
    const out = sanitize('Authorization: Bearer abc.def.ghi');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts JWT', () => {
    const out = sanitize('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature');
    expect(out).toContain('***REDACTED_JWT***');
    expect(out).not.toContain('eyJzdWIiOiIxIn0');
  });

  it('redacts Slack tokens', () => {
    const out = sanitize('xoxb-1234567890-abcdef');
    expect(out).toContain('***REDACTED_SLACK_TOKEN***');
  });

  it('redacts Slack rotating refresh tokens (xoxe-1-…)', () => {
    const out = sanitize('refresh with xoxe-1-A1B2C3D4E5');
    expect(out).toContain('***REDACTED_SLACK_TOKEN***');
    expect(out).not.toContain('xoxe-1-');
  });

  it('redacts Slack rotated access tokens (xoxe.xoxp-…) in full', () => {
    const out = sanitize('rotated access xoxe.xoxp-FAKE-TOKEN-VALUE');
    expect(out).toContain('***REDACTED_SLACK_TOKEN***');
    // The whole token must be consumed — no bare `xoxe.` prefix left behind.
    expect(out).not.toContain('xoxe.');
  });

  it('does not redact the bare word xoxe without a token body', () => {
    expect(sanitize('the xoxe prefix marks rotating tokens')).toContain('xoxe prefix');
  });

  it('redacts GitHub PAT', () => {
    const out = sanitize('ghp_' + 'A'.repeat(40));
    expect(out).toContain('***REDACTED_GITHUB_TOKEN***');
  });

  it('redacts Anthropic key', () => {
    const out = sanitize('using sk-ant-api03-abc123_def');
    expect(out).toContain('***REDACTED_ANTHROPIC_KEY***');
  });

  it('redacts macOS home path username', () => {
    const out = sanitize('reading /Users/alice/.speedwave/config.json');
    expect(out).not.toContain('alice');
    expect(out).toContain('/Users/<user>/.speedwave/config.json');
  });

  it('redacts Set-Cookie', () => {
    const out = sanitize('Set-Cookie: session=abc123; Path=/');
    expect(out).not.toContain('abc123');
    expect(out).toContain('***REDACTED***');
    expect(out).toContain('Path=/');
  });

  it('redacts Set-Cookie value with embedded space (non-RFC)', () => {
    const out = sanitize('Set-Cookie: id=secret extra_data; Path=/');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('extra_data');
    expect(out).toContain('Path=/');
  });

  it('redacts Cookie request header', () => {
    const out = sanitize('Cookie: session_id=xyz; csrftoken=789');
    expect(out).not.toContain('xyz');
    expect(out).not.toContain('789');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts Linux home path username', () => {
    const out = sanitize('loaded from /home/alice/.cache/foo');
    expect(out).not.toContain('alice');
    expect(out).toContain('/home/<user>/.cache/foo');
  });

  it('redacts Windows home path username', () => {
    const out = sanitize(String.raw`open failed: C:\Users\Bob\AppData\Roaming\speedwave`);
    expect(out).not.toContain('Bob');
    expect(out).toContain(String.raw`C:\Users\<user>\AppData\Roaming\speedwave`);
  });

  it('does not redact normal prose', () => {
    expect(sanitize('eating a cookie now')).toBe('eating a cookie now');
  });
});
