import { createHash } from 'node:crypto';

/** The three commit SHAs GitLab requires to place a comment in a merge request diff. */
export interface DiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

/** One changed file of a merge request: its paths and unified diff. */
export interface MrFileDiff {
  old_path: string;
  new_path: string;
  diff: string;
}

/** Where a comment goes: a file, optionally a line or line range, on the new or old side. */
export interface DiffAnchor {
  path: string;
  line?: number;
  end_line?: number;
  side?: 'new' | 'old';
}

/** One end of a multi-line comment. */
export interface RangePoint {
  line_code: string;
  type: 'new' | 'old';
}

/** The GitLab `position` object for a merge request comment. */
export interface DiffPosition extends DiffRefs {
  position_type: 'text' | 'file';
  old_path: string;
  new_path: string;
  old_line?: number;
  new_line?: number;
  line_range?: { start: RangePoint; end: RangePoint };
}

type Side = 'new' | 'old';

interface DiffLine {
  kind: 'added' | 'removed' | 'context';
  old: number;
  new: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Builds the GitLab position for an anchor from the merge request's diff refs and file diffs.
 * @param refs - Base, start and head SHAs of the merge request diff version.
 * @param diffs - Changed files of the merge request.
 * @param anchor - Path, optional line and end line, and the side they refer to.
 */
export function buildPosition(
  refs: DiffRefs,
  diffs: MrFileDiff[],
  anchor: DiffAnchor
): DiffPosition {
  const side = anchor.side ?? 'new';
  const file = diffs.find((d) => (side === 'new' ? d.new_path : d.old_path) === anchor.path);
  const old_path = file?.old_path ?? anchor.path;
  const new_path = file?.new_path ?? anchor.path;
  const base = { ...refs, old_path, new_path };

  if (anchor.line === undefined) {
    return { ...base, position_type: 'file' };
  }

  const lines = file ? parseDiffLines(file.diff) : [];
  const end = locate(lines, anchor.end_line ?? anchor.line, side);
  const position: DiffPosition = { ...base, position_type: 'text', ...lineNumbers(end) };
  if (anchor.end_line === undefined) {
    return position;
  }

  const start = locate(lines, anchor.line, side);
  const codePath = side === 'new' ? new_path : old_path;
  return {
    ...position,
    line_range: {
      start: rangePoint(codePath, start, side),
      end: rangePoint(codePath, end, side),
    },
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

function locate(lines: DiffLine[], line: number, side: Side): DiffLine {
  const hit = lines.find((l) =>
    side === 'new' ? l.kind !== 'removed' && l.new === line : l.kind !== 'added' && l.old === line
  );
  if (hit) return hit;
  return side === 'new'
    ? { kind: 'added', old: 0, new: line }
    : { kind: 'removed', old: line, new: 0 };
}

function lineNumbers(line: DiffLine): { old_line?: number; new_line?: number } {
  if (line.kind === 'added') return { new_line: line.new };
  if (line.kind === 'removed') return { old_line: line.old };
  return { old_line: line.old, new_line: line.new };
}

function rangePoint(path: string, line: DiffLine, side: Side): RangePoint {
  const digest = createHash('sha1').update(path).digest('hex');
  return { line_code: `${digest}_${line.old}_${line.new}`, type: side };
}
