/**
 * Every OS tool's inputExamples must satisfy its own inputSchema
 * (required present, no unknown props, declared types).
 */

import { describe, it, expect, vi } from 'vitest';
import { createReminderTools } from './reminder-tools.js';
import { createCalendarTools } from './calendar-tools.js';
import { createMailTools } from './mail-tools.js';
import { createNoteTools } from './notes-tools.js';

vi.mock('../platform-runner.js', () => ({ runCommand: vi.fn() }));

const ALL_TOOLS = [
  ...createReminderTools(),
  ...createCalendarTools(),
  ...createMailTools(),
  ...createNoteTools(),
];

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

function typeMatches(schemaType: string | undefined, value: unknown): boolean {
  switch (schemaType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/** Return a list of schema-violation messages for an example input; empty means valid. */
function schemaViolations(schema: JsonSchema, input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const props = schema.properties ?? {};
  for (const req of schema.required ?? []) {
    if (!(req in input)) errors.push(`missing required '${req}'`);
  }
  for (const [key, value] of Object.entries(input)) {
    const propSchema = props[key];
    if (!propSchema) {
      errors.push(`unknown property '${key}'`);
      continue;
    }
    if (!typeMatches(propSchema.type, value)) {
      const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      errors.push(`'${key}' expected ${propSchema.type}, got ${actual}`);
    }
  }
  return errors;
}

describe('OS tool inputExamples align with inputSchema', () => {
  describe.each(ALL_TOOLS.map((td) => [td.tool.name, td] as const))('%s', (_name, td) => {
    it('every inputExample input validates against inputSchema', () => {
      const schema = td.tool.inputSchema as JsonSchema;
      for (const ex of td.tool.inputExamples ?? []) {
        const errors = schemaViolations(schema, ex.input as Record<string, unknown>);
        expect(errors, `${td.tool.name} example "${ex.description}": ${errors.join('; ')}`).toEqual(
          []
        );
      }
    });
  });
});
