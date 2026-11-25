import { describe, it, expect } from 'vitest';
import {
  buildPosition,
  isAnchored,
  droppedAnchorFields,
  type MrFileDiff,
} from './diff-position.js';

const refs = { base_sha: 'base', start_sha: 'start', head_sha: 'head' };

const SHA_A = '21ff24dd18cc19d35de15a120639695824655b58';
const SHA_RENAMED = 'a17762f51ce44d82ee9e2a0dec1f100a986d3d67';
const SHA_GONE = '3610915ac3ee397af8456cf1dd1f95aa7a212463';

const diff = [
  '@@ -1,4 +1,5 @@',
  ' line1',
  '-line2',
  '+line2 changed',
  '+line2b',
  ' line3',
  ' line4',
  '\\ No newline at end of file',
  '@@ -20,2 +21,2 @@',
  ' tail',
  '-gone',
  '+new',
].join('\n');

const files: MrFileDiff[] = [
  { old_path: 'src/a.ts', new_path: 'src/a.ts', diff },
  { old_path: 'src/old.ts', new_path: 'src/renamed.ts', diff },
];

const base = { ...refs, old_path: 'src/a.ts', new_path: 'src/a.ts' };

describe('buildPosition', () => {
  it('anchors an added line with only new_line', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 2 })).toEqual({
      ...base,
      position_type: 'text',
      new_line: 2,
    });
  });

  it('anchors a removed line with only old_line when side is old', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 2, side: 'old' })).toEqual({
      ...base,
      position_type: 'text',
      old_line: 2,
    });
  });

  it('anchors a context line with both numbers read from the hunk', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 4, side: 'new' })).toEqual({
      ...base,
      position_type: 'text',
      old_line: 3,
      new_line: 4,
    });
  });

  it('finds the same context line through the old side', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 3, side: 'old' })).toEqual({
      ...base,
      position_type: 'text',
      old_line: 3,
      new_line: 4,
    });
  });

  it('reads numbers from a later hunk', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 21 })).toEqual({
      ...base,
      position_type: 'text',
      old_line: 20,
      new_line: 21,
    });
  });

  it('sends a line outside the diff as given on the new side', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 99 })).toEqual({
      ...base,
      position_type: 'text',
      new_line: 99,
    });
  });

  it('sends a line outside the diff as given on the old side', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 99, side: 'old' })).toEqual({
      ...base,
      position_type: 'text',
      old_line: 99,
    });
  });

  it('does not match an added line through the old side', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 3, side: 'new' })).toEqual({
      ...base,
      position_type: 'text',
      new_line: 3,
    });
  });

  it('builds a file position when no line is given', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts' })).toEqual({
      ...base,
      position_type: 'file',
    });
  });

  it('uses the path for both sides when the file is not in the diff', () => {
    expect(buildPosition(refs, files, { path: 'docs/readme.md', line: 5 })).toEqual({
      ...refs,
      old_path: 'docs/readme.md',
      new_path: 'docs/readme.md',
      position_type: 'text',
      new_line: 5,
    });
  });

  it('builds a line range with line codes from the new path', () => {
    expect(buildPosition(refs, files, { path: 'src/a.ts', line: 2, end_line: 4 })).toEqual({
      ...base,
      position_type: 'text',
      old_line: 3,
      new_line: 4,
      line_range: {
        start: { line_code: `${SHA_A}_3_2`, new_line: 2, type: 'new' },
        end: { line_code: `${SHA_A}_3_4`, old_line: 3, new_line: 4 },
      },
    });
  });

  it('builds a line range on the old side with line codes from the new path', () => {
    const position = buildPosition(refs, files, {
      path: 'src/old.ts',
      line: 1,
      end_line: 2,
      side: 'old',
    });

    expect(position).toEqual({
      ...refs,
      old_path: 'src/old.ts',
      new_path: 'src/renamed.ts',
      position_type: 'text',
      old_line: 2,
      line_range: {
        start: { line_code: `${SHA_RENAMED}_1_1`, old_line: 1, new_line: 1 },
        end: { line_code: `${SHA_RENAMED}_2_2`, old_line: 2, type: 'old' },
      },
    });
  });

  it('takes line codes from the old path when the new path is empty', () => {
    const removed: MrFileDiff[] = [
      { old_path: 'src/gone.ts', new_path: '', diff: '@@ -1,2 +0,0 @@\n-a\n-b' },
    ];

    const position = buildPosition(refs, removed, {
      path: 'src/gone.ts',
      line: 1,
      end_line: 2,
      side: 'old',
    });

    expect(position?.line_range?.start.line_code).toBe(`${SHA_GONE}_1_0`);
    expect(position?.line_range?.end.line_code).toBe(`${SHA_GONE}_2_0`);
  });

  it('builds line codes for lines outside the diff with zero on the other side', () => {
    const position = buildPosition(refs, files, {
      path: 'src/a.ts',
      line: 90,
      end_line: 91,
    });

    expect(position?.line_range).toEqual({
      start: { line_code: `${SHA_A}_0_90`, new_line: 90, type: 'new' },
      end: { line_code: `${SHA_A}_0_91`, new_line: 91, type: 'new' },
    });
  });

  it('builds a range for a file missing from the diff on the old side', () => {
    const position = buildPosition(refs, [], {
      path: 'src/a.ts',
      line: 3,
      end_line: 4,
      side: 'old',
    });

    expect(position).toMatchObject({ old_line: 4, old_path: 'src/a.ts', new_path: 'src/a.ts' });
    expect(position?.line_range?.start).toEqual({
      line_code: `${SHA_A}_3_0`,
      old_line: 3,
      type: 'old',
    });
  });

  it('treats a diff without hunks as having no lines', () => {
    const empty = [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '' }];

    expect(buildPosition(refs, empty, { path: 'src/a.ts', line: 1 })).toEqual({
      ...base,
      position_type: 'text',
      new_line: 1,
    });
  });

  it('builds a range that starts and ends on context lines without a type', () => {
    const position = buildPosition(refs, files, { path: 'src/a.ts', line: 1, end_line: 5 });

    expect(position?.line_range).toEqual({
      start: { line_code: `${SHA_A}_1_1`, old_line: 1, new_line: 1 },
      end: { line_code: `${SHA_A}_4_5`, old_line: 4, new_line: 5 },
    });
  });

  it('returns no position when the anchor has no path', () => {
    expect(buildPosition(refs, files, { line: 2, end_line: 3, side: 'old' })).toBeUndefined();
  });
});

describe('isAnchored', () => {
  it('is true only when the anchor has a path', () => {
    expect(isAnchored({ path: 'src/a.ts' })).toBe(true);
    expect(isAnchored({ line: 3 })).toBe(false);
  });
});

describe('droppedAnchorFields', () => {
  it('lists the fields given without a path', () => {
    expect(droppedAnchorFields({ line: 1, end_line: 2, side: 'old' })).toEqual([
      'line',
      'end_line',
      'side',
    ]);
  });

  it('lists only the fields that were given', () => {
    expect(droppedAnchorFields({ side: 'new' })).toEqual(['side']);
  });

  it('lists end_line given with a path but without line', () => {
    expect(droppedAnchorFields({ path: 'a.ts', end_line: 5 })).toEqual(['end_line']);
    expect(droppedAnchorFields({ path: 'a.ts', end_line: 5, side: 'old' })).toEqual(['end_line']);
  });

  it('lists nothing for an empty anchor or one with a path', () => {
    expect(droppedAnchorFields({})).toEqual([]);
    expect(droppedAnchorFields({ path: 'a.ts', line: 1, side: 'new' })).toEqual([]);
  });
});
