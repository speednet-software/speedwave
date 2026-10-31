import { describe, it, expect } from 'vitest';

import type { Segment } from '../models/transcript';
import {
  isTranscriptLabel,
  samePerson,
  linesLabel,
  nameChangeNote,
  normalizeSpeakerName,
  numberLabel,
  sameSpeakerName,
  speakerActionLabel,
  speakerCountLine,
  speakerOfId,
  speakersOf,
  uniqueSpeakerNames,
  type Speaker,
} from './speaker-names';

const SPEAKER_NAME_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['Marta', 'Marta', 'name'],
  ['  Anna   Maria ', 'Anna Maria', 'name'],
  ['   ', '', 'name'],
  ['Łukasz Żółć', 'Łukasz Żółć', 'name'],
  ['Speaker', 'Speaker', 'name'],
  ['Speaker A', 'Speaker A', 'name'],
  ['Speakerowa 2', 'Speakerowa 2', 'name'],
  ['Youssef', 'Youssef', 'name'],
  ['Sławek 2', 'Sławek 2', 'name'],
  ['You', 'You', 'label'],
  [' meeting ', 'meeting', 'label'],
  ['Speaker 3', 'Speaker 3', 'label'],
  ['speaker   12', 'speaker 12', 'label'],
  ['SPEAKER12', 'SPEAKER12', 'label'],
  ['ŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁ', 'ŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁŁ', 'name'],
];

const SAME_NAME_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['Marta', ' marta ', 'same'],
  ['ŁUKASZ', 'łukasz', 'same'],
  ['Sławek', 'SŁAWEK', 'same'],
  ['Anna Maria', 'AnnaMaria', 'different'],
  ['Marta', 'Marek', 'different'],
  ['Sławek', 'Sławek 2', 'different'],
];

function seg(start: number, speaker_id?: number | null, source?: 'system' | 'mic'): Segment {
  return {
    start: { secs: start, nanos: 0 },
    end: { secs: start + 1, nanos: 0 },
    text: 'x',
    words: [],
    source,
    speaker_id,
  };
}

describe('speaker names', () => {
  it('shows a named speaker by name and an unnamed one by number, coloured up to four', () => {
    expect(speakerOfId(2, { '2': 'Marta' })).toEqual({
      id: 2,
      name: 'Marta',
      label: 'Marta',
      color: 'var(--violet)',
      mark: null,
      sharesName: false,
    });
    expect(speakerOfId(4, {})).toMatchObject({ label: 'Speaker 4', color: 'var(--rose)' });
  });

  it('marks speakers past the fourth with the initial of the name, else the number', () => {
    expect(speakerOfId(5, { '5': 'ewa' })).toMatchObject({ color: null, mark: 'E' });
    expect(speakerOfId(7, {})).toMatchObject({ color: null, mark: '7', label: 'Speaker 7' });
    expect(speakerOfId(6, { '6': 'Łucja' }).mark).toBe('Ł');
  });

  it('counts lines per speaker, most first, leaving out unlabelled and microphone lines', () => {
    const speakers = speakersOf(
      [
        seg(0, 2),
        seg(1, 1),
        seg(2, 2),
        seg(3, null),
        seg(4, undefined, 'mic'),
        seg(5, 3),
        seg(6, 0),
      ],
      { '3': 'Ola' }
    );
    expect(speakers.map((s) => [s.id, s.lines, s.label])).toEqual([
      [2, 2, 'Speaker 2'],
      [1, 1, 'Speaker 1'],
      [3, 1, 'Ola'],
    ]);
    expect(speakersOf([], {})).toEqual([]);
  });

  it('compares names ignoring case and outer whitespace only', () => {
    expect(sameSpeakerName(' marta ', 'Marta')).toBe(true);
    expect(sameSpeakerName('ŁUKASZ', 'łukasz')).toBe(true);
    expect(sameSpeakerName('Anna Maria', 'AnnaMaria')).toBe(false);
  });

  it('keeps the labels of one person together, the person with the most lines first', () => {
    const speakers = speakersOf(
      [
        ...Array.from({ length: 5 }, (_, i) => seg(i, 2)),
        ...Array.from({ length: 4 }, (_, i) => seg(10 + i, 3)),
        ...Array.from({ length: 3 }, (_, i) => seg(20 + i, 1)),
        seg(30, 4),
      ],
      { '2': 'Sławek', '1': ' sławek ', '3': 'Alan' }
    );
    expect(speakers.map((s) => [s.id, s.lines, s.sharesName])).toEqual([
      [2, 5, true],
      [1, 3, true],
      [3, 4, false],
      [4, 1, false],
    ]);
    expect(speakers.map((s) => s.color)).toEqual([
      'var(--violet)',
      'var(--violet)',
      'var(--amber)',
      'var(--rose)',
    ]);
  });

  it('gives a person the mark of its main label when that label has no colour', () => {
    const speakers = speakersOf([seg(0, 6), seg(1, 6), seg(2, 1)], { '6': 'Ewa', '1': 'ewa' });
    expect(speakers.map((s) => [s.id, s.color, s.mark])).toEqual([
      [6, null, 'E'],
      [1, null, 'E'],
    ]);
  });

  it('lights up every label of the person a speaker belongs to', () => {
    const speakers = speakersOf([seg(0, 1), seg(1, 2), seg(2, 3), seg(3, 4)], {
      '1': 'Sławek',
      '4': 'SŁAWEK',
      '2': 'Alan',
    });
    expect(samePerson(speakers, 4).sort()).toEqual([1, 4]);
    expect(samePerson(speakers, 2)).toEqual([2]);
    expect(samePerson(speakers, 3)).toEqual([3]);
    expect(samePerson(speakers, null)).toEqual([]);
    expect(samePerson(speakers, 9)).toEqual([]);
  });

  it('counts people and labels apart once labels share a name', () => {
    const speakers = speakersOf([seg(0, 1), seg(1, 2), seg(2, 3), seg(3, 4), seg(4, 5)], {
      '1': 'Sławek',
      '2': 'Sławek',
      '3': 'Alan',
      '4': 'Mikołaj',
    });
    expect(speakerCountLine(speakers)).toBe('4 speakers · 5 labels · 1 unnamed');
  });

  it('says how many speakers there are and how many are unnamed', () => {
    const named = speakersOf([seg(0, 1), seg(1, 2)], { '1': 'Marta', '2': 'Paweł' });
    expect(speakerCountLine(named)).toBe('2 speakers');
    expect(speakerCountLine(speakersOf([seg(0, 1), seg(1, 2)], { '1': 'Marta' }))).toBe(
      '2 speakers · 1 unnamed'
    );
    expect(speakerCountLine(speakersOf([seg(0, 1)], {}))).toBe('1 speaker · none named');
    expect(speakerCountLine([])).toBe('');
  });

  it.each(SPEAKER_NAME_CASES)(
    'stores %j as %j, a %s, as the backend does',
    (typed, stored, kind) => {
      expect(normalizeSpeakerName(typed)).toBe(stored);
      expect(isTranscriptLabel(stored)).toBe(kind === 'label');
    }
  );

  it.each(SAME_NAME_CASES)(
    'compares %j and %j as the %s person, as the backend does',
    (a, b, verdict) => {
      expect(sameSpeakerName(a, b)).toBe(verdict === 'same');
    }
  );

  it('labels an unnamed speaker by number', () => {
    expect(numberLabel(3)).toBe('Speaker 3');
  });

  it('normalises a typed name like the backend: control characters, spacing, 40 characters', () => {
    expect(normalizeSpeakerName('  Anna\n  Maria\u0007 ')).toBe('Anna Maria');
    expect(normalizeSpeakerName(' \t ')).toBe('');
    expect(Array.from(normalizeSpeakerName('Ł'.repeat(50))).length).toBe(40);
  });

  it('keeps each person once, in order', () => {
    expect(uniqueSpeakerNames(['Marta', 'Ola', ' marta', 'OLA', 'Paweł'])).toEqual([
      'Marta',
      'Ola',
      'Paweł',
    ]);
  });

  it('knows the labels the transcript uses, as the backend refuses them', () => {
    for (const label of ['You', ' meeting ', 'Speaker 3', 'speaker   12', 'SPEAKER12']) {
      expect(isTranscriptLabel(label)).toBe(true);
    }
    for (const name of ['Speaker', 'Speaker A', 'Youssef', 'Meetingowa', 'Marta']) {
      expect(isTranscriptLabel(name)).toBe(false);
    }
  });

  it('names the action of a speaker control for screen readers', () => {
    const [unnamed, named] = speakersOf([seg(0, 1), seg(1, 2), seg(2, 2)], { '2': 'Marta' }).sort(
      (a, b) => a.id - b.id
    );
    expect(speakerActionLabel(unnamed)).toBe('Name Speaker 1, 1 line');
    expect(speakerActionLabel(named)).toBe('Rename Marta, 2 lines');
  });

  describe('what saving a name changes', () => {
    const speakers: Speaker[] = speakersOf(
      [seg(0, 1), seg(1, 1), seg(2, 2), seg(3, 3), seg(4, 3), seg(5, 3), seg(6, 4)],
      { '1': 'Marta', '4': 'marta' }
    );
    const byId = (id: number) => speakers.find((s) => s.id === id)!;

    it('states how many lines the name changes', () => {
      expect(nameChangeNote(byId(3), speakers, 'Ola')).toBe('Renames Speaker 3 on all 3 lines.');
      expect(nameChangeNote(byId(2), speakers, '')).toBe('Renames Speaker 2 on its one line.');
    });

    it('says a shared name makes one person everywhere, and how to keep two people of one name apart', () => {
      expect(nameChangeNote(byId(3), speakers, ' MARTA ')).toBe(
        'Renames Speaker 3 on all 3 lines. Same name as Speaker 1 and Speaker 4, so they count as one person, also in exports and chats. Different people? Add a surname or a number.'
      );
      expect(nameChangeNote(byId(1), speakers, 'Marta')).toBe(
        'Renames Marta on all 2 lines. Same name as Speaker 4, so they count as one person, also in exports and chats. Different people? Add a surname or a number.'
      );
    });

    it('says a label the transcript uses is not a name', () => {
      expect(nameChangeNote(byId(2), speakers, 'speaker 3')).toBe(
        '"speaker 3" is a label the transcript already uses; type the person\'s name.'
      );
    });
  });

  it('counts one line in the singular', () => {
    expect(linesLabel(1)).toBe('1 line');
    expect(linesLabel(0)).toBe('0 lines');
    expect(linesLabel(14)).toBe('14 lines');
  });
});
