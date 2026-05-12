import { describe, it, expect } from 'vitest';
import { OutputCollector, collapseCarriageReturns, stripAnsi } from './output.js';
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from './constants.js';

describe('stripAnsi', () => {
  it('removes SGR colour codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;32mok\x1b[39m done')).toBe('ok done');
  });
  it('removes cursor-movement / erase CSI sequences', () => {
    expect(stripAnsi('a\x1b[2Kb\x1b[1Gc')).toBe('abc');
  });
  it('removes OSC sequences terminated by BEL or ST', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
    expect(stripAnsi('\x1b]8;;http://x\x1b\\link')).toBe('link');
  });
  it('removes single-char escapes', () => {
    expect(stripAnsi('a\x1bMb')).toBe('ab');
  });
  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
  });
});

describe('collapseCarriageReturns', () => {
  it('keeps the last segment of a line written with \\r overwrites', () => {
    expect(collapseCarriageReturns('downloading 10%\rdownloading 100%')).toBe('downloading 100%');
  });
  it('a trailing \\r leaves the line content (cursor moved, nothing overwrote it)', () => {
    expect(collapseCarriageReturns('progress\r')).toBe('progress');
  });
  it('handles multiple lines independently', () => {
    expect(collapseCarriageReturns('a\rb\nc\rd\ne')).toBe('b\nd\ne');
  });
  it('is a no-op when there is no \\r', () => {
    expect(collapseCarriageReturns('plain\nlines')).toBe('plain\nlines');
  });
  it('treats \\r\\n as a line break (split on \\n first)', () => {
    expect(collapseCarriageReturns('one\r\ntwo')).toBe('one\ntwo');
  });
});

describe('OutputCollector', () => {
  it('renders small output verbatim', () => {
    const c = new OutputCollector();
    c.push(Buffer.from('hello '));
    c.push(Buffer.from('world\n'));
    const { text, truncated } = c.render();
    expect(text).toBe('hello world\n');
    expect(truncated).toBe(false);
  });

  it('strips ANSI and collapses \\r during render', () => {
    const c = new OutputCollector();
    // Realistic: a coloured banner on its own line, then a progress line that
    // rewrites itself from column 0 with \r (the last segment wins).
    c.push(Buffer.from('\x1b[32mBUILD SUCCESSFUL\x1b[0m\n'));
    c.push(Buffer.from('downloading \x1b[1m5%\x1b[0m\rdownloading 100%\n'));
    expect(c.render().text).toBe('BUILD SUCCESSFUL\ndownloading 100%\n');
  });

  it('decodes non-UTF-8 bytes lossily without crashing', () => {
    const c = new OutputCollector();
    c.push(Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a])); // "hi" + invalid + \n
    const { text } = c.render();
    expect(text.startsWith('hi')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('�');
  });

  it('caps to the tail by bytes and sets truncated', () => {
    const c = new OutputCollector();
    // Push 3x the byte cap in distinct chunks.
    const chunk = Buffer.from('x'.repeat(1024));
    const n = Math.ceil((MAX_OUTPUT_BYTES * 3) / chunk.length);
    for (let i = 0; i < n; i++) c.push(chunk);
    const { text, truncated } = c.render();
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    // It's the tail — all 'x'.
    expect(text).toMatch(/^x+$/);
  });

  it('caps to the tail by lines and sets truncated', () => {
    const c = new OutputCollector();
    const lines = [];
    for (let i = 0; i < MAX_OUTPUT_LINES + 50; i++) lines.push(`line ${i}`);
    c.push(Buffer.from(lines.join('\n')));
    const { text, truncated } = c.render();
    expect(truncated).toBe(true);
    const got = text.split('\n');
    expect(got.length).toBe(MAX_OUTPUT_LINES);
    // The tail — last line preserved.
    expect(got[got.length - 1]).toBe(`line ${MAX_OUTPUT_LINES + 49}`);
  });

  it('does not split a multibyte char across data events', () => {
    const c = new OutputCollector();
    const euro = Buffer.from('€', 'utf-8'); // 3 bytes: e2 82 ac
    c.push(euro.subarray(0, 1));
    c.push(euro.subarray(1, 2));
    c.push(euro.subarray(2, 3));
    c.push(Buffer.from('\n'));
    expect(c.render().text).toBe('€\n');
  });
});
