/**
 * Guards the client-teaching-message tool-name SSOT: every name the client embeds
 * in a teaching error must resolve to a registered tool.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOL_NAMES } from './tool-names.js';
import { createToolDefinitions } from './tools/index.js';

const REGISTERED = new Set(createToolDefinitions(null).map((d) => d.tool.name));

describe('TOOL_NAMES SSOT', () => {
  it.each(Object.entries(TOOL_NAMES))('%s resolves to a registered tool', (_key, name) => {
    expect(REGISTERED.has(name)).toBe(true);
  });

  it('client teaching messages reference only tool names from the SSOT', () => {
    const clientSrc = readFileSync(fileURLToPath(new URL('./client.ts', import.meta.url)), 'utf-8');
    // Every registered tool name that the client mentions must be routed through TOOL_NAMES, not a raw literal.
    const ssotValues = new Set<string>(Object.values(TOOL_NAMES));
    for (const name of REGISTERED) {
      if (ssotValues.has(name)) continue;
      expect(
        clientSrc.includes(`'${name}'`) || clientSrc.includes(`\`${name}\``),
        `client.ts embeds tool name "${name}" as a raw literal instead of via TOOL_NAMES`
      ).toBe(false);
    }
  });
});
