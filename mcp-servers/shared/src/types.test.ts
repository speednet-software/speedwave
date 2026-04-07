import { describe, it, expect } from 'vitest';
import type {
  Tool,
  ToolAnnotations,
  ToolsCallResult,
  ProcessRequestResult,
  ServerCapabilities,
} from './types.js';
import { READ_ONLY_ANNOTATIONS, WRITE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS } from './types.js';

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
    expect(tool.keywords).toBeUndefined();
    expect(tool.example).toBeUndefined();
    expect(tool.outputSchema).toBeUndefined();
    expect(tool.title).toBeUndefined();
    expect(tool.icons).toBeUndefined();
    expect(tool.execution).toBeUndefined();
    expect(tool.annotations).toBeUndefined();
    expect(tool._meta).toBeUndefined();
  });

  it('supports enriched fields (keywords, example, outputSchema)', () => {
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

    expect(tool.keywords).toEqual(['redmine', 'issue', 'create', 'ticket']);
    expect(tool.example).toContain('createIssue');
    expect(tool.outputSchema).toBeDefined();
    expect(tool.inputExamples).toHaveLength(1);
  });

  it('supports title field', () => {
    const tool: Tool = {
      name: 'get_user',
      description: 'Fetches a user by ID',
      title: 'Get User',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    };

    expect(tool.title).toBe('Get User');
  });

  it('supports icons field with full metadata', () => {
    const tool: Tool = {
      name: 'search',
      description: 'Search documents',
      inputSchema: { type: 'object', properties: {} },
      icons: [
        {
          src: 'https://example.com/icon.svg',
          mimeType: 'image/svg+xml',
          sizes: ['32x32', '64x64'],
        },
        { src: '/icons/search.png' },
      ],
    };

    expect(tool.icons).toHaveLength(2);
    expect(tool.icons![0].src).toBe('https://example.com/icon.svg');
    expect(tool.icons![0].mimeType).toBe('image/svg+xml');
    expect(tool.icons![0].sizes).toEqual(['32x32', '64x64']);
    expect(tool.icons![1].mimeType).toBeUndefined();
    expect(tool.icons![1].sizes).toBeUndefined();
  });

  it('supports icons field with empty array', () => {
    const tool: Tool = {
      name: 'no_icons',
      description: 'Tool with empty icons array',
      inputSchema: { type: 'object', properties: {} },
      icons: [],
    };

    expect(tool.icons).toEqual([]);
  });

  it('supports execution field with all taskSupport values', () => {
    const values: Array<'forbidden' | 'optional' | 'required'> = [
      'forbidden',
      'optional',
      'required',
    ];

    for (const taskSupport of values) {
      const tool: Tool = {
        name: `task_${taskSupport}`,
        description: `Tool with taskSupport=${taskSupport}`,
        inputSchema: { type: 'object', properties: {} },
        execution: { taskSupport },
      };
      expect(tool.execution!.taskSupport).toBe(taskSupport);
    }
  });

  it('supports annotations field', () => {
    const tool: Tool = {
      name: 'delete_file',
      description: 'Deletes a file from the workspace',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      annotations: {
        title: 'Delete File',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    };

    expect(tool.annotations!.title).toBe('Delete File');
    expect(tool.annotations!.readOnlyHint).toBe(false);
    expect(tool.annotations!.destructiveHint).toBe(true);
    expect(tool.annotations!.idempotentHint).toBe(true);
    expect(tool.annotations!.openWorldHint).toBe(false);
  });

  it('supports _meta field with arbitrary vendor data', () => {
    const tool: Tool = {
      name: 'vendor_tool',
      description: 'Tool with vendor-specific metadata',
      inputSchema: { type: 'object', properties: {} },
      _meta: {
        vendor: 'speedwave',
        version: 2,
        experimental: true,
        nested: { key: 'value' },
      },
    };

    expect(tool._meta!['vendor']).toBe('speedwave');
    expect(tool._meta!['version']).toBe(2);
    expect(tool._meta!['experimental']).toBe(true);
    expect(tool._meta!['nested']).toEqual({ key: 'value' });
  });

  it('supports _meta field as empty object', () => {
    const tool: Tool = {
      name: 'empty_meta',
      description: 'Tool with empty _meta',
      inputSchema: { type: 'object', properties: {} },
      _meta: {},
    };

    expect(tool._meta).toEqual({});
  });

  it('supports all new fields together', () => {
    const tool: Tool = {
      name: 'full_tool',
      description: 'Tool exercising all new fields',
      title: 'Full Tool',
      inputSchema: { type: 'object', properties: {} },
      icons: [{ src: '/icon.png' }],
      execution: { taskSupport: 'optional' },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { source: 'test' },
    };

    expect(tool.title).toBe('Full Tool');
    expect(tool.icons).toHaveLength(1);
    expect(tool.execution!.taskSupport).toBe('optional');
    expect(tool.annotations!.readOnlyHint).toBe(true);
    expect(tool.annotations!.destructiveHint).toBe(false);
    expect(tool._meta!['source']).toBe('test');
  });
});

describe('ToolAnnotations interface', () => {
  it('allows all hints to be set', () => {
    const annotations: ToolAnnotations = {
      title: 'Read File',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };

    expect(annotations.title).toBe('Read File');
    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.destructiveHint).toBe(false);
    expect(annotations.idempotentHint).toBe(true);
    expect(annotations.openWorldHint).toBe(false);
  });

  it('allows empty annotations (all optional)', () => {
    const annotations: ToolAnnotations = {};

    expect(annotations.title).toBeUndefined();
    expect(annotations.readOnlyHint).toBeUndefined();
    expect(annotations.destructiveHint).toBeUndefined();
    expect(annotations.idempotentHint).toBeUndefined();
    expect(annotations.openWorldHint).toBeUndefined();
  });

  it('allows partial annotations', () => {
    const annotations: ToolAnnotations = {
      readOnlyHint: true,
    };

    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.destructiveHint).toBeUndefined();
  });
});

describe('ProcessRequestResult type', () => {
  it('represents a successful response with session ID', () => {
    const result: ProcessRequestResult = {
      response: {
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [] },
      },
      sessionId: 'abc-123',
    };

    expect(result.response!.jsonrpc).toBe('2.0');
    expect(result.response!.id).toBe(1);
    expect(result.sessionId).toBe('abc-123');
  });

  it('represents a notification (null response)', () => {
    const result: ProcessRequestResult = {
      response: null,
    };

    expect(result.response).toBeNull();
    expect(result.sessionId).toBeUndefined();
  });

  it('represents an error response without session ID', () => {
    const result: ProcessRequestResult = {
      response: {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      },
    };

    expect(result.response!.error!.code).toBe(-32600);
    expect(result.sessionId).toBeUndefined();
  });
});

describe('ToolsCallResult', () => {
  it('supports structuredContent field', () => {
    const result: ToolsCallResult = {
      content: [{ type: 'text', text: 'Done' }],
      structuredContent: {
        id: 42,
        status: 'created',
        tags: ['a', 'b'],
      },
    };

    expect(result.structuredContent!['id']).toBe(42);
    expect(result.structuredContent!['status']).toBe('created');
    expect(result.structuredContent!['tags']).toEqual(['a', 'b']);
  });

  it('supports structuredContent as empty object', () => {
    const result: ToolsCallResult = {
      content: [],
      structuredContent: {},
    };

    expect(result.structuredContent).toEqual({});
  });

  it('allows structuredContent to be omitted', () => {
    const result: ToolsCallResult = {
      content: [{ type: 'text', text: 'hello' }],
    };

    expect(result.structuredContent).toBeUndefined();
  });

  it('supports audio content type', () => {
    const result: ToolsCallResult = {
      content: [{ type: 'audio', data: 'base64-audio-data', mimeType: 'audio/wav' }],
    };

    expect(result.content[0].type).toBe('audio');
    expect(result.content[0].data).toBe('base64-audio-data');
    expect(result.content[0].mimeType).toBe('audio/wav');
  });

  it('supports resource_link content type', () => {
    const result: ToolsCallResult = {
      content: [{ type: 'resource_link', text: 'https://example.com/doc.pdf' }],
    };

    expect(result.content[0].type).toBe('resource_link');
    expect(result.content[0].text).toBe('https://example.com/doc.pdf');
  });

  it('supports mixed content types including new ones', () => {
    const result: ToolsCallResult = {
      content: [
        { type: 'text', text: 'Transcription:' },
        { type: 'audio', data: 'abc123', mimeType: 'audio/mp3' },
        { type: 'resource_link', text: 'See resource' },
        { type: 'image', data: 'img-data', mimeType: 'image/png' },
        { type: 'resource', mimeType: 'application/json' },
      ],
    };

    expect(result.content).toHaveLength(5);
    expect(result.content.map((c) => c.type)).toEqual([
      'text',
      'audio',
      'resource_link',
      'image',
      'resource',
    ]);
  });
});

describe('ServerCapabilities', () => {
  it('supports logging capability', () => {
    const capabilities: ServerCapabilities = {
      tools: { listChanged: true },
      logging: {},
    };

    expect(capabilities.logging).toEqual({});
  });

  it('allows logging to be omitted', () => {
    const capabilities: ServerCapabilities = {
      tools: { listChanged: false },
    };

    expect(capabilities.logging).toBeUndefined();
  });

  it('supports all capabilities together including logging', () => {
    const capabilities: ServerCapabilities = {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: false },
      logging: {},
      experimental: { customFeature: true },
    };

    expect(capabilities.tools!.listChanged).toBe(true);
    expect(capabilities.resources!.subscribe).toBe(true);
    expect(capabilities.prompts!.listChanged).toBe(false);
    expect(capabilities.logging).toEqual({});
    expect(capabilities.experimental!['customFeature']).toBe(true);
  });
});

describe('Annotation constants', () => {
  it('READ_ONLY_ANNOTATIONS marks tool as read-only and non-destructive', () => {
    expect(READ_ONLY_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('WRITE_ANNOTATIONS marks tool as non-read-only and non-destructive', () => {
    expect(WRITE_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('DESTRUCTIVE_ANNOTATIONS marks tool as non-read-only and destructive', () => {
    expect(DESTRUCTIVE_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('all three constants are distinct objects', () => {
    expect(READ_ONLY_ANNOTATIONS).not.toBe(WRITE_ANNOTATIONS);
    expect(WRITE_ANNOTATIONS).not.toBe(DESTRUCTIVE_ANNOTATIONS);
    expect(READ_ONLY_ANNOTATIONS).not.toBe(DESTRUCTIVE_ANNOTATIONS);
  });

  it('constants are assignable to ToolAnnotations', () => {
    const ro: ToolAnnotations = READ_ONLY_ANNOTATIONS;
    const wr: ToolAnnotations = WRITE_ANNOTATIONS;
    const de: ToolAnnotations = DESTRUCTIVE_ANNOTATIONS;
    expect(ro.readOnlyHint).toBe(true);
    expect(wr.readOnlyHint).toBe(false);
    expect(de.destructiveHint).toBe(true);
  });

  it('constants can be used in Tool definitions', () => {
    const readTool: Tool = {
      name: 'readTool',
      description: 'Read-only tool',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ_ONLY_ANNOTATIONS,
    };
    const writeTool: Tool = {
      name: 'writeTool',
      description: 'Write tool',
      inputSchema: { type: 'object', properties: {} },
      annotations: WRITE_ANNOTATIONS,
    };
    const destructiveTool: Tool = {
      name: 'destructiveTool',
      description: 'Destructive tool',
      inputSchema: { type: 'object', properties: {} },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    };

    expect(readTool.annotations!.readOnlyHint).toBe(true);
    expect(readTool.annotations!.destructiveHint).toBe(false);
    expect(writeTool.annotations!.readOnlyHint).toBe(false);
    expect(writeTool.annotations!.destructiveHint).toBe(false);
    expect(destructiveTool.annotations!.readOnlyHint).toBe(false);
    expect(destructiveTool.annotations!.destructiveHint).toBe(true);
  });
});
