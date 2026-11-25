import { createHash } from 'node:crypto';

interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

/** A changed file of a merge request with its unified diff. */
export interface MrFileDiff {
  old_path: string;
  new_path: string;
  diff: string;
}

type Side = 'new' | 'old';

/** Where a comment goes. */
export type DiffAnchor = {
  path?: string;
  line?: number;
  end_line?: number;
  side?: Side;
};

type LineFields = { old_line?: number; new_line?: number };

type RangePoint = LineFields & { line_code: string; type?: Side };

/** The GitLab `position` of a merge request comment. */
export interface DiffPosition extends DiffRefs, LineFields {
  position_type: 'text' | 'file';
  old_path: string;
  new_path: string;
  line_range?: { start: RangePoint; end: RangePoint };
}

interface DiffLine {
  kind: 'added' | 'removed' | 'context';
  old: number;
  new: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Lists the anchor fields that no position would carry.
 * @param anchor - Anchor to check.
 */
export function droppedAnchorFields(anchor: DiffAnchor): string[] {
  if (!isAnchored(anchor)) {
    return (['line', 'end_line', 'side'] as const).filter((k) => anchor[k] !== undefined);
  }
  return anchor.line === undefined && anchor.end_line !== undefined ? ['end_line'] : [];
}

/**
 * Tells whether the anchor names a file.
 * @param anchor - Anchor to check.
 */
export function isAnchored(anchor: DiffAnchor): boolean {
  return anchor.path !== undefined;
}

/**
 * Builds the GitLab position of an anchor.
 * @param refs - Base, start and head SHAs of the diff version.
 * @param diffs - Changed files of the merge request.
 * @param anchor - File, optional line and end line, and side.
 */
export function buildPosition(
  refs: DiffRefs,
  diffs: MrFileDiff[],
  anchor: DiffAnchor
): DiffPosition | undefined {
  const { path, line, end_line } = anchor;
  if (path === undefined) return undefined;

  const side = anchor.side ?? 'new';
  const file = diffs.find((d) => (side === 'new' ? d.new_path : d.old_path) === path);
  const old_path = file?.old_path ?? path;
  const new_path = file?.new_path ?? path;
  const base = { ...refs, old_path, new_path };

  if (line === undefined) {
    return { ...base, position_type: 'file' };
  }

  const lines = file ? parseDiffLines(file.diff) : [];
  const last = findDiffLine(lines, end_line ?? line, side);
  const position: DiffPosition = { ...base, position_type: 'text', ...lineFieldsOf(last) };
  if (end_line === undefined) {
    return position;
  }

  const first = findDiffLine(lines, line, side);
  const codePath = new_path || old_path;
  return {
    ...position,
    line_range: { start: rangePoint(codePath, first), end: rangePoint(codePath, last) },
  };
}

function parseDiffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let old = 0;
  let next = 0;
  for (const text of diff.split('\n')) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      old = Number(header[1]);
      next = Number(header[2]);
    } else if (text.startsWith('+')) {
      lines.push({ kind: 'added', old, new: next });
      next += 1;
    } else if (text.startsWith('-')) {
      lines.push({ kind: 'removed', old, new: next });
      old += 1;
    } else if (text.startsWith(' ')) {
      lines.push({ kind: 'context', old, new: next });
      old += 1;
      next += 1;
    }
  }
  return lines;
}

function findDiffLine(lines: DiffLine[], line: number, side: Side): DiffLine {
  const hit = lines.find((l) =>
    side === 'new' ? l.kind !== 'removed' && l.new === line : l.kind !== 'added' && l.old === line
  );
  if (hit) return hit;
  return side === 'new'
    ? { kind: 'added', old: 0, new: line }
    : { kind: 'removed', old: line, new: 0 };
}

function lineFieldsOf(line: DiffLine): LineFields {
  if (line.kind === 'added') return { new_line: line.new };
  if (line.kind === 'removed') return { old_line: line.old };
  return { old_line: line.old, new_line: line.new };
}

function rangePoint(path: string, line: DiffLine): RangePoint {
  const digest = createHash('sha1').update(path).digest('hex');
  const point = { line_code: `${digest}_${line.old}_${line.new}`, ...lineFieldsOf(line) };
  if (line.kind === 'added') return { ...point, type: 'new' };
  if (line.kind === 'removed') return { ...point, type: 'old' };
  return point;
}
