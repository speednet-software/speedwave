import { SPEAKER_NAME_MAX_CHARS, type Segment } from '../models/transcript';

const SPEAKER_COLORS = ['var(--teal)', 'var(--violet)', 'var(--amber)', 'var(--green)'];

/** One diarized speaker of a transcript, as the legend, the line labels and the name dialog show it. */
export interface Speaker {
  id: number;
  /** The name the user gave, else null. */
  name: string | null;
  /** The name, else `Speaker N`. */
  label: string;
  /** The transcript lines this speaker has. */
  lines: number;
  /** The dot colour of speakers 1 to 4, else null. */
  color: string | null;
  /** From speaker 5 on, the initial of the name, else the number, drawn in a circle. */
  mark: string | null;
}

/**
 * `Speaker N`, the label of an unnamed speaker (Rust `SPEAKER_LABEL`).
 * @param id - the speaker number.
 */
export function numberLabel(id: number): string {
  return `Speaker ${id}`;
}

/**
 * How speaker `id` is shown: its name, else `Speaker N`, with its dot colour or circle mark.
 * @param id - the speaker number, 1 or more.
 * @param names - the names the user gave, by speaker number.
 */
export function speakerOfId(id: number, names: Record<string, string>): Omit<Speaker, 'lines'> {
  const name = names[String(id)] ?? null;
  const color = SPEAKER_COLORS[id - 1] ?? null;
  const mark = color ? null : name ? name.charAt(0).toUpperCase() : String(id);
  return { id, name, label: name ?? numberLabel(id), color, mark };
}

/**
 * The diarized speakers of a transcript, those with the most lines first.
 * @param segments - the transcript's segments.
 * @param names - the names the user gave, by speaker number.
 */
export function speakersOf(segments: Segment[], names: Record<string, string>): Speaker[] {
  const lines = new Map<number, number>();
  for (const seg of segments) {
    const id = seg.speaker_id;
    if (id != null && id >= 1) lines.set(id, (lines.get(id) ?? 0) + 1);
  }
  return [...lines]
    .map(([id, count]) => ({ ...speakerOfId(id, names), lines: count }))
    .sort((a, b) => b.lines - a.lines || a.id - b.id);
}

/**
 * A typed name as stored: control characters dropped, whitespace runs collapsed, cut to
 * {@link SPEAKER_NAME_MAX_CHARS} characters, like Rust `normalize_speaker_name`.
 * @param raw - the typed text.
 */
export function normalizeSpeakerName(raw: string): string {
  const collapsed = raw
    .replace(/\p{Cc}/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  return Array.from(collapsed).slice(0, SPEAKER_NAME_MAX_CHARS).join('');
}

/**
 * Whether two speaker names name the same person: equal ignoring case and outer whitespace, as
 * Rust `same_speaker_name` decides when it stores a name.
 * @param a - one name.
 * @param b - the other name.
 */
export function sameSpeakerName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The names in their order, each person once.
 * @param names - names that may repeat.
 */
export function uniqueSpeakerNames(names: string[]): string[] {
  const unique: string[] = [];
  for (const name of names) {
    if (!unique.some((seen) => sameSpeakerName(seen, name))) unique.push(name);
  }
  return unique;
}

/**
 * Whether a name is a label the transcript already uses ("You", "Meeting", "Speaker N"), which
 * Rust `check_speaker_name` refuses as a name.
 * @param name - the normalised name.
 */
export function isTranscriptLabel(name: string): boolean {
  return /^(you|meeting|speaker\s*\d+)$/i.test(name.trim());
}

/**
 * The accessible name of a control that names a speaker: "Name Speaker 2, 11 lines" or
 * "Rename Marta, 14 lines".
 * @param speaker - the speaker the control names.
 */
export function speakerActionLabel(speaker: Speaker): string {
  return `${speaker.name ? 'Rename' : 'Name'} ${speaker.label}, ${linesLabel(speaker.lines)}`;
}

/**
 * What saving a typed name for `target` changes: the lines it renames, and the speakers it makes
 * one person with and how to keep two people of one name apart, or that the name is a label.
 * @param target - the speaker being named.
 * @param speakers - every speaker of the transcript.
 * @param typed - the text in the field.
 */
export function nameChangeNote(target: Speaker, speakers: Speaker[], typed: string): string {
  const scope =
    target.lines === 1
      ? `Renames ${target.label} on its one line.`
      : `Renames ${target.label} on all ${target.lines} lines.`;
  const name = normalizeSpeakerName(typed);
  if (!name) return scope;
  if (isTranscriptLabel(name)) {
    return `"${name}" is a label the transcript already uses; type the person's name.`;
  }
  const others = speakers.filter(
    (s): s is Speaker & { name: string } =>
      s.id !== target.id && s.name !== null && sameSpeakerName(s.name, name)
  );
  if (others.length === 0) return scope;
  const ids = others.map((s) => numberLabel(s.id)).join(' and ');
  return `${scope} Same name as ${ids}, so they count as one person, also in exports and chats. Different people? Add a surname or a number.`;
}

/**
 * "3 speakers · 1 unnamed", "3 speakers · none named" or "3 speakers"; '' without speakers.
 * @param speakers - the transcript's speakers.
 */
export function speakerCountLine(speakers: Speaker[]): string {
  if (speakers.length === 0) return '';
  const count = `${speakers.length} ${speakers.length === 1 ? 'speaker' : 'speakers'}`;
  const unnamed = speakers.filter((s) => !s.name).length;
  if (unnamed === 0) return count;
  if (unnamed === speakers.length) return `${count} · none named`;
  return `${count} · ${unnamed} unnamed`;
}

/**
 * "1 line" or "N lines".
 * @param n - the number of lines.
 */
export function linesLabel(n: number): string {
  return `${n} ${n === 1 ? 'line' : 'lines'}`;
}
