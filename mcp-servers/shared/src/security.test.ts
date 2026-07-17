import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validateJSONRPCMessage,
  validateOrigin,
  validateParams,
  validateSessionId,
  validateToolName,
  validateWorkerUrl,
  loadToken,
  loadTokenFile,
  loadPluginSettings,
  PLUGIN_SETTINGS_FILE,
  tokensDir,
  BASE_SAFE_ENV_KEYS,
} from './security.js';

describe('security', () => {
  describe('validateJSONRPCMessage', () => {
    it('validates correct request with method and id', () => {
      const message = {
        jsonrpc: '2.0',
        method: 'test',
        id: 1,
      };
      expect(validateJSONRPCMessage(message)).toBe(true);
    });

    it('validates notification (method without id)', () => {
      const message = {
        jsonrpc: '2.0',
        method: 'notify',
      };
      expect(validateJSONRPCMessage(message)).toBe(true);
    });

    it('rejects notification with invalid params', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'notify',
          params: 'injected',
        })
      ).toBe(false);
    });

    it('validates response with result', () => {
      const message = {
        jsonrpc: '2.0',
        result: { data: 'test' },
        id: 1,
      };
      expect(validateJSONRPCMessage(message)).toBe(true);
    });

    it('validates response with error', () => {
      const message = {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: 1,
      };
      expect(validateJSONRPCMessage(message)).toBe(true);
    });

    it('rejects null body', () => {
      expect(validateJSONRPCMessage(null)).toBe(false);
    });

    it('rejects non-object body', () => {
      expect(validateJSONRPCMessage('string')).toBe(false);
      expect(validateJSONRPCMessage(123)).toBe(false);
    });

    it('rejects wrong jsonrpc version', () => {
      const message = {
        jsonrpc: '1.0',
        method: 'test',
        id: 1,
      };
      expect(validateJSONRPCMessage(message)).toBe(false);
    });

    it('rejects missing jsonrpc field', () => {
      const message = {
        method: 'test',
        id: 1,
      };
      expect(validateJSONRPCMessage(message)).toBe(false);
    });

    it('rejects message without method or result/error', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
      };
      expect(validateJSONRPCMessage(message)).toBe(false);
    });

    it('rejects non-string method', () => {
      const message = {
        jsonrpc: '2.0',
        method: 123,
        id: 1,
      };
      expect(validateJSONRPCMessage(message)).toBe(false);
    });

    it('rejects invalid id type', () => {
      const message = {
        jsonrpc: '2.0',
        method: 'test',
        id: { invalid: true },
      };
      expect(validateJSONRPCMessage(message)).toBe(false);
    });

    it('accepts string id', () => {
      const message = {
        jsonrpc: '2.0',
        method: 'test',
        id: 'string-id',
      };
      expect(validateJSONRPCMessage(message)).toBe(true);
    });

    it('accepts message with object params', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'test',
          id: 1,
          params: { key: 'value' },
        })
      ).toBe(true);
    });

    it('accepts message without params field (optional)', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'test',
          id: 1,
        })
      ).toBe(true);
    });

    it('rejects message with string params', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'test',
          id: 1,
          params: 'not-an-object',
        })
      ).toBe(false);
    });

    it('rejects message with number params', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'test',
          id: 1,
          params: 42,
        })
      ).toBe(false);
    });

    it('rejects message with boolean params', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'test',
          id: 1,
          params: true,
        })
      ).toBe(false);
    });

    it('rejects message with null params', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'test',
          id: 1,
          params: null,
        })
      ).toBe(false);
    });

    it('rejects excessively long method names (>200 chars)', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'a'.repeat(201),
          id: 1,
        })
      ).toBe(false);
    });

    it('accepts method names at boundary (200 chars)', () => {
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          method: 'a'.repeat(200),
          id: 1,
        })
      ).toBe(true);
    });

    it('accepts response with result field but no id field (branch: id not in message)', () => {
      // Covers the false branch of `if ('id' in message)` — a valid response with
      // result/error but without an id property (unusual but valid per JSON-RPC)
      expect(
        validateJSONRPCMessage({
          jsonrpc: '2.0',
          result: { data: 'ok' },
        })
      ).toBe(true);
    });
  });

  describe('validateParams', () => {
    it('accepts undefined (params absent)', () => {
      expect(validateParams(undefined)).toBe(true);
    });

    it('accepts empty object', () => {
      expect(validateParams({})).toBe(true);
    });

    it('accepts object with properties', () => {
      expect(validateParams({ name: 'test', value: 42 })).toBe(true);
    });

    it('accepts arrays (valid per JSON-RPC 2.0 spec)', () => {
      expect(validateParams([1, 2, 3])).toBe(true);
    });

    it('rejects null', () => {
      expect(validateParams(null)).toBe(false);
    });

    it('rejects string', () => {
      expect(validateParams('string')).toBe(false);
    });

    it('rejects number', () => {
      expect(validateParams(123)).toBe(false);
    });

    it('rejects boolean', () => {
      expect(validateParams(true)).toBe(false);
    });
  });

  describe('validateSessionId', () => {
    it('validates correct UUID v4', () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      expect(validateSessionId(validUUID)).toBe(true);
    });

    it('validates UUID with uppercase letters', () => {
      const validUUID = '550E8400-E29B-41D4-A716-446655440000';
      expect(validateSessionId(validUUID)).toBe(true);
    });

    it('validates UUID with mixed case', () => {
      const validUUID = '550e8400-E29B-41d4-A716-446655440000';
      expect(validateSessionId(validUUID)).toBe(true);
    });

    it('rejects invalid UUID format', () => {
      expect(validateSessionId('invalid-uuid')).toBe(false);
      expect(validateSessionId('550e8400-e29b-31d4-a716-446655440000')).toBe(false); // v3 not v4
      expect(validateSessionId('')).toBe(false);
      expect(validateSessionId('550e8400e29b41d4a716446655440000')).toBe(false); // missing dashes
    });

    it('rejects UUID with wrong segment lengths', () => {
      expect(validateSessionId('550e840-e29b-41d4-a716-446655440000')).toBe(false); // first segment too short
      expect(validateSessionId('550e84000-e29b-41d4-a716-446655440000')).toBe(false); // first segment too long
      expect(validateSessionId('550e8400-e29-41d4-a716-446655440000')).toBe(false); // second segment too short
      expect(validateSessionId('550e8400-e29b-41d-a716-446655440000')).toBe(false); // third segment too short
      expect(validateSessionId('550e8400-e29b-41d4-a71-446655440000')).toBe(false); // fourth segment too short
      expect(validateSessionId('550e8400-e29b-41d4-a716-44665544000')).toBe(false); // last segment too short
    });

    it('rejects UUID with invalid characters', () => {
      expect(validateSessionId('550e8400-e29b-41d4-a716-44665544000g')).toBe(false); // 'g' is invalid
      expect(validateSessionId('550e8400-e29b-41d4-a716-44665544000!')).toBe(false); // special char
      expect(validateSessionId('550e8400-e29b-41d4-a716-44665544000 ')).toBe(false); // trailing space
      expect(validateSessionId(' 550e8400-e29b-41d4-a716-446655440000')).toBe(false); // leading space
    });

    it('rejects non-v4 UUID versions', () => {
      expect(validateSessionId('550e8400-e29b-11d4-a716-446655440000')).toBe(false); // v1
      expect(validateSessionId('550e8400-e29b-21d4-a716-446655440000')).toBe(false); // v2
      expect(validateSessionId('550e8400-e29b-31d4-a716-446655440000')).toBe(false); // v3
      expect(validateSessionId('550e8400-e29b-51d4-a716-446655440000')).toBe(false); // v5
    });

    it('rejects null and undefined', () => {
      expect(validateSessionId(null as unknown as string)).toBe(false);
      expect(validateSessionId(undefined as unknown as string)).toBe(false);
    });

    it('rejects non-string types', () => {
      expect(validateSessionId(12345 as unknown as string)).toBe(false);
      expect(validateSessionId({} as unknown as string)).toBe(false);
      expect(validateSessionId([] as unknown as string)).toBe(false);
    });

    it('validates variant bits (8, 9, a, b)', () => {
      expect(validateSessionId('550e8400-e29b-41d4-8716-446655440000')).toBe(true); // variant 8
      expect(validateSessionId('550e8400-e29b-41d4-9716-446655440000')).toBe(true); // variant 9
      expect(validateSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true); // variant a
      expect(validateSessionId('550e8400-e29b-41d4-b716-446655440000')).toBe(true); // variant b
    });
  });

  describe('validateToolName', () => {
    it('validates alphanumeric names', () => {
      expect(validateToolName('get_channels')).toBe(true);
      expect(validateToolName('send-message')).toBe(true);
      expect(validateToolName('tool123')).toBe(true);
      expect(validateToolName('MyTool')).toBe(true);
    });

    it('rejects empty names', () => {
      expect(validateToolName('')).toBe(false);
    });

    it('rejects names with special characters', () => {
      expect(validateToolName('tool name')).toBe(false); // space
      expect(validateToolName('tool.name')).toBe(false); // dot
      expect(validateToolName('tool/name')).toBe(false); // slash
      expect(validateToolName('tool;ls')).toBe(false); // semicolon (injection)
      expect(validateToolName('tool$(cmd)')).toBe(false); // command substitution
    });

    it('rejects names over 100 characters', () => {
      const longName = 'a'.repeat(101);
      expect(validateToolName(longName)).toBe(false);
    });

    it('accepts names at max length (99 characters)', () => {
      const exactName = 'a'.repeat(99);
      expect(validateToolName(exactName)).toBe(true);
    });
  });

  describe('validateWorkerUrl', () => {
    it('accepts core container worker URLs', () => {
      // ADR-038: all workers share PORT_WORKER (3000) internally.
      expect(validateWorkerUrl('http://mcp-slack:3000')).toBe(true);
      expect(validateWorkerUrl('http://mcp-gitlab:3000')).toBe(true);
    });

    it('accepts plugin worker URLs', () => {
      // Plugins also use PORT_WORKER; URLs differ only by DNS service name.
      expect(validateWorkerUrl('http://mcp-example-plugin:3000')).toBe(true);
      expect(validateWorkerUrl('http://mcp-my-addon:3000')).toBe(true);
    });

    it('accepts minimal valid container URL', () => {
      expect(validateWorkerUrl('http://mcp-a:1')).toBe(true);
    });

    it('accepts max port', () => {
      expect(validateWorkerUrl('http://mcp-a1b2c3:65535')).toBe(true);
    });

    it('accepts canonical host gateway alias', () => {
      expect(validateWorkerUrl('http://host.docker.internal:4007')).toBe(true);
    });

    // Regression negatives — deprecated aliases removed in the SSOT consolidation.
    it('rejects deprecated host.lima.internal', () => {
      expect(validateWorkerUrl('http://host.lima.internal:4007')).toBe(false);
    });

    it('rejects deprecated host.speedwave.internal', () => {
      expect(validateWorkerUrl('http://host.speedwave.internal:4007')).toBe(false);
    });

    it('rejects deprecated host.containers.internal', () => {
      expect(validateWorkerUrl('http://host.containers.internal:4007')).toBe(false);
    });

    it('rejects cloud metadata endpoint', () => {
      expect(validateWorkerUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    });

    it('rejects IPv4 loopback', () => {
      expect(validateWorkerUrl('http://127.0.0.1:3000')).toBe(false);
    });

    it('rejects IPv6 loopback', () => {
      expect(validateWorkerUrl('http://[::1]:3000')).toBe(false);
    });

    it('rejects unspecified address', () => {
      expect(validateWorkerUrl('http://0.0.0.0:3000')).toBe(false);
    });

    it('rejects raw private IP', () => {
      expect(validateWorkerUrl('http://192.168.1.1:3000')).toBe(false);
    });

    it('rejects external hostname', () => {
      expect(validateWorkerUrl('http://evil.example.com:3000')).toBe(false);
    });

    it('rejects https protocol', () => {
      expect(validateWorkerUrl('https://mcp-slack:3000')).toBe(false);
    });

    it('rejects ftp protocol', () => {
      expect(validateWorkerUrl('ftp://mcp-slack:3000')).toBe(false);
    });

    it('rejects container URL without port', () => {
      expect(validateWorkerUrl('http://mcp-slack')).toBe(false);
    });

    it('rejects host gateway without port', () => {
      expect(validateWorkerUrl('http://host.docker.internal')).toBe(false);
    });

    it('rejects trailing hyphen in hostname', () => {
      expect(validateWorkerUrl('http://mcp-:3000')).toBe(false);
    });

    it('rejects hostname not starting with mcp-', () => {
      expect(validateWorkerUrl('http://-mcp:3000')).toBe(false);
    });

    it('rejects uppercase hostname', () => {
      expect(validateWorkerUrl('http://MCP-SLACK:3000')).toBe(false);
    });

    it('rejects underscore in hostname', () => {
      expect(validateWorkerUrl('http://mcp_slack:3000')).toBe(false);
    });

    it('rejects space in hostname', () => {
      expect(validateWorkerUrl('http://mcp slack:3000')).toBe(false);
    });

    it('rejects port 0', () => {
      expect(validateWorkerUrl('http://mcp-a:0')).toBe(false);
    });

    it('rejects port > 65535', () => {
      expect(validateWorkerUrl('http://mcp-a:65536')).toBe(false);
    });

    it('rejects unparseable string', () => {
      expect(validateWorkerUrl('not-a-url')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateWorkerUrl('')).toBe(false);
    });

    it('rejects pathname beyond /', () => {
      expect(validateWorkerUrl('http://mcp-slack:3000/admin')).toBe(false);
    });

    it('rejects query string', () => {
      expect(validateWorkerUrl('http://mcp-slack:3000?redirect=http://evil.com')).toBe(false);
    });

    it('rejects hostname not on allowlist', () => {
      expect(validateWorkerUrl('http://host.other.internal:3000')).toBe(false);
    });

    it('rejects URL with auth credentials', () => {
      expect(validateWorkerUrl('http://user:pass@mcp-slack:3000')).toBe(false);
    });

    it('rejects URL with fragment', () => {
      expect(validateWorkerUrl('http://mcp-slack:3000#frag')).toBe(false);
    });

    it('rejects URL with password but no username (password !== ""  branch)', () => {
      // Covers the second part of: parsed.username !== '' || parsed.password !== ''
      // URL spec: `http://:password@mcp-slack:3000` sets empty username and non-empty password
      expect(validateWorkerUrl('http://:secret@mcp-slack:3000')).toBe(false);
    });
  });

  describe('validateOrigin', () => {
    it('allows missing origin (non-browser client)', () => {
      expect(validateOrigin(undefined, ['http://localhost:3000'])).toBe(true);
    });

    it('allows valid origin in allowlist', () => {
      expect(validateOrigin('http://localhost:3000', ['http://localhost:3000'])).toBe(true);
    });

    it('rejects origin not in allowlist', () => {
      expect(validateOrigin('http://evil.com', ['http://localhost:3000'])).toBe(false);
    });

    it('rejects origin when allowlist is empty', () => {
      expect(validateOrigin('http://localhost:3000', [])).toBe(false);
    });

    it('matches second origin in allowlist', () => {
      expect(
        validateOrigin('http://localhost:4000', ['http://localhost:3000', 'http://localhost:4000'])
      ).toBe(true);
    });

    it('requires exact match (trailing slash matters)', () => {
      expect(validateOrigin('http://localhost:3000/', ['http://localhost:3000'])).toBe(false);
      expect(validateOrigin('http://localhost:3000', ['http://localhost:3000/'])).toBe(false);
    });

    it('allows null origin (treated as falsy, same as missing)', () => {
      expect(validateOrigin(null as unknown as undefined, ['http://localhost:3000'])).toBe(true);
    });

    it('rejects empty string origin (present but empty)', () => {
      expect(validateOrigin('', ['http://localhost:3000'])).toBe(false);
    });

    it('rejects origin when allowedOrigins is undefined', () => {
      expect(validateOrigin('http://localhost:3000')).toBe(false);
    });

    it('allows missing origin when allowedOrigins is undefined', () => {
      expect(validateOrigin(undefined)).toBe(true);
    });
  });

  describe('loadToken', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns trimmed token content on success', async () => {
      const { default: fs } = await import('fs/promises');
      vi.spyOn(fs, 'readFile').mockResolvedValue('  my-token-value\n  ' as unknown as Uint8Array);

      const result = await loadToken('/tokens/test/token');
      expect(result).toBe('my-token-value');
    });

    it('throws with ENOENT message when token file is not found', async () => {
      const { default: fs } = await import('fs/promises');
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      const caught = await loadToken('/tokens/missing/token').catch((e: Error) => e);
      expect(caught.message).toBe('Token file not found: /tokens/missing/token');
      // Cause-forwarding regression guard: mcp-context7's loadOptionalApiKey
      // relies on `e.cause.code === 'ENOENT'` to fall back to anonymous mode.
      expect((caught.cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    });

    it('throws with EACCES message when permission is denied', async () => {
      const { default: fs } = await import('fs/promises');
      const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      const caught = await loadToken('/tokens/protected/token').catch((e: Error) => e);
      expect(caught.message).toBe('Permission denied reading token file: /tokens/protected/token');
      expect((caught.cause as NodeJS.ErrnoException).code).toBe('EACCES');
    });

    it('throws with EISDIR message when path is a directory', async () => {
      const { default: fs } = await import('fs/promises');
      const err = Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
      vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      const caught = await loadToken('/tokens/dir/').catch((e: Error) => e);
      expect(caught.message).toBe('Token path is a directory, not a file: /tokens/dir/');
      expect((caught.cause as NodeJS.ErrnoException).code).toBe('EISDIR');
    });

    it('throws generic message for unknown error codes (e.g. EIO)', async () => {
      const { default: fs } = await import('fs/promises');
      const err = Object.assign(new Error('Input/output error'), { code: 'EIO' });
      vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      const caught = await loadToken('/tokens/broken/token').catch((e: Error) => e);
      expect(caught.message).toBe(
        'Failed to read token file: /tokens/broken/token (Input/output error)'
      );
      expect((caught.cause as NodeJS.ErrnoException).code).toBe('EIO');
    });

    it('throws generic message for non-Error thrown values', async () => {
      const { default: fs } = await import('fs/promises');
      // Non-Error object with no .code — goes to the catch-else branch and String() fallback
      vi.spyOn(fs, 'readFile').mockRejectedValue('raw string error');

      await expect(loadToken('/tokens/raw/token')).rejects.toThrow(
        'Failed to read token file: /tokens/raw/token (raw string error)'
      );
    });
  });

  describe('tokensDir', () => {
    const original = process.env.TOKENS_DIR;
    afterEach(() => {
      if (original === undefined) delete process.env.TOKENS_DIR;
      else process.env.TOKENS_DIR = original;
    });

    it('defaults to /tokens when TOKENS_DIR is unset', () => {
      delete process.env.TOKENS_DIR;
      expect(tokensDir()).toBe('/tokens');
    });

    it('defaults to /tokens when TOKENS_DIR is empty', () => {
      process.env.TOKENS_DIR = '';
      expect(tokensDir()).toBe('/tokens');
    });

    it('returns TOKENS_DIR when set', () => {
      process.env.TOKENS_DIR = '/custom/tokens';
      expect(tokensDir()).toBe('/custom/tokens');
    });
  });

  describe('loadTokenFile', () => {
    const original = process.env.TOKENS_DIR;
    afterEach(() => {
      vi.restoreAllMocks();
      if (original === undefined) delete process.env.TOKENS_DIR;
      else process.env.TOKENS_DIR = original;
    });

    it('joins the default tokens dir with the file name and trims', async () => {
      delete process.env.TOKENS_DIR;
      const { default: fs } = await import('fs/promises');
      const spy = vi
        .spyOn(fs, 'readFile')
        .mockResolvedValue('  bot-xyz\n' as unknown as Uint8Array);

      const result = await loadTokenFile('bot_token');
      expect(result).toBe('bot-xyz');
      expect(spy).toHaveBeenCalledWith('/tokens/bot_token', 'utf-8');
    });

    it('honours a custom TOKENS_DIR', async () => {
      process.env.TOKENS_DIR = '/custom';
      const { default: fs } = await import('fs/promises');
      const spy = vi.spyOn(fs, 'readFile').mockResolvedValue('k' as unknown as Uint8Array);

      await loadTokenFile('api_key');
      expect(spy).toHaveBeenCalledWith('/custom/api_key', 'utf-8');
    });

    it('forwards the errno cause from loadToken on ENOENT', async () => {
      delete process.env.TOKENS_DIR;
      const { default: fs } = await import('fs/promises');
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      const caught = await loadTokenFile('missing').catch((e: Error) => e);
      expect(caught.message).toBe('Token file not found: /tokens/missing');
      expect((caught.cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    });
  });

  describe('loadPluginSettings', () => {
    const original = process.env.TOKENS_DIR;
    afterEach(() => {
      vi.restoreAllMocks();
      if (original === undefined) delete process.env.TOKENS_DIR;
      else process.env.TOKENS_DIR = original;
    });

    it('reads and parses the settings file from the tokens dir', async () => {
      delete process.env.TOKENS_DIR;
      const { default: fs } = await import('fs/promises');
      const spy = vi
        .spyOn(fs, 'readFile')
        .mockResolvedValue('{"scope":"read","pageSize":50}' as unknown as Uint8Array);

      const settings = await loadPluginSettings();
      expect(settings).toEqual({ scope: 'read', pageSize: 50 });
      expect(spy).toHaveBeenCalledWith(`/tokens/${PLUGIN_SETTINGS_FILE}`, 'utf-8');
    });

    it('honours a custom TOKENS_DIR', async () => {
      process.env.TOKENS_DIR = '/custom';
      const { default: fs } = await import('fs/promises');
      const spy = vi.spyOn(fs, 'readFile').mockResolvedValue('{}' as unknown as Uint8Array);

      await loadPluginSettings();
      expect(spy).toHaveBeenCalledWith(`/custom/${PLUGIN_SETTINGS_FILE}`, 'utf-8');
    });

    it('returns an empty object when the settings file is absent (ENOENT)', async () => {
      delete process.env.TOKENS_DIR;
      const { default: fs } = await import('fs/promises');
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      expect(await loadPluginSettings()).toEqual({});
    });

    it('throws on a non-ENOENT read error', async () => {
      delete process.env.TOKENS_DIR;
      const { default: fs } = await import('fs/promises');
      const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      vi.spyOn(fs, 'readFile').mockRejectedValue(err);

      const caught = await loadPluginSettings().catch((e: Error) => e);
      expect(caught.message).toBe(
        'Failed to read plugin settings file: /tokens/_settings.json (EACCES)'
      );
      expect((caught.cause as NodeJS.ErrnoException).code).toBe('EACCES');
    });

    it('throws when the settings file is not valid JSON', async () => {
      delete process.env.TOKENS_DIR;
      const { default: fs } = await import('fs/promises');
      vi.spyOn(fs, 'readFile').mockResolvedValue('not json' as unknown as Uint8Array);

      const caught = await loadPluginSettings().catch((e: Error) => e);
      expect(caught.message).toMatch(
        /Plugin settings file is not valid JSON: \/tokens\/_settings\.json/
      );
    });
  });

  describe('BASE_SAFE_ENV_KEYS', () => {
    it('is the exact 14-key core shared by every worker', () => {
      expect(BASE_SAFE_ENV_KEYS).toEqual([
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TMPDIR',
        'TMP',
        'TEMP',
        'DEVELOPER_DIR',
        'SDKROOT',
        '__CF_USER_TEXT_ENCODING',
      ]);
    });

    it('carries no secret-bearing keys', () => {
      for (const key of BASE_SAFE_ENV_KEYS) {
        expect(key).not.toMatch(/AUTH_TOKEN|API_KEY|SECRET|PASSWORD/i);
        expect(key.startsWith('MCP_')).toBe(false);
      }
    });
  });
});
