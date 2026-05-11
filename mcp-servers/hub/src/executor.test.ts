import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import {
  executeCode,
  _setBridgesForTesting,
  _formatErrorMessage,
  _deriveAuditCategory,
} from './executor.js';
import {
  TOOL_REGISTRY,
  resetServiceCaches,
  stopBackgroundRefresh,
  _setServiceNamesForTesting,
} from './tool-registry.js';
import {
  populateRegistryWithMockTools,
  _resetRegistryForTesting,
  createMockBridges,
} from './test-helpers.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Code Executor
//
// Purpose: Test sandbox execution (security and basic functionality)
// - Verify security restrictions (forbidden patterns)
// - Verify basic code execution without tool dependencies
//
// Note: These tests focus on code validation and security.
// Full integration tests with tool availability, audit logging, and PII tokenization
// are tested separately with proper mocking/fixtures to avoid bridge initialization issues.
//═══════════════════════════════════════════════════════════════════════════════

describe('executor', () => {
  beforeAll(() => {
    _resetRegistryForTesting();
    populateRegistryWithMockTools();
  });

  afterAll(() => {
    stopBackgroundRefresh();
  });

  describe('security restrictions', () => {
    it('should reject code with eval', async () => {
      const code = `
        eval('console.log("hello")');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('eval');
    });

    it('should reject code with Function constructor', async () => {
      const code = `
        const fn = new Function('return 1');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('Function');
    });

    it('should reject code with require', async () => {
      const code = `
        const fs = require('fs');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('require');
    });

    it('should reject code accessing process', async () => {
      const code = `
        console.log(process.env);
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('process');
    });

    it('should reject code accessing globalThis', async () => {
      const code = `
        console.log(globalThis);
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('globalThis');
    });

    it('should reject code with dynamic import', async () => {
      const code = `
        const module = await import('./something');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('import');
    });

    it('should reject code accessing fs', async () => {
      const code = `
        const content = fs.readFileSync('/etc/passwd');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('fs');
    });

    it('should reject code accessing net', async () => {
      const code = `
        const server = net.createServer();
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('net');
    });

    it('should reject code accessing http', async () => {
      const code = `
        http.get('http://example.com');
        return {};
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('http');
    });

    it('should enforce timeout on async operations', async () => {
      _setBridgesForTesting(createMockBridges());

      // Note: Synchronous infinite loops cannot be interrupted by Promise.race timeout
      // This tests async timeout which is the realistic scenario
      const code = `
        await new Promise(resolve => setTimeout(resolve, 5000));
        return { done: true };
      `;

      const result = await executeCode({ code, timeoutMs: 50 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toContain('timeout');

      _setBridgesForTesting(null);
    }, 1000);
  });

  describe('code validation only (no bridge required)', () => {
    it('should validate eval pattern', async () => {
      const code = `eval('1 + 1')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('eval');
    });

    it('should validate Function pattern', async () => {
      const code = `new Function('return 1')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Function');
    });

    it('should validate require pattern', async () => {
      const code = `require('fs')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('require');
    });

    it('should validate dynamic import pattern', async () => {
      const code = `import('./module')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('import');
    });

    it('should validate process access', async () => {
      const code = `process.env.PATH`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('process');
    });

    it('should validate globalThis access', async () => {
      const code = `globalThis.console`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('globalThis');
    });

    it('should validate global access', async () => {
      const code = `global.toString()`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('global');
    });

    it('should validate __dirname access', async () => {
      const code = `console.log(__dirname)`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('__dirname');
    });

    it('should validate __filename access', async () => {
      const code = `console.log(__filename)`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('__filename');
    });

    it('should validate child_process access', async () => {
      const code = `child_process.exec('ls')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('child_process');
    });

    it('should validate fs access', async () => {
      const code = `fs.readFileSync('/etc/passwd')`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('fs');
    });
  });

  describe('prototype chain traversal prevention', () => {
    it('should reject .constructor access', async () => {
      const code = `({}).constructor.constructor('return this')()`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('constructor');
    });

    it('should reject .__proto__ access', async () => {
      const code = `({}).__proto__`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('__proto__');
    });

    it('should reject Object.getPrototypeOf', async () => {
      const code = `Object.getPrototypeOf({})`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('getPrototypeOf');
    });

    it('should reject Object.setPrototypeOf', async () => {
      const code = `Object.setPrototypeOf({}, null)`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('setPrototypeOf');
    });

    it('should reject Proxy constructor', async () => {
      const code = `new Proxy({}, {})`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('Proxy');
    });

    it('should reject Reflect API', async () => {
      const code = `Reflect.ownKeys({})`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('Reflect');
    });

    it('should reject Reflect.construct bypass', async () => {
      const code = `Reflect.construct(Array, [1, 2, 3])`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('Reflect');
    });

    it('should reject async function constructor chain', async () => {
      const code = `(async()=>{}).constructor('return this')()`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('constructor');
    });

    it('should reject array method constructor chain', async () => {
      const code = `[].find.constructor('return this')()`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('constructor');
    });

    it('should reject bracket-notation constructor access', async () => {
      const code = `({})["constructor"]["constructor"]("return this")()`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('constructor');
    });

    it('should reject bracket-notation __proto__ access', async () => {
      const code = `({})["__proto__"]`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('__proto__');
    });

    it('should reject bracket-notation prototype access', async () => {
      const code = `Object["prototype"]`;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.message).toContain('prototype');
    });

    it('should allow legitimate orchestration code after new patterns', async () => {
      const code = `
        const x = 1 + 2;
        const arr = [1, 2, 3].map(n => n * 2);
        return { sum: x, doubled: arr };
      `;
      const result = await executeCode({ code, timeoutMs: 1000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ sum: 3, doubled: [2, 4, 6] });
    });
  });

  describe('smart error enhancement', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;

    beforeEach(() => {
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,gitlab,os';
      _setBridgesForTesting(createMockBridges());
    });

    afterEach(() => {
      _setBridgesForTesting(null);
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      resetServiceCaches();
    });

    it('should show available methods when calling non-existent function', async () => {
      const code = `await redmine.listProjects()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toContain('listProjects is not a function');
      expect(result.error?.message).toContain('Available redmine methods');
      expect(result.error?.message).toContain('listIssueIds');
      expect(result.error?.message).toContain('updateIssue');
    });

    it('should show available methods for gitlab when calling non-existent function', async () => {
      const code = `await gitlab.getRepositories()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('getRepositories is not a function');
      expect(result.error?.message).toContain('Available gitlab methods');
      expect(result.error?.message).toContain('listProjectIds');
    });

    it('should show available methods when underscore method does not match any real method', async () => {
      const code = `slack_nonExistentMethod()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toContain('slack_nonExistentMethod is not defined');
      expect(result.error?.message).toContain('Use dot notation');
      expect(result.error?.message).toContain('Available methods');
    });
  });

  describe('formatErrorMessage', () => {
    it('should handle string message from Error', () => {
      const error = new Error('Simple error');
      expect(_formatErrorMessage(error)).toBe('Simple error');
    });

    it('should handle object message (GitBeaker style)', () => {
      // GitBeaker sometimes returns errors with object messages
      const error = new Error('ignored');
      (error as unknown as { message: object }).message = {
        error: 'API failed',
        details: 'Invalid token',
      };
      expect(_formatErrorMessage(error)).toBe('{"error":"API failed","details":"Invalid token"}');
    });

    it('should handle plain object error', () => {
      const error = { code: 'ERR', reason: 'timeout' };
      expect(_formatErrorMessage(error)).toBe('{"code":"ERR","reason":"timeout"}');
    });

    it('should return "Unknown error" for empty Error message', () => {
      const error = new Error();
      error.message = '';
      expect(_formatErrorMessage(error)).toBe('Unknown error');
    });

    it('should handle string primitive', () => {
      expect(_formatErrorMessage('string error')).toBe('string error');
    });

    it('should handle number primitive', () => {
      expect(_formatErrorMessage(42)).toBe('42');
    });

    it('should handle null', () => {
      expect(_formatErrorMessage(null)).toBe('null');
    });

    it('should handle undefined', () => {
      expect(_formatErrorMessage(undefined)).toBe('undefined');
    });

    it('should handle nested object message', () => {
      const error = new Error('ignored');
      (error as unknown as { message: object }).message = {
        response: {
          status: 400,
          body: { message: 'Bad Request' },
        },
      };
      const result = _formatErrorMessage(error);
      expect(result).toContain('400');
      expect(result).toContain('Bad Request');
    });
  });

  // Note: sanitizeParamsForLogging tests removed - functionality moved to PII Tokenizer
  // Sensitive data protection for Claude is handled by pii-tokenizer.ts (SENSITIVE_FIELD type)
  // Local Docker logs are not sanitized as they don't leave the container

  describe('batch helper (through executeCode)', () => {
    beforeEach(() => {
      _setBridgesForTesting(createMockBridges());
    });

    afterEach(() => {
      _setBridgesForTesting(null);
    });

    it('should return results and errors separately for partial failures', async () => {
      const code = `
        const promises = [
          Promise.resolve({ id: 1 }),
          Promise.reject(new Error('Failed')),
          Promise.resolve({ id: 3 }),
        ];
        return await batch(promises);
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('results');
      expect(result.data).toHaveProperty('errors');
      expect((result.data as { results: unknown[] }).results).toHaveLength(2);
      expect((result.data as { errors: unknown[] }).errors).toHaveLength(1);
    });

    it('should return all results when no failures', async () => {
      const code = `
        const promises = [
          Promise.resolve({ id: 1 }),
          Promise.resolve({ id: 2 }),
          Promise.resolve({ id: 3 }),
        ];
        return await batch(promises);
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect((result.data as { results: unknown[] }).results).toHaveLength(3);
      expect((result.data as { errors: unknown[] }).errors).toHaveLength(0);
    });

    it('should include error index for failed operations', async () => {
      const code = `
        const promises = [
          Promise.resolve({ id: 1 }),
          Promise.reject(new Error('Second failed')),
        ];
        return await batch(promises);
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      const errors = (result.data as { errors: Array<{ index: number; error: string }> }).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(1);
      expect(errors[0].error).toContain('Second failed');
    });
  });

  describe('plugin service in sandbox', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;

    beforeEach(() => {
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,presale';
    });

    afterEach(() => {
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      resetServiceCaches();
    });

    it('should include plugin service tools in sandbox context', async () => {
      // Register a plugin service in the registry
      const { TOOL_REGISTRY, SERVICE_NAMES } = await import('./tool-registry.js');
      const mutableRegistry = TOOL_REGISTRY as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      mutableRegistry['presale'] = {
        searchCustomers: {
          name: 'searchCustomers',
          service: 'presale',
          description: 'Search CRM customers',
          inputSchema: { type: 'object', properties: {} },
          keywords: [],
          example: '',
          deferLoading: false,
        },
      };

      // Set up mock bridges
      const mockBridges = createMockBridges();
      mockBridges['presale'] = null;
      mockBridges['os'] = null;
      _setBridgesForTesting(mockBridges);

      // Code that accesses the sandbox to check what's available
      const code = `typeof presale`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      // presale is in sandbox but has no bridge, so it's undefined
      expect(result.success).toBe(true);
      expect(result.data).toBe('undefined');

      // Cleanup
      delete mutableRegistry['presale'];
      _setBridgesForTesting(null);
    });
  });

  describe('auto-return transformation', () => {
    // These tests verify that the auto-return transformation correctly prepends
    // 'return' to expressions without causing syntax errors.
    // We test using pure JavaScript that doesn't require HTTP bridges.

    it('should handle multiline expression with object parameter', async () => {
      // Simulates: await sharepoint.sync({ local_path: "/path", mode: "pull" });
      // The multiline object literal should not break the auto-return transformation
      const code = `({
        local_path: "/path",
        mode: "pull"
      })`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ local_path: '/path', mode: 'pull' });
    });

    it('should handle single-line expression (regression test)', async () => {
      const code = `1 + 2`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(3);
    });

    it('should not add return to const declarations', async () => {
      const code = `const x = 42;`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      // const doesn't return a value, result is undefined
      expect(result.data).toBeUndefined();
    });

    it('should preserve explicit return', async () => {
      const code = `return 42;`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(42);
    });

    it('should handle multiline with nested objects', async () => {
      const code = `({
        local_path: "/path",
        options: {
          mode: "pull",
          delete: true
        }
      })`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        local_path: '/path',
        options: { mode: 'pull', delete: true },
      });
    });

    it('should handle empty code', async () => {
      const code = ``;
      const result = await executeCode({ code, timeoutMs: 5000 });
      // Empty code should not crash
      expect(result.success).toBe(true);
    });

    it('should handle whitespace-only code', async () => {
      const code = `   \n   `;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
    });

    it('should handle multiline async await expression', async () => {
      // This simulates the actual failing case: multiline await with object param
      const code = `await Promise.resolve({
        success: true,
        data: "test"
      })`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ success: true, data: 'test' });
    });

    it('should handle array expression', async () => {
      const code = `[
        "item1",
        "item2",
        "item3"
      ]`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual(['item1', 'item2', 'item3']);
    });

    it('should handle multiple statements and return last one', async () => {
      const code = `const x = 1;
        const y = 2;
        x + y`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(3);
    });

    it('should handle code with leading comment', async () => {
      const code = `// This is a comment
        42`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(42);
    });

    it('should handle multiline const with await', async () => {
      const code = `const result = await Promise.resolve({
        success: true
      });`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      // const doesn't return, result is undefined
      expect(result.data).toBeUndefined();
    });

    it('should not add return to if statement', async () => {
      const code = `if (true) { 42 }`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      // if statement doesn't return a value
      expect(result.data).toBeUndefined();
    });

    it('should not add return to for loop', async () => {
      const code = `for (let i = 0; i < 3; i++) { i }`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it('should not add return to while loop', async () => {
      const code = `while (false) { 1 }`;
      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });
  });

  describe('deriveAuditCategory', () => {
    it('returns READ for readOnlyHint tools', () => {
      const mutableRegistry = TOOL_REGISTRY as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      mutableRegistry['testSvc'] = {
        listItems: {
          name: 'listItems',
          service: 'testSvc',
          description: 'List items',
          inputSchema: { type: 'object', properties: {} },
          keywords: [],
          example: '',
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      };
      expect(_deriveAuditCategory('testSvc', 'listItems')).toBe('READ');
      delete mutableRegistry['testSvc'];
    });

    it('returns DELETE for destructiveHint tools', () => {
      const mutableRegistry = TOOL_REGISTRY as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      mutableRegistry['testSvc'] = {
        deleteItem: {
          name: 'deleteItem',
          service: 'testSvc',
          description: 'Delete item',
          inputSchema: { type: 'object', properties: {} },
          keywords: [],
          example: '',
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      };
      expect(_deriveAuditCategory('testSvc', 'deleteItem')).toBe('DELETE');
      delete mutableRegistry['testSvc'];
    });

    it('returns WRITE for non-readonly non-destructive tools', () => {
      const mutableRegistry = TOOL_REGISTRY as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      mutableRegistry['testSvc'] = {
        createItem: {
          name: 'createItem',
          service: 'testSvc',
          description: 'Create item',
          inputSchema: { type: 'object', properties: {} },
          keywords: [],
          example: '',
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
      };
      expect(_deriveAuditCategory('testSvc', 'createItem')).toBe('WRITE');
      delete mutableRegistry['testSvc'];
    });

    it('returns WRITE when annotations are absent (safe default)', () => {
      expect(_deriveAuditCategory('nonexistent', 'noMethod')).toBe('WRITE');
    });
  });

  describe('initializeBridges error path', () => {
    it('re-throws and logs when initializeAllBridges fails', async () => {
      const { initializeBridges, _setBridgesForTesting } = await import('./executor.js');
      const { initializeAllBridges } = await import('./http-bridge.js');

      // Reset bridge state so initializeBridges runs (bridgesInitialized = false)
      _setBridgesForTesting(null);

      vi.spyOn(initializeAllBridges as never, 'call').mockRejectedValue(new Error('bridge boom'));
      // Mock the actual module function via vi.mock override inside test — use a spy on the module
      const httpBridgeModule = await import('./http-bridge.js');
      const spy = vi
        .spyOn(httpBridgeModule, 'initializeAllBridges')
        .mockRejectedValue(new Error('bridge boom'));

      await expect(initializeBridges()).rejects.toThrow('bridge boom');

      spy.mockRestore();
      _setBridgesForTesting(null);
    });

    it('returns immediately when bridges are already initialized (early-return branch)', async () => {
      const { initializeBridges, _setBridgesForTesting } = await import('./executor.js');
      const httpBridgeModule = await import('./http-bridge.js');

      // Pre-mark bridges as initialized
      _setBridgesForTesting(createMockBridges());

      const spy = vi.spyOn(httpBridgeModule, 'initializeAllBridges');

      // Should return without calling initializeAllBridges
      await initializeBridges();

      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
      _setBridgesForTesting(null);
    });
  });

  describe('sandbox console wrappers', () => {
    beforeEach(() => {
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,gitlab,os';
      _setBridgesForTesting(createMockBridges());
    });

    afterEach(() => {
      _setBridgesForTesting(null);
      delete process.env.ENABLED_SERVICES;
      resetServiceCaches();
    });

    it('sandbox console.log routes to host console.log', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const code = `console.log('test log'); return 0;`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[sandbox]'), 'test log');

      logSpy.mockRestore();
    });

    it('sandbox console.warn routes to host console.warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const code = `console.warn('test warning'); return 1;`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[sandbox]'), 'test warning');

      warnSpy.mockRestore();
    });

    it('sandbox console.error routes to host console.error', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const code = `console.error('test error'); return 2;`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[sandbox]'), 'test error');

      errorSpy.mockRestore();
    });
  });

  describe('auto-return parse error path (syntax warning)', () => {
    it('warns and continues execution when addAutoReturn returns a parseError', async () => {
      // Code with a syntax error — addAutoReturn will fail to parse and
      // return { code, parseError: '...' }, which triggers the syntaxWarning branch.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Deliberately malformed code (unclosed brace) — addAutoReturn cannot parse it
      // but the execution attempt will fail with a runtime error, which is fine.
      const code = `const x = {`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      // Whether success or failure, the warn branch was reached
      const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
      const syntaxWarnEmitted = warnMessages.some((m) => m.includes('[executor]'));
      expect(syntaxWarnEmitted).toBe(true);

      warnSpy.mockRestore();
      // The result is expected to fail (syntax error in JS)
      expect(result.success).toBe(false);
    });
  });

  describe('audit context log body and tool wrappers', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;
    const workerUrls: Record<string, string | undefined> = {};
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      // Save and set worker URLs so callWorker can resolve the service URL
      const services = ['slack', 'sharepoint', 'redmine', 'gitlab', 'os'];
      for (let i = 0; i < services.length; i++) {
        const key = `WORKER_${services[i].toUpperCase()}_URL`;
        workerUrls[key] = process.env[key];
        process.env[key] = `http://mcp-${services[i]}:${3001 + i}`;
      }
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,gitlab,os';
      _setBridgesForTesting(createMockBridges());
      // Save original fetch
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      // Restore fetch
      globalThis.fetch = originalFetch;
      _setBridgesForTesting(null);
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      for (const [key, val] of Object.entries(workerUrls)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
      resetServiceCaches();
    });

    it('audit log is written when a service tool is called', async () => {
      // Mock fetch to return a successful JSON-RPC tool result
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          jsonrpc: '2.0',
          id: 'test',
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
        }),
        text: async () => '',
      }) as unknown as typeof fetch;

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const code = `return await slack.sendChannel({ channel: 'general', text: 'hello' });`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(true);
      // Audit log is emitted via console.log with "[READ]", "[WRITE]", or "[DELETE]"
      const auditCallFound = logSpy.mock.calls.some((args) =>
        String(args[0]).match(/\[(READ|WRITE|DELETE)\]/)
      );
      expect(auditCallFound).toBe(true);

      logSpy.mockRestore();
    });

    it('wrapBridgeCall error path: re-throws with service prefix', async () => {
      // Mock fetch to throw a network error so callWorker propagates it through wrapBridgeCall
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

      const code = `return await slack.sendChannel({ channel: 'general', text: 'hello' });`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('slack: network down');
    });

    it('logErrorDebug: logs stack trace in development mode', async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      // Mock fetch to throw an Error with a stack so logErrorDebug logs it in dev mode
      const bridgeError = new Error('dev mode error');
      globalThis.fetch = vi.fn().mockRejectedValue(bridgeError) as unknown as typeof fetch;

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const code = `return await slack.sendChannel({ channel: 'test' });`;
      await executeCode({ code, timeoutMs: 5000 });

      // In dev mode, error.stack is logged separately as a second console.error call
      const stackLogged = errorSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes('Error: dev mode error'))
      );
      expect(stackLogged).toBe(true);

      process.env.NODE_ENV = savedNodeEnv;
      errorSpy.mockRestore();
    });

    it('logErrorDebug: logs non-Error objects in production mode', async () => {
      // Mock fetch to throw a plain string (not an Error instance)
      globalThis.fetch = vi.fn().mockRejectedValue('plain string error') as unknown as typeof fetch;

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const code = `return await slack.sendChannel({ channel: 'test' });`;
      await executeCode({ code, timeoutMs: 5000 });

      // The non-Error branch in logErrorDebug logs the value directly as the last arg
      const plainErrorLogged = errorSpy.mock.calls.some((args) =>
        args.some((a) => a === 'plain string error')
      );
      expect(plainErrorLogged).toBe(true);

      errorSpy.mockRestore();
    });
  });

  describe('createToolWrappers disabled service branch (line 395)', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;

    afterEach(() => {
      _setBridgesForTesting(null);
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      resetServiceCaches();
      // Restore SERVICE_NAMES to the original mock set
      _setServiceNamesForTesting(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });

    it('skips a service in SERVICE_NAMES that is not in ENABLED_SERVICES', async () => {
      // Service 'os' is in SERVICE_NAMES (via _setServiceNamesForTesting) but NOT in ENABLED_SERVICES.
      // createToolWrappers must hit the `if (!enabled.has(service)) continue` branch for 'os'.
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack';
      // Add 'os' to SERVICE_NAMES even though it is not enabled
      _setServiceNamesForTesting(['slack', 'os']);
      _setBridgesForTesting(createMockBridges());

      // Simple code that accesses 'slack' — 'os' should not appear in the sandbox
      const code = `typeof os`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(true);
      // 'os' is not in ENABLED_SERVICES so it is excluded from tools context
      expect(result.data).toBe('undefined');
    });
  });

  describe('batch helper — non-Error rejection', () => {
    beforeEach(() => {
      _setBridgesForTesting(createMockBridges());
    });

    afterEach(() => {
      _setBridgesForTesting(null);
    });

    it('converts non-Error rejection to string in errors array', async () => {
      // Line 450: String(result.reason) when rejected value is not an Error instance
      const code = `
        const promises = [
          Promise.resolve({ id: 1 }),
          Promise.reject('plain string rejection'),
        ];
        return await batch(promises);
      `;

      const result = await executeCode({ code, timeoutMs: 5000 });
      expect(result.success).toBe(true);
      const errors = (result.data as { errors: Array<{ index: number; error: string }> }).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toBe('plain string rejection');
    });
  });

  describe('executeCode catch block — non-Error thrown value', () => {
    beforeEach(() => {
      _setBridgesForTesting(createMockBridges());
    });

    afterEach(() => {
      _setBridgesForTesting(null);
    });

    it('uses "Unknown execution error" when caught value is not an Error', async () => {
      // Line 569 branch: `error instanceof Error ? error.message : 'Unknown execution error'`
      // Throw a plain string from the sandbox to exercise the non-Error path.
      const code = `throw 'a plain string error';`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      // The non-Error catch path produces 'Unknown execution error' as the base message
      expect(result.error?.message).toBe('Unknown execution error');
    });
  });

  describe('smart error — notFunctionMatch when service not in sandbox', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;

    afterEach(() => {
      _setBridgesForTesting(null);
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      resetServiceCaches();
      _setServiceNamesForTesting(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });

    it('falls through to generic error when the identified service is not in sandbox', async () => {
      // `someService.nonExistent is not a function` — `someService` is not a known service
      // in the sandbox, so the `if (serviceTools && typeof serviceTools === 'object')` branch
      // evaluates to false (serviceTools is undefined). Lines 587-592 are the falsy path.
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack';
      _setBridgesForTesting(createMockBridges());

      // 'unknownSvc' is not in the sandbox, so serviceTools is undefined
      const code = `const unknownSvc = null; unknownSvc.nonExistent()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      // Generic sanitized error (no "Available methods" suggestion because service unknown)
      expect(result.error?.message).not.toContain('Available');
    });
  });

  describe('smart error — underscore match when service not in sandbox', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;

    afterEach(() => {
      _setBridgesForTesting(null);
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      resetServiceCaches();
      _setServiceNamesForTesting(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });

    it('falls through when underscore-split service is not in sandbox', async () => {
      // Line 608: underscoreMatch found, but sandboxContext[serviceName] is undefined/falsy.
      // Use a name like `ghost_method` where `ghost` is not a service in the sandbox.
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack';
      _setBridgesForTesting(createMockBridges());

      // `ghost_method` → serviceName='ghost', methodName='method'
      // sandboxContext['ghost'] is undefined → the `if (serviceTools && ...)` is false
      const code = `ghost_method()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      // The underscore handler couldn't find 'ghost' in the sandbox, so it does not add hints
      expect(result.error?.message).toContain('ghost_method is not defined');
    });
  });

  describe('audit context params fallback (lines 199-204)', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;
    const workerUrls: Record<string, string | undefined> = {};
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      const services = ['slack', 'sharepoint', 'redmine', 'gitlab', 'os'];
      for (let i = 0; i < services.length; i++) {
        const key = `WORKER_${services[i].toUpperCase()}_URL`;
        workerUrls[key] = process.env[key];
        process.env[key] = `http://mcp-${services[i]}:${3001 + i}`;
      }
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,gitlab,os';
      _setBridgesForTesting(createMockBridges());
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      _setBridgesForTesting(null);
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      for (const [key, val] of Object.entries(workerUrls)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
      resetServiceCaches();
    });

    it('audit log uses empty object fallback when params is undefined', async () => {
      // Call a tool WITHOUT arguments so params is undefined in the wrapWithAudit callback.
      // This exercises the `params ?? {}` branches at lines 199 and 204.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          jsonrpc: '2.0',
          id: 'test',
          result: { content: [{ type: 'text', text: JSON.stringify([]) }] },
        }),
        text: async () => '',
      }) as unknown as typeof fetch;

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Call a tool with no arguments — params will be undefined in wrapWithAudit
      const code = `return await slack.listChannelIds();`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(true);
      // Audit log was emitted with empty params {}
      const auditCallFound = logSpy.mock.calls.some((args) =>
        String(args[0]).match(/\[(READ|WRITE|DELETE)\].*\(\{\}\)/)
      );
      expect(auditCallFound).toBe(true);

      logSpy.mockRestore();
    });
  });

  describe('underscore notation with multi-part service name (while loop)', () => {
    const savedEnabledServices = process.env.ENABLED_SERVICES;
    const savedWorkerUrl = process.env.WORKER_MY_SERVICE_URL;

    beforeEach(() => {
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,gitlab,os';
      _setBridgesForTesting(createMockBridges());
    });

    afterEach(() => {
      _setBridgesForTesting(null);
      if (savedEnabledServices === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabledServices;
      }
      if (savedWorkerUrl === undefined) {
        delete process.env.WORKER_MY_SERVICE_URL;
      } else {
        process.env.WORKER_MY_SERVICE_URL = savedWorkerUrl;
      }
      resetServiceCaches();
      // Restore SERVICE_NAMES to the original mock set
      _setServiceNamesForTesting(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });

    it('iterates serviceName parts to find the real service when it contains underscores', async () => {
      // Register a service with an underscore in the name so that the while loop
      // inside the underscore error handler has to iterate to find the right split.
      const mutableRegistry = TOOL_REGISTRY as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      mutableRegistry['my_service'] = {
        doThing: {
          name: 'doThing',
          service: 'my_service',
          description: 'Do something',
          inputSchema: { type: 'object', properties: {} },
          keywords: [],
          example: '',
          deferLoading: false,
        },
      };

      // Add my_service to SERVICE_NAMES so createToolWrappers includes it in the sandbox context.
      // buildServiceBridge needs _registry['my_service'] to exist (set above).
      _setServiceNamesForTesting(['slack', 'sharepoint', 'redmine', 'gitlab', 'os', 'my_service']);

      // Set a worker URL so callWorker doesn't throw "Unknown service: my_service".
      // (The URL doesn't need to be reachable — the code under test never actually calls
      // my_service.doThing(); it only produces a ReferenceError for my_service_doThing.)
      process.env.WORKER_MY_SERVICE_URL = 'http://mcp-my-service:9999';
      process.env.ENABLED_SERVICES = 'slack,my_service';
      resetServiceCaches();

      // This triggers the `XXX_YYY is not defined` handler.
      // The greedy regex first captures `my` as serviceName and `service_doThing` as methodName.
      // The while loop iterates: serviceName+='_service', methodName='doThing' — now found in
      // sandboxContext because my_service is in SERVICE_NAMES and enabled.
      // Because `doThing` is a camelCase match in `my_service`, it hits the camelMethod branch.
      const code = `my_service_doThing()`;
      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      // Should show "Did you mean: my_service.doThing()?"
      expect(result.error?.message).toContain('Did you mean');
      expect(result.error?.message).toContain('my_service.doThing');

      delete mutableRegistry['my_service'];
    });
  });
});
