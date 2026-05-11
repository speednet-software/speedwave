/**
 * Output processing for recipe stdout/stderr: lossy UTF-8 decode of the raw
 * bytes, strip ANSI escape sequences, collapse carriage returns (a terminal
 * shows the last segment of a line written before each `\r`), and cap each
 * stream to the *tail* (for build/test failures the end is what matters), so a
 * giant Gradle log doesn't flood Claude's context (ADR-054).
 * @module host_exec/output
 */

import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from './constants.js';

/**
 * ANSI escape sequences: CSI (`\x1b[ … <final byte 0x40–0x7E>`), plus the
 * single-character `\x1b` + `[\x40-\x5F]` forms (e.g. `\x1b]` OSC start, `\x1bM`
 * reverse index). Also strips OSC sequences terminated by BEL or ST. Bounded —
 * no catastrophic backtracking (each alternative is linear).
 */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/**
 * Accumulates one output stream's bytes, applies a tail cap, and renders the
 * processed text. Bytes are kept (not pre-decoded) so a multibyte sequence
 * split across `data` events decodes correctly; only the *tail* of the raw
 * bytes is retained, then decoded lossily, ANSI-stripped, and `\r`-collapsed.
 */
export class OutputCollector {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  /** True once we have dropped bytes from the front because of the byte cap. */
  private droppedBytes = false;

  /**
   * Append a chunk of raw bytes from the child's stdout/stderr.
   * @param chunk - The bytes received in one `data` event.
   */
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    // Keep the buffer bounded as we go: as long as dropping the *first* chunk
    // still leaves us at/over the byte cap, drop it. (We may keep slightly more
    // than MAX_OUTPUT_BYTES so we never split a chunk mid-byte here — the final
    // `render()` does the exact byte-precise tail cut.)
    while (this.chunks.length > 1 && this.totalBytes - this.chunks[0].length >= MAX_OUTPUT_BYTES) {
      this.totalBytes -= this.chunks[0].length;
      this.chunks.shift();
      this.droppedBytes = true;
    }
  }

  /**
   * Render the collected output as processed text, plus whether it was
   * truncated (by either the byte or the line cap).
   * @returns `{ text, truncated }`.
   */
  render(): { text: string; truncated: boolean } {
    let buf = Buffer.concat(this.chunks);
    let truncated = this.droppedBytes;
    if (buf.length > MAX_OUTPUT_BYTES) {
      buf = buf.subarray(buf.length - MAX_OUTPUT_BYTES);
      truncated = true;
    }
    // Lossy decode — non-UTF-8 bytes become U+FFFD rather than crashing.
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    text = text.replace(ANSI_RE, '');
    text = collapseCarriageReturns(text);
    // Line cap — keep the last MAX_OUTPUT_LINES.
    const lines = text.split('\n');
    if (lines.length > MAX_OUTPUT_LINES) {
      text = lines.slice(lines.length - MAX_OUTPUT_LINES).join('\n');
      truncated = true;
    }
    return { text, truncated };
  }
}

/**
 * Collapse carriage returns within each line: `a\rb\rc` -> `c` (a terminal
 * overwrites from column 0 on each `\r`). A trailing `\r` on a line is dropped.
 * `\r\n` is treated as a line break (handled by splitting on `\n` first).
 * @param text - The text to process.
 * @returns The text with carriage returns collapsed.
 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      // Each `\r` resets the cursor to column 0; for plain logs (progress bars
      // etc.) the simplest faithful rendering is "the last segment wins". A
      // *trailing* `\r` (e.g. `one\r` left over from a `\r\n` we already split
      // on `\n`) leaves an empty final segment — drop trailing empties so the
      // line's real content survives.
      // `String.prototype.split` always yields a non-empty array, and the
      // while-loop only pops while length > 1, so `segments` still has ≥1
      // element here — the last one is the rendered line.
      const segments = line.split('\r');
      while (segments.length > 1 && segments[segments.length - 1] === '') {
        segments.pop();
      }
      return segments[segments.length - 1];
    })
    .join('\n');
}

/**
 * Strip ANSI escape sequences from a string (exposed for testing/reuse).
 * @param text - The text to clean.
 * @returns The text with ANSI sequences removed.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
