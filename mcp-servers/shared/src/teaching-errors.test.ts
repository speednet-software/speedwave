import { describe, it, expect } from 'vitest';
import {
  teachingErrorResult,
  teachingToolResult,
  clampPageSize,
  missingParamResult,
  MAX_RECEIVED_LENGTH,
} from './teaching-errors.js';

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

  it('caps an oversized received string at MAX_RECEIVED_LENGTH with a marker', () => {
    const huge = 'a'.repeat(MAX_RECEIVED_LENGTH + 500);
    const text = teachingErrorResult({ paramName: 'query', received: huge, nextStep: 'x' })
      .content[0].text as string;

    expect(text).toContain('...');
    expect(text).not.toContain('a'.repeat(MAX_RECEIVED_LENGTH + 1));
    expect(text).toContain('a'.repeat(MAX_RECEIVED_LENGTH - 1));
  });

  it('does not truncate a received value at or below the cap', () => {
    const exact = 'b'.repeat(MAX_RECEIVED_LENGTH - 2);
    const text = teachingErrorResult({ paramName: 'query', received: exact, nextStep: 'x' })
      .content[0].text as string;

    expect(text).toContain(`"${exact}"`);
    expect(text).not.toContain('...');
  });
});

describe('missingParamResult', () => {
  it('builds a MISSING_PARAM teaching ToolResult', () => {
    const result = missingParamResult('channel', undefined, 'Provide a channel.');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAM');
    expect(result.error?.message).toContain('Invalid channel');
    expect(result.error?.message).toContain('Provide a channel.');
  });

  it('echoes an empty-string received value', () => {
    const result = missingParamResult('ts', '', 'Provide a ts.');

    expect(result.error?.message).toContain('received: ""');
  });
});

describe('teachingToolResult', () => {
  it('shares identical message text with teachingErrorResult (no Error: prefix games)', () => {
    const params = {
      paramName: 'issue_id',
      received: 99999,
      correctValueTool: 'listIssueIds',
      nextStep: 'Retry with a valid id.',
    };

    const errorEnvelope = teachingErrorResult(params);
    const toolEnvelope = teachingToolResult(params);

    const errorText = errorEnvelope.content[0].text as string;
    expect(errorText).toBe(`Error: ${toolEnvelope.error?.message}`);
  });

  it('defaults the error code to INVALID_PARAM', () => {
    const result = teachingToolResult({
      paramName: 'query',
      received: undefined,
      nextStep: 'Provide a query.',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAM');
  });

  it('accepts a custom error code', () => {
    const result = teachingToolResult(
      { paramName: 'channel', received: '', nextStep: 'Provide a channel.' },
      'MISSING_PARAM'
    );

    expect(result.error?.code).toBe('MISSING_PARAM');
  });

  it('omits the correct-value-tool sentence and matches teachingErrorResult wording', () => {
    const params = {
      paramName: 'service',
      received: 'unknownservice',
      nextStep: 'Use one of the known services.',
    };

    const result = teachingToolResult(params, 'INVALID_ID');

    expect(result.error?.message).not.toContain('Get a valid value from');
    expect(result.error?.message).toBe(
      (teachingErrorResult(params).content[0].text as string).replace(/^Error: /, '')
    );
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

  it('returns default when value is zero or negative', () => {
    expect(clampPageSize(0, 10, 100)).toBe(10);
    expect(clampPageSize(-5, 10, 100)).toBe(10);
  });

  it('returns default for a zero or negative numeric string', () => {
    expect(clampPageSize('0', 50, 100)).toBe(50);
    expect(clampPageSize('-3', 50, 100)).toBe(50);
  });

  it('floors a positive fractional below 1 up to 1', () => {
    expect(clampPageSize(0.5, 10, 100)).toBe(1);
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

  it('applies no upper ceiling when max is omitted', () => {
    expect(clampPageSize(5000, 100)).toBe(5000);
    expect(clampPageSize('250', 100)).toBe(250);
  });

  it('still floors and defaults when max is omitted', () => {
    expect(clampPageSize(25.9, 100)).toBe(25);
    expect(clampPageSize(0, 100)).toBe(100);
    expect(clampPageSize(0.5, 100)).toBe(1);
  });
});
