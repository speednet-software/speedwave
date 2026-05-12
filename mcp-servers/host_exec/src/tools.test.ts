import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildInputSchema,
  buildToolDefinition,
  buildToolHandler,
  buildTools,
  renderCommand,
} from './tools.js';
import type { HostExecConfigSnapshot, HostExecRecipe } from './types.js';

const NODE = process.execPath;

function recipe(p: Partial<HostExecRecipe> & Pick<HostExecRecipe, 'name' | 'exec'>): HostExecRecipe {
  return { args: [], ...p };
}

/** Extract the first text-content string from a tool result (for assertions). */
function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  const first = res.content[0];
  expect(first?.type).toBe('text');
  return first?.text ?? '';
}

describe('renderCommand', () => {
  it('joins exec and args', () => {
    expect(
      renderCommand(recipe({ name: 't', exec: './gradlew', args: ['test', '-x', 'lint'] }))
    ).toBe('./gradlew test -x lint');
  });
});

describe('buildInputSchema', () => {
  it('produces an object schema with declared params required', () => {
    const s = buildInputSchema(
      recipe({
        name: 'psql',
        exec: 'docker',
        args: ['psql', '-c', '{sql}'],
        params: [{ name: 'sql', pattern: '^SELECT.*$', maxLen: 500 }],
      })
    );
    expect(s.type).toBe('object');
    expect(s.required).toEqual(['sql']);
    const sqlProp = (
      s.properties as Record<string, { type: string; pattern: string; maxLength?: number }>
    ).sql;
    expect(sqlProp.type).toBe('string');
    expect(sqlProp.pattern).toBe('^SELECT.*$');
    expect(sqlProp.maxLength).toBe(500);
  });
  it('omits `required` when there are no params', () => {
    const s = buildInputSchema(recipe({ name: 't', exec: './gradlew', args: ['test'] }));
    expect(s.type).toBe('object');
    expect(s.properties).toEqual({});
    expect('required' in s).toBe(false);
  });
  it('omits maxLength when not set', () => {
    const s = buildInputSchema(
      recipe({ name: 't', exec: './t', args: ['{p}'], params: [{ name: 'p', pattern: '.*' }] })
    );
    const prop = (s.properties as Record<string, { maxLength?: number }>).p;
    expect('maxLength' in prop).toBe(false);
  });
});

describe('buildToolDefinition', () => {
  it('names the tool after the recipe and renders the command + example', () => {
    const t = buildToolDefinition(recipe({ name: 'gradle_help', exec: './gradlew', args: ['help'] }));
    expect(t.name).toBe('gradle_help');
    expect(t.description).toContain('`./gradlew help`');
    expect(t.description).toContain("project's directory");
    expect(t.description).toMatch(/non-zero exit code is a normal result/i);
    // example uses the camelCase form the hub exposes
    expect(t.example).toBe('const r = await host_exec.gradleHelp()');
  });
  it('mentions the subdirectory when cwdSub is set', () => {
    const t = buildToolDefinition(
      recipe({ name: 'fe_build', exec: 'npm', args: ['run', 'build'], cwdSub: 'frontend' })
    );
    expect(t.description).toContain("subdirectory 'frontend'");
  });
  it('shows parameters in the example', () => {
    const t = buildToolDefinition(
      recipe({
        name: 'psql',
        exec: 'docker',
        args: ['psql', '-c', '{sql}'],
        params: [{ name: 'sql', pattern: '.*' }],
      })
    );
    expect(t.example).toBe('const r = await host_exec.psql({ sql: "…" })');
  });
  it('sets _meta with deferLoading:false, timeoutClass:long, and a timeoutMs', () => {
    const t = buildToolDefinition(recipe({ name: 't', exec: './t', args: [] }));
    expect(t._meta).toBeDefined();
    expect(t._meta?.deferLoading).toBe(false);
    expect(t._meta?.timeoutClass).toBe('long');
    expect(typeof t._meta?.timeoutMs).toBe('number');
    expect(t._meta?.timeoutMs as number).toBeGreaterThan(0);
  });
  it('declares an outputSchema describing the result contract', () => {
    const t = buildToolDefinition(recipe({ name: 't', exec: './t', args: [] }));
    const props = (t.outputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(
      [
        'command',
        'cwd',
        'durationMs',
        'exitCode',
        'signal',
        'status',
        'stderr',
        'stdout',
        'truncated',
      ].sort()
    );
  });
});

describe('buildToolHandler / buildTools', () => {
  let proj: string;
  let configPath: string;

  async function writeSnapshot(commands: HostExecRecipe[]): Promise<void> {
    const snap: HostExecConfigSnapshot = { projectDir: proj, commands };
    await fs.writeFile(configPath, JSON.stringify(snap), 'utf-8');
  }

  beforeEach(async () => {
    proj = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-tools-')));
    configPath = path.join(proj, 'config.json');
    delete process.env.HOST_EXEC_LOG_FILE;
  });
  afterEach(async () => {
    await fs.rm(proj, { recursive: true, force: true });
  });

  it('handler returns the result as JSON on success', async () => {
    await writeSnapshot([
      recipe({ name: 'hi', exec: NODE, args: ['-e', 'process.stdout.write("yo")'] }),
    ]);
    const handler = buildToolHandler('hi', configPath);
    const res = await handler({});
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(textOf(res));
    expect(payload.status).toBe('exited');
    expect(payload.exitCode).toBe(0);
    expect(payload.stdout).toBe('yo');
    expect(payload.command).toBe('hi');
  });

  it('handler returns an MCP error result on a tool error', async () => {
    await writeSnapshot([recipe({ name: 'present', exec: NODE, args: ['-e', '0'] })]);
    const handler = buildToolHandler('not-present', configPath);
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no host_exec recipe named 'not-present'/);
  });

  it('buildTools produces one {tool,handler} per recipe', async () => {
    await writeSnapshot([
      recipe({ name: 'a', exec: NODE, args: ['-e', '0'] }),
      recipe({ name: 'b', exec: NODE, args: ['-e', '0'] }),
    ]);
    const snap: HostExecConfigSnapshot = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const defs = buildTools(snap.commands, configPath);
    expect(defs.map((d) => d.tool.name)).toEqual(['a', 'b']);
    expect(defs.every((d) => typeof d.handler === 'function')).toBe(true);
  });
});
