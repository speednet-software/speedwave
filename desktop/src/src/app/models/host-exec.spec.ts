import { describe, it, expect } from 'vitest';
import {
  HOST_EXEC_CONFIRM_EVENT,
  HOST_EXEC_META_TOOLS,
  HOST_EXEC_PARAM_NAME_RE,
  HOST_EXEC_RECIPE_NAME_RE,
  HOST_EXEC_RESERVED_ENV_KEYS,
  HOST_EXEC_SHELL_LAUNCHERS,
  argParamRefs,
  execBasenameLower,
  isBareParamArg,
  isStateChangingRecipe,
  renderRecipeCommand,
} from './host-exec';

describe('host-exec model helpers', () => {
  describe('constants', () => {
    it('exposes the worker confirm-event name', () => {
      expect(HOST_EXEC_CONFIRM_EVENT).toBe('host-exec://confirm-request');
    });
    it('lists the shell/eval launchers (matches the Rust SSOT)', () => {
      expect(HOST_EXEC_SHELL_LAUNCHERS).toContain('bash');
      expect(HOST_EXEC_SHELL_LAUNCHERS).toContain('eval');
      expect(HOST_EXEC_SHELL_LAUNCHERS).toContain('xargs');
      expect(HOST_EXEC_SHELL_LAUNCHERS).not.toContain('node'); // node is a meta-tool, not a launcher
    });
    it('lists the meta-tools', () => {
      expect(HOST_EXEC_META_TOOLS).toContain('npm');
      expect(HOST_EXEC_META_TOOLS).toContain('make');
      expect(HOST_EXEC_META_TOOLS).toContain('node');
    });
    it('lists the reserved env keys', () => {
      expect(HOST_EXEC_RESERVED_ENV_KEYS).toContain('PATH');
      expect(HOST_EXEC_RESERVED_ENV_KEYS).toContain('LD_PRELOAD');
      expect(HOST_EXEC_RESERVED_ENV_KEYS).toContain('NODE_OPTIONS');
    });
  });

  describe('HOST_EXEC_RECIPE_NAME_RE / HOST_EXEC_PARAM_NAME_RE', () => {
    it.each([
      ['gradle_test', true],
      ['t', true],
      ['a1', true],
      ['build_loop_42', true],
      ['Test', false], // uppercase
      ['1build', false], // leading digit
      ['has-dash', false], // hyphen not allowed (camelCase bridge needs underscore)
      ['has space', false],
      ['', false],
      ['x'.repeat(65), false], // > 64
    ])('%s → %s', (name, ok) => {
      expect(HOST_EXEC_RECIPE_NAME_RE.test(name)).toBe(ok);
      expect(HOST_EXEC_PARAM_NAME_RE.test(name)).toBe(ok);
    });
  });

  describe('execBasenameLower', () => {
    it.each([
      ['./gradlew', 'gradlew'],
      ['/opt/homebrew/bin/gradle', 'gradle'],
      ['npm', 'npm'],
      ['C:\\tools\\docker.exe', 'docker'],
      ['DOCKER.EXE', 'docker'],
      ['Make.BAT', 'make'],
      ['node_modules/.bin/node', 'node'], // a residual: bans are by basename, not by path
      ['', ''],
    ])('%s → %s', (exec, base) => {
      expect(execBasenameLower(exec)).toBe(base);
    });
  });

  describe('argParamRefs', () => {
    it.each([
      ['{tgt}', ['tgt']],
      ['--out={dir}/build', ['dir']],
      ['--a={x} --b={y}', ['x', 'y']],
      ['test', []],
      ['{Bad}', []], // uppercase not a valid token name
      ['', []],
    ])('%s → %j', (arg, refs) => {
      expect(argParamRefs(arg)).toEqual(refs);
    });
  });

  describe('isBareParamArg', () => {
    it.each([
      ['{cmd}', true],
      ['{x}', true],
      ['run {x}', false],
      ['--out={x}', false],
      ['test', false],
      ['{x}{y}', false],
      ['', false],
    ])('%s → %s', (arg, bare) => {
      expect(isBareParamArg(arg)).toBe(bare);
    });
  });

  describe('isStateChangingRecipe', () => {
    it('flags database clients', () => {
      for (const exec of [
        'psql',
        'mysql',
        'mysqlsh',
        'mongo',
        'mongosh',
        'sqlite3',
        '/usr/bin/psql',
      ]) {
        expect(isStateChangingRecipe({ exec, args: ['-c', 'SELECT 1'] })).toBe(true);
      }
    });
    it('flags docker compose up / down / exec / rm / prune', () => {
      expect(isStateChangingRecipe({ exec: 'docker', args: ['compose', 'up', '-d'] })).toBe(true);
      expect(isStateChangingRecipe({ exec: 'docker', args: ['compose', 'down'] })).toBe(true);
      expect(isStateChangingRecipe({ exec: 'docker-compose', args: ['exec', 'db', 'sh'] })).toBe(
        true
      );
      expect(isStateChangingRecipe({ exec: 'docker', args: ['system', 'prune'] })).toBe(true);
    });
    it('flags migration tooling in args', () => {
      expect(isStateChangingRecipe({ exec: './gradlew', args: ['flywayMigrate'] })).toBe(true);
      expect(isStateChangingRecipe({ exec: 'npm', args: ['run', 'db:migrate'] })).toBe(true);
      expect(isStateChangingRecipe({ exec: 'mvn', args: ['liquibase:update'] })).toBe(true);
    });
    it('does NOT flag plain build/test commands', () => {
      expect(isStateChangingRecipe({ exec: './gradlew', args: ['test'] })).toBe(false);
      expect(isStateChangingRecipe({ exec: 'npm', args: ['run', 'build'] })).toBe(false);
      expect(isStateChangingRecipe({ exec: 'docker', args: ['ps'] })).toBe(false);
      expect(isStateChangingRecipe({ exec: 'docker', args: ['compose', 'ps'] })).toBe(false);
    });
  });

  describe('renderRecipeCommand', () => {
    it('joins exec + args with spaces, keeping tokens', () => {
      expect(renderRecipeCommand({ exec: './gradlew', args: ['test', '--tests={class}'] })).toBe(
        './gradlew test --tests={class}'
      );
      expect(renderRecipeCommand({ exec: 'docker', args: [] })).toBe('docker');
    });
  });
});
