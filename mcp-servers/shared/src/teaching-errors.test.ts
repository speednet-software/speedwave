import { describe, it, expect } from 'vitest';
import { teachingErrorResult, clampPageSize } from './teaching-errors.js';

describe('teachingErrorResult', () => {
  it('composes param name, received value, and next step', () => {
    const result = teachingErrorResult({
      paramName: 'issue_id',
      received: 99999,
      nextStep: 'List valid issues via listIssueIds first.',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid issue_id');
    expect(result.content[0].text).toContain('99999');
    expect(result.content[0].text).toContain('List valid issues via listIssueIds first.');
  });

  it('includes the correct-value tool name when provided', () => {
    const result = teachingErrorResult({
      paramName: 'issue_id',
      received: 99999,
      correctValueTool: 'listIssueIds',
      nextStep: 'Retry with a valid id.',
    });

    expect(result.content[0].text).toContain('Get a valid value from listIssueIds.');
  });

  it('omits the correct-value-tool sentence when not provided', () => {
    const result = teachingErrorResult({
      paramName: 'service',
      received: 'unknownservice',
      nextStep: 'Use one of the known services.',
    });

    expect(result.content[0].text).not.toContain('Get a valid value from');
  });

  it('summarizes a string received value with quotes', () => {
    const result = teachingErrorResult({
      paramName: 'detail_level',
      received: 'fullSchema',
      nextStep: 'Use names_only, with_descriptions, or full_schema.',
    });

    expect(result.content[0].text).toContain('"fullSchema"');
  });

  it('summarizes undefined and null received values', () => {
    expect(
      teachingErrorResult({ paramName: 'query', received: undefined, nextStep: 'x' }).content[0]
        .text
    ).toContain('undefined');
    expect(
      teachingErrorResult({ paramName: 'query', received: null, nextStep: 'x' }).content[0].text
    ).toContain('null');
  });

  it('summarizes an object received value as JSON', () => {
    const result = teachingErrorResult({
      paramName: 'filter',
      received: { foo: 'bar' },
      nextStep: 'x',
    });

    expect(result.content[0].text).toContain('{"foo":"bar"}');
  });

  it('falls back to String() when JSON.stringify throws (circular reference)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = teachingErrorResult({ paramName: 'filter', received: circular, nextStep: 'x' });

    expect(result.content[0].text).toContain('[object Object]');
  });
});

describe('clampPageSize', () => {
  it('returns the value when within bounds', () => {
    expect(clampPageSize(25, 10, 100)).toBe(25);
  });

  it('floors a fractional value', () => {
    expect(clampPageSize(25.9, 10, 100)).toBe(25);
  });

  it('caps at max when value exceeds it', () => {
    expect(clampPageSize(500, 10, 100)).toBe(100);
  });

  it('floors at 1 when value is zero or negative', () => {
    expect(clampPageSize(0, 10, 100)).toBe(1);
    expect(clampPageSize(-5, 10, 100)).toBe(1);
  });

  it('returns default when value is undefined', () => {
    expect(clampPageSize(undefined, 10, 100)).toBe(10);
  });

  it('returns default when value is NaN', () => {
    expect(clampPageSize(NaN, 10, 100)).toBe(10);
  });

  it('returns default when value is a non-numeric string', () => {
    expect(clampPageSize('abc', 10, 100)).toBe(10);
  });

  it('coerces a numeric string', () => {
    expect(clampPageSize('42', 10, 100)).toBe(42);
  });

  it('returns default when value is null', () => {
    expect(clampPageSize(null, 10, 100)).toBe(10);
  });

  it('returns default for Infinity (not finite)', () => {
    expect(clampPageSize(Infinity, 10, 100)).toBe(10);
    expect(clampPageSize(-Infinity, 10, 100)).toBe(10);
  });
});
