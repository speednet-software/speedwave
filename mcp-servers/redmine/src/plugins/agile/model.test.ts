import { describe, it, expect } from 'vitest';
import { parseAgileData, parseSprint, parseSprintList, sharingCode, statusCode } from './model.js';

describe('agile model', () => {
  it('maps status words to Redmine codes', () => {
    expect([statusCode('open'), statusCode('active'), statusCode('closed')]).toEqual([0, 1, 2]);
  });

  it('maps sharing words to Redmine codes', () => {
    expect(['none', 'descendants', 'hierarchy', 'tree', 'system'].map(sharingCode)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('rejects an unknown word and lists the allowed ones', () => {
    expect(() => statusCode('paused')).toThrow(
      'Unknown status "paused". Allowed values: open, active, closed.'
    );
    expect(() => sharingCode('all')).toThrow('Unknown sharing "all"');
  });

  it('parses a sprint with words and keeps only known fields', () => {
    expect(
      parseSprint({
        id: 3,
        project_id: 9,
        name: 'S1',
        status: 'active',
        sharing: 'none',
        start_date: '2026-12-01',
        extra: 1,
      })
    ).toEqual({
      id: 3,
      project_id: 9,
      name: 'S1',
      status: 'active',
      sharing: 'none',
      start_date: '2026-12-01',
    });
  });

  it('unwraps an agile_sprint wrapper and turns numeric codes into words', () => {
    expect(parseSprint({ agile_sprint: { id: 3, name: 'S1', status: 2, sharing: 4 } })).toEqual({
      id: 3,
      name: 'S1',
      status: 'closed',
      sharing: 'system',
    });
  });

  it('keeps totals and issues of a single sprint, and omits absent status and sharing', () => {
    const issues = [{ id: 1, subject: 'a', story_points: 3, done_ratio: 0 }];
    expect(parseSprint({ id: 3, story_points: 8, done_ratio: 50, issues })).toEqual({
      id: 3,
      story_points: 8,
      done_ratio: 50,
      issues,
    });
  });

  it('parses an empty body as an empty sprint', () => {
    expect(parseSprint(undefined)).toEqual({});
  });

  it('parses a sprint list with Redmine paging', () => {
    expect(
      parseSprintList(
        { sprints: [{ id: 1, name: 'a', status: 'open' }], total_count: 40, offset: 25, limit: 25 },
        {}
      )
    ).toEqual({
      sprints: [{ id: 1, name: 'a', status: 'open' }],
      total_count: 40,
      offset: 25,
      limit: 25,
    });
  });

  it('falls back to the request paging and the list length when Redmine sends none', () => {
    expect(parseSprintList({ sprints: [{ id: 1 }] }, { offset: 5, limit: 10 })).toEqual({
      sprints: [{ id: 1 }],
      total_count: 1,
      offset: 5,
      limit: 10,
    });
    expect(parseSprintList({}, {})).toEqual({ sprints: [], total_count: 0, offset: 0, limit: 25 });
    expect(parseSprintList(null, {}).sprints).toEqual([]);
  });

  it('parses agile data, wrapped or not, with absent fields as null', () => {
    expect(
      parseAgileData({
        agile_data: {
          id: 49,
          issue_id: 580,
          agile_sprint_id: 3,
          story_points: 5,
          position: 2,
          color: 'red',
        },
      })
    ).toEqual({ agile_sprint_id: 3, story_points: 5, position: 2, color: 'red' });
    expect(parseAgileData({ agile_sprint_id: 3 })).toEqual({
      agile_sprint_id: 3,
      story_points: null,
      position: null,
      color: null,
    });
  });
});
