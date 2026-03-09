import { describe, it, expect } from 'vitest';
import { addAutoReturn } from './auto-return.js';

describe('addAutoReturn (AST-based)', () => {
  // Podstawowe przypadki
  it('adds return to simple expression', () => {
    expect(addAutoReturn('42').code).toBe('return 42');
  });

  it('adds return to await expression', () => {
    expect(addAutoReturn('await fn()').code).toBe('return await fn()');
  });

  it('removes trailing semicolon', () => {
    expect(addAutoReturn('42;').code).toBe('return 42');
  });

  // Wieloliniowe
  it('handles multiline object literal', () => {
    const input = `({
  x: 1,
  y: 2
})`;
    expect(addAutoReturn(input).code).toMatch(/^return \({/);
  });

  it('handles multiline await with object', () => {
    const input = `await fn({
  x: 1
})`;
    expect(addAutoReturn(input).code).toMatch(/^return await fn/);
  });

  // Nie dodaje return
  it('preserves explicit return', () => {
    expect(addAutoReturn('return 42').code).toBe('return 42');
  });

  it('parses top-level return without error (sourceType: script)', () => {
    // This test verifies the fix for 'return' outside of function error
    // With sourceType: 'module', this would fail parsing
    // With sourceType: 'script', this parses correctly
    const result = addAutoReturn('return 42');
    expect(result.code).toBe('return 42');
    expect(result.parseError).toBeUndefined();
  });

  it('parses top-level return with complex expression', () => {
    const result = addAutoReturn('return await fn({ x: 1 })');
    expect(result.code).toBe('return await fn({ x: 1 })');
    expect(result.parseError).toBeUndefined();
  });

  it('does not add return to const', () => {
    expect(addAutoReturn('const x = 1;').code).toBe('const x = 1;');
  });

  it('does not add return to let', () => {
    expect(addAutoReturn('let x = 1;').code).toBe('let x = 1;');
  });

  it('does not add return to if', () => {
    const input = 'if (true) { x() }';
    expect(addAutoReturn(input).code).toBe(input);
  });

  it('does not add return to for', () => {
    const input = 'for (let i = 0; i < 3; i++) {}';
    expect(addAutoReturn(input).code).toBe(input);
  });

  // Wiele statementów
  it('adds return only to last expression in multiple statements', () => {
    const input = 'const x = 1;\nx + 1';
    expect(addAutoReturn(input).code).toBe('const x = 1;\nreturn x + 1');
  });

  // Edge cases
  it('handles empty code', () => {
    expect(addAutoReturn('').code).toBe('');
  });

  it('handles whitespace-only', () => {
    expect(addAutoReturn('   ').code).toBe('   ');
  });

  it('handles string with return keyword', () => {
    // AST poprawnie rozpoznaje że "return" jest w stringu
    expect(addAutoReturn('"return value"').code).toBe('return "return value"');
  });

  it('handles string with parentheses', () => {
    // AST poprawnie parsuje nawiasy w stringu
    expect(addAutoReturn('"test ({"').code).toBe('return "test ({"');
  });

  it('handles comments', () => {
    const input = '// comment\n42';
    expect(addAutoReturn(input).code).toBe('// comment\nreturn 42');
  });

  // Dodatkowe edge cases
  it('handles template literal with return keyword', () => {
    expect(addAutoReturn('`return ${x}`').code).toBe('return `return ${x}`');
  });

  it('handles regex with return keyword', () => {
    expect(addAutoReturn('/return/g').code).toBe('return /return/g');
  });

  it('adds return to arrow function expression', () => {
    expect(addAutoReturn('(() => 42)').code).toBe('return (() => 42)');
  });

  it('adds return to arrow function call', () => {
    expect(addAutoReturn('(() => 42)()').code).toBe('return (() => 42)()');
  });

  it('does not add return to function declaration', () => {
    const input = 'function foo() { return 1 }';
    expect(addAutoReturn(input).code).toBe(input);
  });

  it('does not add return to class declaration', () => {
    const input = 'class Foo {}';
    expect(addAutoReturn(input).code).toBe(input);
  });

  it('handles nested await', () => {
    expect(addAutoReturn('await (await fn())').code).toBe('return await (await fn())');
  });

  it('handles chained await', () => {
    expect(addAutoReturn('await fn().then(x => x)').code).toBe('return await fn().then(x => x)');
  });

  // AST parse error recovery - now returns parseError
  it('should return original code and parseError on syntax error', () => {
    const result = addAutoReturn('const x = {');
    expect(result.code).toBe('const x = {');
    expect(result.parseError).toBeDefined();
    expect(result.parseError).toContain('Unexpected token');
  });

  it('should return original code and parseError on incomplete expression', () => {
    const result = addAutoReturn('await fn(1, 2,');
    expect(result.code).toBe('await fn(1, 2,');
    expect(result.parseError).toBeDefined();
  });

  // Success cases should NOT have parseError
  it('should not have parseError on success', () => {
    const result = addAutoReturn('42');
    expect(result.code).toBe('return 42');
    expect(result.parseError).toBeUndefined();
  });
});
