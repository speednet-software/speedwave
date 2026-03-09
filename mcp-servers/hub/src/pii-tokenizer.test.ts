import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createPIIContext,
  tokenizePII,
  detokenizePII,
  cleanupExpiredTokens,
  getTokenStats,
} from './pii-tokenizer.js';
import { PIIType } from './hub-types.js';

describe('pii-tokenizer', () => {
  describe('createPIIContext', () => {
    it('creates context with default values', () => {
      const context = createPIIContext();

      expect(context.tokens.size).toBe(0);
      expect(context.maxTokens).toBe(1000);
      expect(context.ttlMs).toBe(30 * 60 * 1000);
    });

    it('creates context with custom values', () => {
      const context = createPIIContext(500, 60000);

      expect(context.maxTokens).toBe(500);
      expect(context.ttlMs).toBe(60000);
    });
  });

  describe('tokenizePII', () => {
    let context: ReturnType<typeof createPIIContext>;

    beforeEach(() => {
      context = createPIIContext();
    });

    it('tokenizes email addresses', () => {
      const data = { email: 'test@example.com' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.email).toMatch(/\[EMAIL:TOKEN_[A-F0-9]+\]/);
      expect(result.email).not.toContain('test@example.com');
    });

    it('tokenizes Polish phone numbers', () => {
      const data = { phone: '+48 123 456 789' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.phone).toMatch(/\[PHONE_PL:TOKEN_[A-F0-9]+\]/);
    });

    it('tokenizes valid PESEL (with checksum)', () => {
      // Valid PESEL: 44051401359 (checksum correct)
      const data = { id: '44051401359' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.id).toMatch(/\[PESEL:TOKEN_[A-F0-9]+\]/);
    });

    it('does not tokenize invalid PESEL', () => {
      // Invalid PESEL: 12345678901 (checksum incorrect)
      const data = { id: '12345678901' };
      const result = tokenizePII(data, context) as Record<string, string>;

      // Should not be tokenized because checksum fails
      expect(result.id).toBe('12345678901');
    });

    it('tokenizes valid NIP (with checksum)', () => {
      // Valid NIP: 5261040828 (real example with valid checksum)
      const data = { nip: '5261040828' };
      const result = tokenizePII(data, context) as Record<string, string>;

      // NIP with valid checksum should be tokenized
      // Note: NIP pattern is 10 digits, same as PESEL - may match PESEL first
      expect(result.nip).toMatch(/\[(NIP|PESEL):TOKEN_[A-F0-9]+\]/);
    });

    it('tokenizes credit card numbers (Luhn valid)', () => {
      // Valid test card: 4532015112830366
      const data = { card: '4532-0151-1283-0366' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.card).toMatch(/\[CARD:TOKEN_[A-F0-9]+\]/);
    });

    it('tokenizes API keys', () => {
      const data = { key: 'sk-1234567890abcdefghij' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.key).toMatch(/\[API_KEY:TOKEN_[A-F0-9]+\]/);
    });

    it('handles nested objects', () => {
      const data = {
        user: {
          email: 'nested@example.com',
          details: {
            phone: '+48 111 222 333',
          },
        },
      };
      const result = tokenizePII(data, context) as {
        user: { email: string; details: { phone: string } };
      };

      expect(result.user.email).toMatch(/\[EMAIL:TOKEN_[A-F0-9]+\]/);
      expect(result.user.details.phone).toMatch(/\[PHONE_PL:TOKEN_[A-F0-9]+\]/);
    });

    it('handles arrays', () => {
      const data = {
        emails: ['one@example.com', 'two@example.com'],
      };
      const result = tokenizePII(data, context) as { emails: string[] };

      expect(result.emails[0]).toMatch(/\[EMAIL:TOKEN_[A-F0-9]+\]/);
      expect(result.emails[1]).toMatch(/\[EMAIL:TOKEN_[A-F0-9]+\]/);
    });

    it('reuses tokens for same values', () => {
      const data = {
        email1: 'same@example.com',
        email2: 'same@example.com',
      };
      const result = tokenizePII(data, context) as { email1: string; email2: string };

      expect(result.email1).toBe(result.email2);
      expect(context.tokens.size).toBe(1);
    });

    it('handles null and undefined', () => {
      expect(tokenizePII(null, context)).toBeNull();
      expect(tokenizePII(undefined, context)).toBeUndefined();
    });

    it('preserves non-PII data', () => {
      const data = {
        name: 'John Doe',
        age: 30,
        active: true,
      };
      const result = tokenizePII(data, context);

      expect(result).toEqual(data);
    });

    it('respects maxTokens limit', () => {
      // Suppress console.warn for this test
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const limitedContext = createPIIContext(2, 30000);

      const data = {
        email1: 'one@example.com',
        email2: 'two@example.com',
        email3: 'three@example.com', // Should not be tokenized
      };

      tokenizePII(data, limitedContext);

      expect(limitedContext.tokens.size).toBe(2);

      vi.restoreAllMocks();
    });
  });

  describe('detokenizePII', () => {
    let context: ReturnType<typeof createPIIContext>;

    beforeEach(() => {
      context = createPIIContext();
    });

    it('restores tokenized email', () => {
      const original = { email: 'test@example.com' };
      const tokenized = tokenizePII(original, context) as Record<string, string>;
      const restored = detokenizePII(tokenized, context) as Record<string, string>;

      expect(restored.email).toBe('test@example.com');
    });

    it('restores nested tokenized data', () => {
      const original = {
        user: {
          email: 'nested@example.com',
        },
      };
      const tokenized = tokenizePII(original, context);
      const restored = detokenizePII(tokenized, context) as { user: { email: string } };

      expect(restored.user.email).toBe('nested@example.com');
    });

    it('restores arrays', () => {
      const original = {
        emails: ['one@example.com', 'two@example.com'],
      };
      const tokenized = tokenizePII(original, context);
      const restored = detokenizePII(tokenized, context) as { emails: string[] };

      expect(restored.emails[0]).toBe('one@example.com');
      expect(restored.emails[1]).toBe('two@example.com');
    });

    it('handles unknown tokens gracefully', () => {
      const data = { value: '[EMAIL:TOKEN_UNKNOWN123]' };
      const restored = detokenizePII(data, context) as Record<string, string>;

      // Unknown tokens should remain unchanged
      expect(restored.value).toBe('[EMAIL:TOKEN_UNKNOWN123]');
    });

    it('handles null and undefined', () => {
      expect(detokenizePII(null, context)).toBeNull();
      expect(detokenizePII(undefined, context)).toBeUndefined();
    });

    it('updates access count on detokenize', () => {
      const original = { email: 'test@example.com' };
      const tokenized = tokenizePII(original, context);

      // First detokenize
      detokenizePII(tokenized, context);

      // Check access count
      const entry = Array.from(context.tokens.values())[0];
      expect(entry.accessCount).toBeGreaterThan(1);
    });
  });

  describe('cleanupExpiredTokens', () => {
    it('removes expired tokens', () => {
      vi.useFakeTimers();

      const context = createPIIContext(100, 1000); // 1 second TTL

      // Add a token
      tokenizePII({ email: 'test@example.com' }, context);
      expect(context.tokens.size).toBe(1);

      // Advance time past TTL
      vi.advanceTimersByTime(1500);

      const removed = cleanupExpiredTokens(context);

      expect(removed).toBe(1);
      expect(context.tokens.size).toBe(0);

      vi.useRealTimers();
    });

    it('keeps non-expired tokens', () => {
      vi.useFakeTimers();

      const context = createPIIContext(100, 10000); // 10 second TTL

      tokenizePII({ email: 'test@example.com' }, context);

      // Advance time less than TTL
      vi.advanceTimersByTime(5000);

      const removed = cleanupExpiredTokens(context);

      expect(removed).toBe(0);
      expect(context.tokens.size).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('getTokenStats', () => {
    it('returns correct statistics', () => {
      const context = createPIIContext();

      tokenizePII(
        {
          email: 'test@example.com',
          phone: '+48 123 456 789',
          email2: 'other@example.com',
        },
        context
      );

      const stats = getTokenStats(context);

      expect(stats.total).toBe(3);
      expect(stats.byType[PIIType.EMAIL]).toBe(2);
      expect(stats.byType[PIIType.PHONE_PL]).toBe(1);
    });

    it('returns empty stats for empty context', () => {
      const context = createPIIContext();
      const stats = getTokenStats(context);

      expect(stats.total).toBe(0);
      expect(Object.keys(stats.byType)).toHaveLength(0);
    });
  });

  describe('roundtrip', () => {
    it('preserves data through tokenize/detokenize cycle', () => {
      const context = createPIIContext();
      const original = {
        user: {
          email: 'test@example.com',
          phone: '+48 123 456 789',
          name: 'John Doe',
          active: true,
          count: 42,
        },
        metadata: null,
      };

      const tokenized = tokenizePII(original, context);
      const restored = detokenizePII(tokenized, context);

      expect(restored).toEqual(original);
    });
  });

  describe('multiple occurrences (replaceAll fix)', () => {
    it('should replace ALL occurrences of the same email', () => {
      const context = createPIIContext();
      const data = 'Contact test@example.com or test@example.com for help';
      const result = tokenizePII(data, context) as string;

      // Both occurrences should be replaced with the SAME token
      const matches = result.match(/\[EMAIL:TOKEN_[A-F0-9]+\]/g);
      expect(matches).toHaveLength(2);
      expect(matches![0]).toBe(matches![1]);
      expect(result).not.toContain('test@example.com');
    });

    it('should replace ALL occurrences of the same phone number', () => {
      const context = createPIIContext();
      const data = 'Call +48 123 456 789 or +48 123 456 789';
      const result = tokenizePII(data, context) as string;

      const matches = result.match(/\[PHONE_PL:TOKEN_[A-F0-9]+\]/g);
      expect(matches).toHaveLength(2);
      expect(matches![0]).toBe(matches![1]);
    });

    it('should use O(1) lookup for repeated values', () => {
      const context = createPIIContext();
      // Process same email multiple times
      const email = 'repeated@example.com';
      const data1 = `Email: ${email}`;
      const data2 = `Another: ${email}`;

      tokenizePII(data1, context);
      tokenizePII(data2, context);

      // Should only create ONE token entry
      expect(context.tokens.size).toBe(1);
      // valueToToken cache should have the entry
      expect(context.valueToToken.size).toBe(1);
    });
  });

  describe('ReDoS protection', () => {
    it('should handle pathological email input without ReDoS', () => {
      const context = createPIIContext();
      // This pattern could cause catastrophic backtracking in vulnerable regex
      const data = 'a'.repeat(50) + '@' + 'b'.repeat(50) + '.com';

      const start = Date.now();
      tokenizePII(data, context);
      const elapsed = Date.now() - start;

      // Should complete quickly (under 100ms even for pathological input)
      expect(elapsed).toBeLessThan(100);
    });

    it('should respect EMAIL length limits', () => {
      const context = createPIIContext();
      // Email with local part > 64 chars - regex will match up to 64 chars
      // This is expected behavior: regex finds the longest valid match
      const longLocal = 'a'.repeat(65) + '@example.com';
      const result = tokenizePII(longLocal, context) as string;

      // Regex matches 64 'a's + @example.com, leaving 1 'a' at the start
      expect(result).toMatch(/^a\[EMAIL:TOKEN_[A-F0-9]+\]$/);
      expect(context.tokens.size).toBe(1);
    });
  });

  describe('detokenize with token-like values', () => {
    it('should handle values containing token-like patterns', () => {
      const context = createPIIContext();

      // First, tokenize a real email
      const original = { email: 'real@example.com' };
      const tokenized = tokenizePII(original, context) as { email: string };
      const realToken = tokenized.email;

      // Now manually add a token whose value looks like another token
      // Note: Token ID must be valid hex ([A-F0-9]+)
      const fakeTokenValue = '[EMAIL:TOKEN_DEADBEEF]';
      context.tokens.set('[EMAIL:TOKEN_ABCD1234]', {
        token: '[EMAIL:TOKEN_ABCD1234]',
        type: PIIType.EMAIL,
        value: fakeTokenValue,
        createdAt: new Date(),
        accessCount: 1,
      });

      const input = { msg: 'Contact [EMAIL:TOKEN_ABCD1234] for help' };
      const result = detokenizePII(input, context) as { msg: string };

      // Should restore to the fake token value, not process it further
      expect(result.msg).toBe(`Contact ${fakeTokenValue} for help`);
    });

    it('should replace from end to preserve indices', () => {
      const context = createPIIContext();

      // Create two tokens manually
      context.tokens.set('[EMAIL:TOKEN_AAAAAAAA]', {
        token: '[EMAIL:TOKEN_AAAAAAAA]',
        type: PIIType.EMAIL,
        value: 'first@example.com',
        createdAt: new Date(),
        accessCount: 1,
      });
      context.tokens.set('[EMAIL:TOKEN_BBBBBBBB]', {
        token: '[EMAIL:TOKEN_BBBBBBBB]',
        type: PIIType.EMAIL,
        value: 'second@example.com',
        createdAt: new Date(),
        accessCount: 1,
      });

      const input = 'Start [EMAIL:TOKEN_AAAAAAAA] middle [EMAIL:TOKEN_BBBBBBBB] end';
      const result = detokenizePII(input, context) as string;

      expect(result).toBe('Start first@example.com middle second@example.com end');
    });
  });

  describe('cleanupExpiredTokens with valueToToken', () => {
    it('removes from both tokens and valueToToken maps', () => {
      vi.useFakeTimers();

      const context = createPIIContext(100, 1000); // 1 second TTL

      // Add a token
      tokenizePII({ email: 'cleanup@example.com' }, context);
      expect(context.tokens.size).toBe(1);
      expect(context.valueToToken.size).toBe(1);

      // Advance time past TTL
      vi.advanceTimersByTime(1500);

      const removed = cleanupExpiredTokens(context);

      expect(removed).toBe(1);
      expect(context.tokens.size).toBe(0);
      expect(context.valueToToken.size).toBe(0); // Also cleaned up

      vi.useRealTimers();
    });
  });

  describe('SENSITIVE_FIELD (key-based detection)', () => {
    let context: ReturnType<typeof createPIIContext>;

    beforeEach(() => {
      context = createPIIContext();
    });

    it('tokenizes password field', () => {
      const data = { password: 'mysecret123' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.password).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
      expect(result.password).not.toContain('mysecret123');
    });

    it('tokenizes token field', () => {
      const data = { token: 'abc123xyz' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.token).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
    });

    it('tokenizes auth_token field (partial match)', () => {
      const data = { auth_token: 'bearer-xxx-yyy' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.auth_token).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
    });

    it('tokenizes client_secret field', () => {
      const data = { client_secret: 'very-secret-value' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.client_secret).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
    });

    it('tokenizes api_key field', () => {
      const data = { api_key: 'my-api-key-123' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.api_key).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
    });

    it('tokenizes credential field', () => {
      const data = { credential: 'some-credential' };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.credential).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
    });

    it('is case-insensitive for key names', () => {
      const data = {
        PASSWORD: 'secret1',
        Token: 'secret2',
        API_KEY: 'secret3',
      };
      const result = tokenizePII(data, context) as Record<string, string>;

      expect(result.PASSWORD).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
      expect(result.Token).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
      expect(result.API_KEY).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
    });

    it('handles nested objects with sensitive fields', () => {
      const data = {
        user: {
          name: 'John',
          login: {
            password: 'secret123',
            api_key: 'key456',
          },
        },
        config: {
          auth_token: 'bearer-token',
          enabled: true,
        },
      };
      const result = tokenizePII(data, context) as {
        user: { name: string; login: { password: string; api_key: string } };
        config: { auth_token: string; enabled: boolean };
      };

      expect(result.user.name).toBe('John'); // Not tokenized
      expect(result.user.login.password).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
      expect(result.user.login.api_key).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
      expect(result.config.auth_token).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
      expect(result.config.enabled).toBe(true); // Non-string preserved
    });

    it('does not tokenize non-sensitive fields', () => {
      const data = {
        username: 'john_doe',
        status: 'active',
        count: 42,
      };
      const result = tokenizePII(data, context);

      expect(result).toEqual(data); // Unchanged
    });

    it('reuses tokens for same sensitive values', () => {
      const data = {
        password: 'same-secret',
        token: 'same-secret', // Same value, different key
      };
      const result = tokenizePII(data, context) as Record<string, string>;

      // Same value should get same token
      expect(result.password).toBe(result.token);
      expect(context.tokens.size).toBe(1);
    });

    it('detokenizes sensitive field values correctly', () => {
      const original = {
        password: 'mysecret123',
        api_key: 'my-api-key',
      };
      const tokenized = tokenizePII(original, context);
      const restored = detokenizePII(tokenized, context) as Record<string, string>;

      expect(restored.password).toBe('mysecret123');
      expect(restored.api_key).toBe('my-api-key');
    });

    it('roundtrip preserves data with sensitive fields', () => {
      const original = {
        user: {
          name: 'John Doe',
          password: 'secret123',
          email: 'john@example.com',
        },
        config: {
          api_key: 'key-abc',
          debug: false,
        },
      };

      const tokenized = tokenizePII(original, context);
      const restored = detokenizePII(tokenized, context);

      expect(restored).toEqual(original);
    });

    it('tokenizes arrays containing objects with sensitive fields', () => {
      const data = {
        users: [
          { name: 'Alice', password: 'pass1' },
          { name: 'Bob', password: 'pass2' },
        ],
      };
      const result = tokenizePII(data, context) as {
        users: Array<{ name: string; password: string }>;
      };

      expect(result.users[0].name).toBe('Alice');
      expect(result.users[0].password).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
      expect(result.users[1].name).toBe('Bob');
      expect(result.users[1].password).toMatch(/\[SENSITIVE_FIELD:TOKEN_[A-F0-9]+\]/);
    });

    it('includes SENSITIVE_FIELD in token stats', () => {
      tokenizePII(
        {
          password: 'secret1',
          token: 'secret2',
          email: 'test@example.com',
        },
        context
      );

      const stats = getTokenStats(context);

      expect(stats.total).toBe(3);
      expect(stats.byType[PIIType.SENSITIVE_FIELD]).toBe(2);
      expect(stats.byType[PIIType.EMAIL]).toBe(1);
    });
  });
});
