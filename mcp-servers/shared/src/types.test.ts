import { describe, it, expect } from 'vitest';
import type { Tool } from './types.js';

describe('Tool interface', () => {
  it('supports base fields only (backward compatible)', () => {
    const tool: Tool = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    };

    expect(tool.name).toBe('test_tool');
    expect(tool.category).toBeUndefined();
    expect(tool.keywords).toBeUndefined();
    expect(tool.example).toBeUndefined();
    expect(tool.outputSchema).toBeUndefined();
  });

  it('supports enriched fields (category, keywords, example, outputSchema)', () => {
    const tool: Tool = {
      name: 'create_issue',
      description: 'Creates a new issue',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          subject: { type: 'string' },
        },
        required: ['project_id', 'subject'],
      },
      category: 'write',
      keywords: ['redmine', 'issue', 'create', 'ticket'],
      example: 'await redmine.createIssue({ project_id: "my-project", subject: "Bug fix" })',
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          subject: { type: 'string' },
        },
      },
      inputExamples: [
        {
          description: 'Minimal: create with required fields only',
          input: { project_id: 'my-project', subject: 'New issue' },
        },
      ],
    };

    expect(tool.category).toBe('write');
    expect(tool.keywords).toEqual(['redmine', 'issue', 'create', 'ticket']);
    expect(tool.example).toContain('createIssue');
    expect(tool.outputSchema).toBeDefined();
    expect(tool.inputExamples).toHaveLength(1);
  });

  it('accepts all valid category values', () => {
    const categories: Array<Tool['category']> = ['read', 'write', 'delete'];

    for (const category of categories) {
      const tool: Tool = {
        name: `${category}_tool`,
        description: `A ${category} tool`,
        inputSchema: { type: 'object', properties: {} },
        category,
      };
      expect(tool.category).toBe(category);
    }
  });
});
