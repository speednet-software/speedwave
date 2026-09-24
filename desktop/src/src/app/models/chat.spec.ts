import { describe, it, expect } from 'vitest';
import { watchdogErrorKind, type ErrorBlockKind } from './chat';

describe('watchdogErrorKind', () => {
  const watchdogCases: Array<{ text: string; kind: ErrorBlockKind }> = [
    {
      text: 'API Error: Server error mid-response. The response above may be incomplete.',
      kind: 'api_server_interrupted',
    },
    {
      text: 'API Error: Connection closed mid-response. The response above may be incomplete.',
      kind: 'connection_interrupted',
    },
    {
      text: 'API Error: Connection lost mid-response. The response above may be incomplete.',
      kind: 'connection_interrupted',
    },
    {
      text: 'API Error: The response stopped arriving. The response above may be incomplete.',
      kind: 'response_stalled',
    },
    {
      text: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
      kind: 'host_slept',
    },
  ];

  for (const { text, kind } of watchdogCases) {
    it(`happy: recognises the full Claude Code text for ${kind}`, () => {
      expect(watchdogErrorKind(text)).toBe(kind);
    });

    it(`edge: recognises ${kind} regardless of case`, () => {
      expect(watchdogErrorKind(text.toUpperCase())).toBe(kind);
      expect(watchdogErrorKind(text.toLowerCase())).toBe(kind);
    });
  }

  it('edge: matches by the bare substring alone, without the surrounding sentence', () => {
    expect(watchdogErrorKind('Server error mid-response')).toBe('api_server_interrupted');
    expect(watchdogErrorKind('Connection closed mid-response')).toBe('connection_interrupted');
    expect(watchdogErrorKind('Connection lost mid-response')).toBe('connection_interrupted');
    expect(watchdogErrorKind('The response stopped arriving')).toBe('response_stalled');
    expect(watchdogErrorKind('Your computer went to sleep mid-response')).toBe('host_slept');
  });

  it('edge: empty string is not a watchdog error', () => {
    expect(watchdogErrorKind('')).toBeUndefined();
  });

  it('error: unrelated text is not a watchdog error', () => {
    expect(watchdogErrorKind('Broken pipe (os error 32)')).toBeUndefined();
    expect(watchdogErrorKind('not logged in')).toBeUndefined();
    expect(watchdogErrorKind('exceeds the available context size (8192 tokens)')).toBeUndefined();
  });
});
