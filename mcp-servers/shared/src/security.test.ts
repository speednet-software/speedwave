import { describe, it, expect } from 'vitest';
import {
  validateJSONRPCMessage,
  validateParams,
  validateSessionId,
  validateToolName,
  validateWorkerUrl,
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

    it('accepts names exactly 100 characters', () => {
      const exactName = 'a'.repeat(99);
      expect(validateToolName(exactName)).toBe(true);
    });
  });

  describe('validateWorkerUrl', () => {
    it('accepts core container worker URLs', () => {
      expect(validateWorkerUrl('http://mcp-slack:4001')).toBe(true);
      expect(validateWorkerUrl('http://mcp-gitlab:4004')).toBe(true);
    });

    it('accepts addon container worker URLs', () => {
      expect(validateWorkerUrl('http://mcp-presale:4006')).toBe(true);
      expect(validateWorkerUrl('http://mcp-my-addon:5000')).toBe(true);
    });

    it('accepts minimal valid container URL', () => {
      expect(validateWorkerUrl('http://mcp-a:1')).toBe(true);
    });

    it('accepts max port', () => {
      expect(validateWorkerUrl('http://mcp-a1b2c3:65535')).toBe(true);
    });

    it('accepts macOS host gateway', () => {
      expect(validateWorkerUrl('http://host.lima.internal:4007')).toBe(true);
    });

    it('accepts Linux host gateway', () => {
      expect(validateWorkerUrl('http://host.docker.internal:4007')).toBe(true);
    });

    it('accepts Windows host gateway', () => {
      expect(validateWorkerUrl('http://host.speedwave.internal:4007')).toBe(true);
    });

    it('accepts host.containers.internal gateway', () => {
      expect(validateWorkerUrl('http://host.containers.internal:4007')).toBe(true);
    });

    it('rejects cloud metadata endpoint', () => {
      expect(validateWorkerUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    });

    it('rejects IPv4 loopback', () => {
      expect(validateWorkerUrl('http://127.0.0.1:4001')).toBe(false);
    });

    it('rejects IPv6 loopback', () => {
      expect(validateWorkerUrl('http://[::1]:4001')).toBe(false);
    });

    it('rejects unspecified address', () => {
      expect(validateWorkerUrl('http://0.0.0.0:4001')).toBe(false);
    });

    it('rejects raw private IP', () => {
      expect(validateWorkerUrl('http://192.168.1.1:4001')).toBe(false);
    });

    it('rejects external hostname', () => {
      expect(validateWorkerUrl('http://evil.example.com:4001')).toBe(false);
    });

    it('rejects https protocol', () => {
      expect(validateWorkerUrl('https://mcp-slack:4001')).toBe(false);
    });

    it('rejects ftp protocol', () => {
      expect(validateWorkerUrl('ftp://mcp-slack:4001')).toBe(false);
    });

    it('rejects container URL without port', () => {
      expect(validateWorkerUrl('http://mcp-slack')).toBe(false);
    });

    it('rejects host gateway without port', () => {
      expect(validateWorkerUrl('http://host.lima.internal')).toBe(false);
    });

    it('rejects trailing hyphen in hostname', () => {
      expect(validateWorkerUrl('http://mcp-:4001')).toBe(false);
    });

    it('rejects hostname not starting with mcp-', () => {
      expect(validateWorkerUrl('http://-mcp:4001')).toBe(false);
    });

    it('rejects uppercase hostname', () => {
      expect(validateWorkerUrl('http://MCP-SLACK:4001')).toBe(false);
    });

    it('rejects underscore in hostname', () => {
      expect(validateWorkerUrl('http://mcp_slack:4001')).toBe(false);
    });

    it('rejects space in hostname', () => {
      expect(validateWorkerUrl('http://mcp slack:4001')).toBe(false);
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
      expect(validateWorkerUrl('http://mcp-slack:4001/admin')).toBe(false);
    });

    it('rejects query string', () => {
      expect(validateWorkerUrl('http://mcp-slack:4001?redirect=http://evil.com')).toBe(false);
    });

    it('rejects hostname not on allowlist', () => {
      expect(validateWorkerUrl('http://host.other.internal:4001')).toBe(false);
    });

    it('rejects URL with auth credentials', () => {
      expect(validateWorkerUrl('http://user:pass@mcp-slack:4001')).toBe(false);
    });
  });
});
