import { describe, it, expect } from 'vitest';
import { parseTemplate, parseCategories, parseCustomPatterns } from './template-schema.js';
import { PIIType } from './types.js';

const ALL_TRUE = {
  EMAIL: true,
  PHONE_PL: true,
  PESEL: true,
  NIP: true,
  IBAN: true,
  CARD: true,
  API_KEY: true,
  SENSITIVE_FIELD: true,
};

function validTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'gdpr-art32',
    name: 'GDPR Art. 32',
    description: 'EU PII protection',
    categories: ALL_TRUE,
    customPatterns: [],
    sensitiveKeys: { add: [], remove: [] },
    ...overrides,
  };
}

describe('parseCategories', () => {
  it('accepts an exhaustive, all-boolean categories object', () => {
    expect(parseCategories(ALL_TRUE, 'ctx')).toEqual(ALL_TRUE);
  });

  it('rejects a missing category', () => {
    const { SENSITIVE_FIELD, ...missing } = ALL_TRUE;
    expect(() => parseCategories(missing, 'ctx')).toThrow(/missing required key "SENSITIVE_FIELD"/);
  });

  it('rejects an unknown category', () => {
    expect(() => parseCategories({ ...ALL_TRUE, BOGUS: true }, 'ctx')).toThrow(/unknown key/);
  });

  it('rejects a non-boolean category value', () => {
    expect(() => parseCategories({ ...ALL_TRUE, EMAIL: 'yes' }, 'ctx')).toThrow(/EMAIL must be a boolean/);
  });

  it('rejects a non-object', () => {
    expect(() => parseCategories(null, 'ctx')).toThrow(/must be an object/);
    expect(() => parseCategories([], 'ctx')).toThrow(/must be an object/);
  });
});

describe('parseCustomPatterns', () => {
  it('accepts an empty array', () => {
    expect(parseCustomPatterns([], 'ctx')).toEqual([]);
  });

  it('accepts a well-formed custom pattern', () => {
    const rule = {
      id: 'EMPLOYEE_ID',
      displayName: 'Employee ID',
      pattern: '\\bEMP-\\d{4,8}\\b',
      caseInsensitive: false,
      forced: false,
    };
    expect(parseCustomPatterns([rule], 'ctx')).toEqual([rule]);
  });

  it('rejects a non-array', () => {
    expect(() => parseCustomPatterns({}, 'ctx')).toThrow(/must be an array/);
  });

  it('rejects an id not matching the uppercase-snake pattern', () => {
    expect(() =>
      parseCustomPatterns(
        [{ id: 'employee-id', displayName: 'x', pattern: 'abc', caseInsensitive: false, forced: false }],
        'ctx'
      )
    ).toThrow(/must match/);
  });

  it('rejects an id colliding with a built-in PIIType', () => {
    expect(() =>
      parseCustomPatterns(
        [{ id: PIIType.EMAIL, displayName: 'x', pattern: 'abc', caseInsensitive: false, forced: false }],
        'ctx'
      )
    ).toThrow(/collides with a built-in PIIType/);
  });

  it('rejects duplicate ids', () => {
    const rule = { id: 'DUP_ID', displayName: 'x', pattern: 'abc', caseInsensitive: false, forced: false };
    expect(() => parseCustomPatterns([rule, { ...rule }], 'ctx')).toThrow(/duplicated/);
  });

  it('rejects a missing displayName', () => {
    expect(() =>
      parseCustomPatterns(
        [{ id: 'X_ID', displayName: '', pattern: 'abc', caseInsensitive: false, forced: false }],
        'ctx'
      )
    ).toThrow(/displayName/);
  });

  it('rejects a missing pattern', () => {
    expect(() =>
      parseCustomPatterns(
        [{ id: 'X_ID', displayName: 'x', pattern: '', caseInsensitive: false, forced: false }],
        'ctx'
      )
    ).toThrow(/pattern/);
  });

  it('rejects a non-boolean caseInsensitive', () => {
    expect(() =>
      parseCustomPatterns(
        [{ id: 'X_ID', displayName: 'x', pattern: 'abc', caseInsensitive: 'no', forced: false }],
        'ctx'
      )
    ).toThrow(/caseInsensitive/);
  });

  it('rejects a non-boolean forced', () => {
    expect(() =>
      parseCustomPatterns(
        [{ id: 'X_ID', displayName: 'x', pattern: 'abc', caseInsensitive: false, forced: 'no' }],
        'ctx'
      )
    ).toThrow(/forced/);
  });

  it('rejects a non-object entry', () => {
    expect(() => parseCustomPatterns(['nope'], 'ctx')).toThrow(/must be an object/);
  });
});

describe('parseTemplate', () => {
  it('parses a well-formed template', () => {
    const template = validTemplate();
    expect(parseTemplate(template)).toEqual({
      version: 1,
      id: 'gdpr-art32',
      name: 'GDPR Art. 32',
      description: 'EU PII protection',
      categories: ALL_TRUE,
      customPatterns: [],
      sensitiveKeys: { add: [], remove: [] },
    });
  });

  it('rejects a non-object', () => {
    expect(() => parseTemplate(null)).toThrow(/must be an object/);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseTemplate(validTemplate({ version: 2 }))).toThrow(/unsupported version/);
  });

  it('rejects an id not matching the template id pattern', () => {
    expect(() => parseTemplate(validTemplate({ id: 'GDPR' }))).toThrow(/must match/);
  });

  it('rejects the reserved id "custom"', () => {
    expect(() => parseTemplate(validTemplate({ id: 'custom' }))).toThrow(/reserved/);
  });

  it('rejects a missing name', () => {
    expect(() => parseTemplate(validTemplate({ name: '' }))).toThrow(/name/);
  });

  it('rejects a non-string description', () => {
    expect(() => parseTemplate(validTemplate({ description: 42 }))).toThrow(/description/);
  });

  it.each(['inherit', 'attachments', 'scope'])(
    'rejects the deprecated field "%s" with a schema-version-1 message',
    (field) => {
      expect(() => parseTemplate(validTemplate({ [field]: {} }))).toThrow(
        /not supported in schema version 1/
      );
    }
  );

  it('rejects malformed sensitiveKeys', () => {
    expect(() => parseTemplate(validTemplate({ sensitiveKeys: { add: [1], remove: [] } }))).toThrow(
      /must be an array of strings/
    );
  });

  it('rejects a missing sensitiveKeys', () => {
    const { sensitiveKeys, ...rest } = validTemplate();
    expect(() => parseTemplate(rest)).toThrow(/sensitiveKeys must be an object/);
  });

  it('defaults customPatterns to an empty array when omitted', () => {
    const { customPatterns, ...rest } = validTemplate();
    expect(parseTemplate(rest).customPatterns).toEqual([]);
  });

  it('defaults sensitiveKeys.add/remove to empty arrays when omitted', () => {
    const template = parseTemplate(validTemplate({ sensitiveKeys: {} }));
    expect(template.sensitiveKeys).toEqual({ add: [], remove: [] });
  });
});
