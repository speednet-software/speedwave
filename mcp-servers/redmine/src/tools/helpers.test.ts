/**
 * Tests for Redmine helpers — resolveParams and MappingError
 */

import { describe, it, expect } from 'vitest';
import { resolveParams, MappingError, MAPPABLE_FIELDS } from './helpers.js';
import type { RedmineMappings } from '../client.js';

// ── Fixture mappings used across tests ────────────────────────────────────────

const fullMappings: RedmineMappings = {
  status_new: 1,
  status_in_progress: 2,
  status_resolved: 3,
  priority_low: 1,
  priority_normal: 2,
  priority_high: 3,
  tracker_bug: 1,
  tracker_feature: 2,
  activity_development: 1,
  activity_testing: 2,
};

// ── MappingError ──────────────────────────────────────────────────────────────

describe('MappingError', () => {
  it('constructs with correct name, field, value and availableValues', () => {
    const err = new MappingError('status', 'unknown', ['new', 'in_progress']);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MappingError);
    expect(err.name).toBe('MappingError');
    expect(err.field).toBe('status');
    expect(err.value).toBe('unknown');
    expect(err.availableValues).toEqual(['new', 'in_progress']);
    expect(err.message).toContain('Unknown status');
    expect(err.message).toContain('"unknown"');
    expect(err.message).toContain('new, in_progress');
  });

  it('lists "none configured" when availableValues is empty', () => {
    const err = new MappingError('priority', 'critical', []);

    expect(err.message).toContain('none configured');
    expect(err.availableValues).toHaveLength(0);
  });

  it('preserves arbitrary value types (number, object)', () => {
    const objValue = { weird: true };
    const err = new MappingError('tracker', objValue, ['bug']);

    expect(err.value).toBe(objValue);
    expect(err.message).toContain('"[object Object]"');
  });
});

describe('MAPPABLE_FIELDS', () => {
  it('is the SSOT list resolveParams and formatValidationError both key off', () => {
    expect(MAPPABLE_FIELDS).toEqual(['status', 'priority', 'tracker', 'activity']);
  });
});

// ── resolveParams — happy paths ───────────────────────────────────────────────

describe('resolveParams', () => {
  it('passes through params that have no friendly-name fields', () => {
    const params = { subject: 'Test', issue_id: 42, custom_field: 'value' };
    const result = resolveParams(params, fullMappings);

    expect(result).toEqual(params);
  });

  it('maps status → status_id and removes status', () => {
    const result = resolveParams({ status: 'in_progress' }, fullMappings);

    expect(result.status_id).toBe(2);
    expect(result).not.toHaveProperty('status');
  });

  it('maps priority → priority_id and removes priority', () => {
    const result = resolveParams({ priority: 'high' }, fullMappings);

    expect(result.priority_id).toBe(3);
    expect(result).not.toHaveProperty('priority');
  });

  it('maps tracker → tracker_id and removes tracker', () => {
    const result = resolveParams({ tracker: 'feature' }, fullMappings);

    expect(result.tracker_id).toBe(2);
    expect(result).not.toHaveProperty('tracker');
  });

  it('maps activity → activity_id and removes activity', () => {
    const result = resolveParams({ activity: 'testing' }, fullMappings);

    expect(result.activity_id).toBe(2);
    expect(result).not.toHaveProperty('activity');
  });

  it('resolves all four fields in a single call', () => {
    const params = {
      subject: 'Multi-field test',
      status: 'new',
      priority: 'low',
      tracker: 'bug',
      activity: 'development',
    };
    const result = resolveParams(params, fullMappings);

    expect(result.status_id).toBe(1);
    expect(result.priority_id).toBe(1);
    expect(result.tracker_id).toBe(1);
    expect(result.activity_id).toBe(1);
    expect(result.subject).toBe('Multi-field test');
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('priority');
    expect(result).not.toHaveProperty('tracker');
    expect(result).not.toHaveProperty('activity');
  });

  it('skips status mapping when status_id already present', () => {
    const result = resolveParams({ status: 'new', status_id: 99 }, fullMappings);

    expect(result.status_id).toBe(99);
    expect(result.status).toBe('new');
  });

  it('skips priority mapping when priority_id already present', () => {
    const result = resolveParams({ priority: 'high', priority_id: 77 }, fullMappings);

    expect(result.priority_id).toBe(77);
    expect(result.priority).toBe('high');
  });

  it('skips tracker mapping when tracker_id already present', () => {
    const result = resolveParams({ tracker: 'bug', tracker_id: 55 }, fullMappings);

    expect(result.tracker_id).toBe(55);
    expect(result.tracker).toBe('bug');
  });

  it('skips activity mapping when activity_id already present', () => {
    const result = resolveParams({ activity: 'development', activity_id: 33 }, fullMappings);

    expect(result.activity_id).toBe(33);
    expect(result.activity).toBe('development');
  });

  it('does not mutate the original params object', () => {
    const original = { status: 'new', priority: 'high' };
    resolveParams(original, fullMappings);

    expect(original).toEqual({ status: 'new', priority: 'high' });
  });

  // ── error paths ──────────────────────────────────────────────────────────────

  it('throws MappingError for unknown status', () => {
    expect(() => resolveParams({ status: 'nonexistent' }, fullMappings)).toThrow(MappingError);

    try {
      resolveParams({ status: 'nonexistent' }, fullMappings);
    } catch (err) {
      expect(err).toBeInstanceOf(MappingError);
      const me = err as MappingError;
      expect(me.field).toBe('status');
      expect(me.value).toBe('nonexistent');
      expect(me.availableValues).toContain('new');
      expect(me.availableValues).toContain('in_progress');
      expect(me.availableValues).toContain('resolved');
    }
  });

  it('throws MappingError for unknown priority', () => {
    expect(() => resolveParams({ priority: 'critical' }, fullMappings)).toThrow(MappingError);

    try {
      resolveParams({ priority: 'critical' }, fullMappings);
    } catch (err) {
      expect(err).toBeInstanceOf(MappingError);
      const me = err as MappingError;
      expect(me.field).toBe('priority');
      expect(me.value).toBe('critical');
      expect(me.availableValues).toContain('low');
      expect(me.availableValues).toContain('normal');
      expect(me.availableValues).toContain('high');
    }
  });

  it('throws MappingError for unknown tracker', () => {
    expect(() => resolveParams({ tracker: 'enhancement' }, fullMappings)).toThrow(MappingError);

    try {
      resolveParams({ tracker: 'enhancement' }, fullMappings);
    } catch (err) {
      expect(err).toBeInstanceOf(MappingError);
      const me = err as MappingError;
      expect(me.field).toBe('tracker');
      expect(me.value).toBe('enhancement');
      expect(me.availableValues).toContain('bug');
      expect(me.availableValues).toContain('feature');
    }
  });

  it('throws MappingError for unknown activity', () => {
    expect(() => resolveParams({ activity: 'design' }, fullMappings)).toThrow(MappingError);

    try {
      resolveParams({ activity: 'design' }, fullMappings);
    } catch (err) {
      expect(err).toBeInstanceOf(MappingError);
      const me = err as MappingError;
      expect(me.field).toBe('activity');
      expect(me.value).toBe('design');
      expect(me.availableValues).toContain('development');
      expect(me.availableValues).toContain('testing');
    }
  });

  it('throws MappingError with "none configured" when mappings are empty', () => {
    try {
      resolveParams({ status: 'new' }, {});
    } catch (err) {
      expect(err).toBeInstanceOf(MappingError);
      const me = err as MappingError;
      expect(me.availableValues).toHaveLength(0);
      expect(me.message).toContain('none configured');
    }
  });

  // ── edge cases ───────────────────────────────────────────────────────────────

  it('handles empty params object', () => {
    const result = resolveParams({}, fullMappings);
    expect(result).toEqual({});
  });

  it('handles params with falsy status (empty string) — skips mapping', () => {
    // Empty string is falsy, so the `if (resolved.status && ...)` guard skips it
    const result = resolveParams({ status: '' }, fullMappings);
    expect(result.status).toBe('');
    expect(result).not.toHaveProperty('status_id');
  });

  it('handles params with falsy priority (0) — skips mapping', () => {
    const result = resolveParams({ priority: 0 }, fullMappings);
    expect(result.priority).toBe(0);
    expect(result).not.toHaveProperty('priority_id');
  });

  it('handles params with falsy tracker (null) — skips mapping', () => {
    const result = resolveParams({ tracker: null }, fullMappings);
    expect(result.tracker).toBeNull();
    expect(result).not.toHaveProperty('tracker_id');
  });

  it('handles params with falsy activity (undefined) — skips mapping', () => {
    const result = resolveParams({ activity: undefined }, fullMappings);
    expect(result).not.toHaveProperty('activity_id');
  });
});
