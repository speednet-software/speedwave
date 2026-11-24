import { describe, it, expect } from 'vitest';
import {
  buildIssuePayload,
  ignoredFields,
  issueFilterParams,
  issueFilterProperties,
  issueInputProperties,
  issueReadIncludes,
  issueRequiredOnCreate,
} from './issue-fields.js';

const payloadOf = (params: Record<string, unknown>, mode: 'create' | 'update') => {
  const built = buildIssuePayload(params, mode);
  if (!built.ok) throw new Error(`expected a payload, got a problem with ${built.paramName}`);
  return built.payload;
};

const problemOf = (params: Record<string, unknown>, mode: 'create' | 'update') => {
  const built = buildIssuePayload(params, mode);
  if (built.ok) throw new Error('expected a problem');
  return built;
};

describe('buildIssuePayload', () => {
  it('leaves omitted fields out', () => {
    expect(payloadOf({ project_id: 'p', subject: 'A' }, 'create')).toEqual({
      project_id: 'p',
      subject: 'A',
    });
  });

  it('carries every field of the table on create', () => {
    const params = {
      project_id: 'p',
      subject: 'A',
      description: 'd',
      tracker_id: 1,
      status_id: 2,
      priority_id: 3,
      assigned_to_id: 4,
      fixed_version_id: 5,
      parent_issue_id: 6,
      start_date: '2026-11-24',
      due_date: '2026-12-01',
      done_ratio: 20,
      estimated_hours: 8.5,
      is_private: true,
      custom_fields: [{ id: 1, value: '2.4' }],
      watcher_user_ids: [1739],
    };
    expect(payloadOf(params, 'create')).toEqual(params);
  });

  it('carries every field of the table on update', () => {
    const params = {
      project_id: 'p',
      subject: 'A',
      description: 'd',
      tracker_id: 1,
      status_id: 2,
      priority_id: 3,
      assigned_to_id: 4,
      fixed_version_id: 5,
      parent_issue_id: 6,
      start_date: '2026-11-24',
      due_date: '2026-12-01',
      done_ratio: 50,
      estimated_hours: 8.5,
      is_private: false,
      custom_fields: [{ id: 1, value: ['a', 'b'] }],
      notes: 'n',
      private_notes: true,
    };
    expect(payloadOf(params, 'update')).toEqual(params);
  });

  it('ignores fields the mode does not accept', () => {
    expect(payloadOf({ subject: 'A', watcher_user_ids: [1], notes: 'n' }, 'update')).toEqual({
      subject: 'A',
      notes: 'n',
    });
    expect(
      payloadOf({ subject: 'A', notes: 'n', private_notes: true, issue_id: 1 }, 'create')
    ).toEqual({ subject: 'A' });
  });

  it('trims the subject and sanitizes Textile fields', () => {
    const payload = payloadOf(
      {
        subject: '  A  ',
        description: '<script>alert(1)</script>Safe',
        notes: '<iframe src="x"></iframe>Note',
      },
      'update'
    );
    expect(payload).toEqual({ subject: 'A', description: 'Safe', notes: 'Note' });
  });

  it.each([
    ['a script tag', 'Before <script>alert("xss")</script> After', 'Before  After'],
    [
      'a multiline script tag',
      '<script type="text/javascript">\nalert("xss")\n</script >Safe',
      'Safe',
    ],
    ['an event handler attribute', '<img src="x" onerror="alert(1)">Safe', '<img src="x">Safe'],
    ['a nested script tag', '<scr<script>ipt>alert(1)</script>Safe', '<scrSafe'],
    ['a closing tag with junk', '<script>alert(1)</script\t\n bar>Safe', 'Safe'],
    ['an iframe', '<iframe src="evil.com">content</iframe>safe', 'safe'],
    ['an object', '<object data="bad.swf"></object>clean', 'clean'],
    ['an embed', '<embed src="evil.swf">text', 'text'],
    ['a form', '<form action="evil"><input type="submit"></form>Safe', 'Safe'],
    ['mixed-case tags', '<SCRIPT>alert()</SCRIPT><iFrAmE></iFrAmE>safe', 'safe'],
    ['a javascript: scheme', 'Link: javascript:alert("xss") safe', 'Link: alert("xss") safe'],
    [
      'vbscript: and data: schemes',
      '<a href="vbscript:MsgBox">x</a> <img src="data:text/html;base64,P">Safe',
      '<a href="MsgBox">x</a> <img src="text/html;base64,P">Safe',
    ],
  ])('removes %s from description and notes', (_label, input, expected) => {
    const payload = payloadOf({ description: input, notes: input }, 'update');
    expect(payload).toEqual({ description: expected, notes: expected });
  });

  it.each(['description', 'assigned_to_id', 'fixed_version_id', 'start_date', 'estimated_hours'])(
    'clears the clearable field %s with null',
    (name) => {
      const payload = payloadOf({ [name]: null }, 'update');
      expect(payload).toEqual({ [name]: name === 'description' ? '' : null });
    }
  );

  it.each(['subject', 'tracker_id', 'done_ratio', 'is_private', 'notes', 'private_notes'])(
    'rejects null for the non-clearable field %s and names it',
    (name) => {
      const problem = problemOf({ [name]: null }, 'update');
      expect(problem.paramName).toBe(name);
      expect(problem.problem).toContain(`${name} cannot be cleared`);
    }
  );

  it('rejects null for a required field on create', () => {
    expect(problemOf({ project_id: 'p', subject: null }, 'create').paramName).toBe('subject');
  });

  it('rejects an empty string for a clearable field and says to pass null', () => {
    const problem = problemOf({ due_date: '' }, 'update');
    expect(problem.paramName).toBe('due_date');
    expect(problem.problem).toContain('due_date: empty string is not a value');
    expect(problem.problem).toContain('pass null to clear it');
  });

  it('rejects an empty string for a non-clearable field without suggesting null', () => {
    const problem = problemOf({ subject: '', notes: 'x' }, 'update');
    expect(problem.paramName).toBe('subject');
    expect(problem.problem).toContain('subject: empty string is not a value');
    expect(problem.problem).toContain('subject cannot be cleared');
    expect(problem.problem).not.toContain('pass null');
  });

  it('rejects a whitespace-only string like an empty one', () => {
    expect(problemOf({ subject: '   ' }, 'create').paramName).toBe('subject');
  });

  it.each([
    ['assigned_to', 'assigned_to_id', true],
    ['tracker', 'tracker_id', false],
  ])('rejects an unresolved %s that is null or empty', (alias, idName, clearable) => {
    for (const value of [null, '']) {
      const problem = problemOf({ [alias]: value }, 'update');
      expect(problem.paramName).toBe(alias);
      expect(problem.problem).toContain(
        clearable ? `${idName}: null to clear it` : `${alias} cannot be cleared`
      );
    }
  });

  it('accepts an alias that the tool already resolved to its id', () => {
    expect(payloadOf({ tracker_id: 1 }, 'update')).toEqual({ tracker_id: 1 });
  });

  it('sends a custom field cleared with value null as an empty string', () => {
    expect(
      payloadOf(
        {
          custom_fields: [
            { id: 1, value: null },
            { id: 2, value: 'x' },
          ],
        },
        'update'
      )
    ).toEqual({
      custom_fields: [
        { id: 1, value: '' },
        { id: 2, value: 'x' },
      ],
    });
  });

  it('keeps a multiple custom field value as an array', () => {
    expect(payloadOf({ custom_fields: [{ id: 3, value: [] }] }, 'update')).toEqual({
      custom_fields: [{ id: 3, value: [] }],
    });
  });

  it.each([
    ['not a list', { id: 1, value: 'x' }],
    ['an item that is not an object', ['x']],
    ['an item without a numeric id', [{ id: 'one', value: 'x' }]],
    ['an item with a non-positive id', [{ id: 0, value: 'x' }]],
    ['an item without value', [{ id: 1 }]],
    ['an item with an empty string value', [{ id: 1, value: '' }]],
  ])('rejects custom_fields that is %s and names it', (_label, custom_fields) => {
    const problem = problemOf({ custom_fields }, 'update');
    expect(problem.paramName).toBe('custom_fields');
  });

  it('tells how to clear a custom field when its value is an empty string', () => {
    expect(problemOf({ custom_fields: [{ id: 4, value: '' }] }, 'update').problem).toContain(
      'value: null'
    );
  });
});

describe('issueInputProperties', () => {
  it('declares every field the mode accepts and nothing else', () => {
    const create = Object.keys(issueInputProperties('create'));
    const update = Object.keys(issueInputProperties('update'));
    expect(create).toContain('watcher_user_ids');
    expect(create).not.toContain('notes');
    expect(create).not.toContain('private_notes');
    expect(update).toContain('notes');
    expect(update).toContain('private_notes');
    expect(update).not.toContain('watcher_user_ids');
    for (const name of [
      'start_date',
      'due_date',
      'done_ratio',
      'is_private',
      'custom_fields',
      'tracker',
      'status',
      'priority',
      'assigned_to',
    ]) {
      expect(create).toContain(name);
      expect(update).toContain(name);
    }
  });

  it('types a clearable field with null and says null clears', () => {
    const properties = issueInputProperties('update') as Record<
      string,
      { type: unknown; description: string }
    >;
    expect(properties.due_date.type).toEqual(['string', 'null']);
    expect(properties.due_date.description).toContain('null clears');
    expect(properties.assigned_to_id.type).toEqual(['number', 'null']);
    expect(properties.description.type).toEqual(['string', 'null']);
  });

  it('types a non-clearable field without null', () => {
    const properties = issueInputProperties('update') as Record<string, { type: unknown }>;
    expect(properties.subject.type).toBe('string');
    expect(properties.done_ratio.type).toBe('number');
    expect(properties.is_private.type).toBe('boolean');
    expect(properties.tracker_id.type).toBe('number');
  });

  it('describes the list fields with their item shape', () => {
    const properties = issueInputProperties('create') as Record<string, Record<string, unknown>>;
    expect(properties.watcher_user_ids.type).toBe('array');
    expect(properties.watcher_user_ids.items).toEqual({ type: 'number' });
    expect(properties.custom_fields.type).toBe('array');
    expect(JSON.stringify(properties.custom_fields.items)).toContain('"value"');
  });

  it('words the description for the mode', () => {
    const create = issueInputProperties('create') as Record<string, { description: string }>;
    const update = issueInputProperties('update') as Record<string, { description: string }>;
    expect(create.subject.description).not.toBe(update.subject.description);
    expect(create.fixed_version_id.description).not.toBe(update.fixed_version_id.description);
  });
});

describe('issueRequiredOnCreate', () => {
  it('requires project_id and subject', () => {
    expect(issueRequiredOnCreate()).toEqual(['project_id', 'subject']);
  });
});

describe('issueFilterProperties', () => {
  it('declares the filters of the table, including the new ones', () => {
    const properties = issueFilterProperties() as Record<string, { type: unknown }>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining([
        'project_id',
        'status_id',
        'assigned_to_id',
        'tracker_id',
        'priority_id',
        'fixed_version_id',
        'parent_id',
        'start_date',
        'due_date',
        'done_ratio',
        'is_private',
        'watcher_id',
        'cf',
      ])
    );
    expect(properties.due_date.type).toBe('string');
    expect(properties.cf.type).toBe('object');
    expect(properties.status_id.type).toEqual(['number', 'string']);
  });

  it('names no filter for a field that has none', () => {
    const properties = issueFilterProperties();
    expect(properties).not.toHaveProperty('subject');
    expect(properties).not.toHaveProperty('notes');
    expect(properties).not.toHaveProperty('parent_issue_id');
  });
});

describe('issueFilterParams', () => {
  it('passes expression filters through unchanged', () => {
    expect(
      issueFilterParams({
        due_date: '<=2026-11-30',
        done_ratio: '<100',
        start_date: '><2026-11-01|2026-11-30',
        is_private: '0',
        watcher_id: 'me',
      })
    ).toEqual({
      due_date: '<=2026-11-30',
      done_ratio: '<100',
      start_date: '><2026-11-01|2026-11-30',
      is_private: '0',
      watcher_id: 'me',
    });
  });

  it('sends custom field expressions as cf_<id>', () => {
    expect(issueFilterParams({ cf: { '1': '2.4', '7': '!*' } })).toEqual({
      cf_1: '2.4',
      cf_7: '!*',
    });
  });

  it('passes value filters and skips omitted, null and empty ones', () => {
    expect(
      issueFilterParams({
        project_id: 'x',
        tracker_id: 3,
        parent_id: 9,
        status_id: '*',
        assigned_to_id: undefined,
        priority_id: null,
        fixed_version_id: '',
        limit: 10,
        offset: 5,
      })
    ).toEqual({ project_id: 'x', tracker_id: 3, parent_id: 9, status_id: '*' });
  });
});

describe('issueReadIncludes', () => {
  it('asks for watchers only when watcher_user_ids was sent', () => {
    expect(issueReadIncludes({ subject: 'A' })).toEqual([]);
    expect(issueReadIncludes({ watcher_user_ids: [1] })).toEqual(['watchers']);
  });
});

describe('ignoredFields', () => {
  const issue = {
    subject: 'A',
    description: 'Text',
    tracker: { id: 1, name: 'Bug' },
    status: { id: 2, name: 'New' },
    priority: { id: 3, name: 'Normal' },
    assigned_to: { id: 4, name: 'U' },
    fixed_version: { id: 5, name: 'V' },
    parent: { id: 6 },
    start_date: '2026-11-24',
    due_date: '2026-12-01',
    done_ratio: 50,
    estimated_hours: 8.5,
    is_private: true,
    custom_fields: [
      { id: 1, name: 'Version', value: '2.4' },
      { id: 2, name: 'Tags', value: ['b', 'a'], multiple: true },
    ],
    watchers: [{ id: 1739, name: 'W' }],
  };

  it('lists nothing when every sent field holds', () => {
    expect(
      ignoredFields(
        {
          subject: 'A',
          description: 'Text',
          tracker_id: 1,
          status_id: 2,
          priority_id: 3,
          assigned_to_id: 4,
          fixed_version_id: 5,
          parent_issue_id: 6,
          start_date: '2026-11-24',
          due_date: '2026-12-01',
          done_ratio: 50,
          estimated_hours: 8.5,
          is_private: true,
          custom_fields: [
            { id: 1, value: '2.4' },
            { id: 2, value: ['a', 'b'] },
          ],
          watcher_user_ids: [1739],
          notes: 'n',
          private_notes: true,
          project_id: 'p',
        },
        issue
      )
    ).toEqual([]);
  });

  it('lists a field whose value did not land', () => {
    expect(ignoredFields({ done_ratio: 80, due_date: '2027-01-01' }, issue)).toEqual([
      'due_date',
      'done_ratio',
    ]);
  });

  it('lists a field sent as null that still has a value', () => {
    expect(ignoredFields({ assigned_to_id: null, description: '' }, issue)).toEqual([
      'description',
      'assigned_to_id',
    ]);
  });

  it('accepts a cleared field that the issue no longer carries', () => {
    expect(
      ignoredFields(
        { assigned_to_id: null, fixed_version_id: null, due_date: null, description: '' },
        { subject: 'A' }
      )
    ).toEqual([]);
  });

  it('compares numbers and dates after normalization', () => {
    expect(
      ignoredFields(
        { done_ratio: 50, estimated_hours: 8.5 },
        { done_ratio: '50', estimated_hours: '8.50' }
      )
    ).toEqual([]);
  });

  it('compares text after normalizing line endings and surrounding whitespace', () => {
    expect(ignoredFields({ description: 'a\nb' }, { description: 'a\r\nb\r\n' })).toEqual([]);
  });

  it('names a custom field that did not land by its id', () => {
    expect(
      ignoredFields(
        {
          custom_fields: [
            { id: 1, value: '9' },
            { id: 2, value: ['a'] },
            { id: 3, value: 'x' },
          ],
        },
        issue
      )
    ).toEqual(['custom_fields.1', 'custom_fields.2', 'custom_fields.3']);
  });

  it('accepts a cleared custom field that is empty or absent', () => {
    expect(
      ignoredFields(
        {
          custom_fields: [
            { id: 1, value: '' },
            { id: 9, value: '' },
          ],
        },
        { custom_fields: [{ id: 1, name: 'Version', value: '' }] }
      )
    ).toEqual([]);
  });

  it('reads a custom field list with a number sent as a string value', () => {
    expect(
      ignoredFields(
        { custom_fields: [{ id: 1, value: 3 }] },
        { custom_fields: [{ id: 1, value: '3' }] }
      )
    ).toEqual([]);
  });

  it('lists watchers that are missing from the issue', () => {
    expect(ignoredFields({ watcher_user_ids: [1739, 5] }, issue)).toEqual(['watcher_user_ids']);
    expect(ignoredFields({ watcher_user_ids: [1] }, { subject: 'A' })).toEqual([
      'watcher_user_ids',
    ]);
  });

  it('cannot verify notes, private_notes or a project given by identifier', () => {
    expect(ignoredFields({ notes: 'n', private_notes: true, project_id: 'p' }, {})).toEqual([]);
  });
});
