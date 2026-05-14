import { describe, it, expect } from 'vitest';
import {
  HOST_EXEC_META_TOOLS,
  HOST_EXEC_PARAM_NAME_RE,
  HOST_EXEC_PRESETS,
  HOST_EXEC_RECIPE_NAME_RE,
  HOST_EXEC_RESERVED_ENV_KEYS,
  HOST_EXEC_SHELL_LAUNCHERS,
  argParamRefs,
  execBasenameLower,
  isBareParamArg,
  isContainerLifecycleRecipe,
  isStateChangingRecipe,
  joinArgLine,
  parseArgLine,
  renderRecipeCommand,
} from './host-exec';

describe('host-exec model helpers', () => {
  describe('constants', () => {
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

  describe('isContainerLifecycleRecipe', () => {
    it.each([
      [{ exec: 'docker', args: ['compose', 'up', '-d'] }, true],
      [{ exec: 'docker', args: ['compose', 'down'] }, true],
      [{ exec: 'docker-compose', args: ['exec', 'db', 'sh'] }, true],
      [{ exec: 'podman', args: ['compose', 'up'] }, true],
      [{ exec: '/usr/bin/docker', args: ['compose', 'rm', '-f'] }, true],
      [{ exec: 'docker', args: ['system', 'prune'] }, true],
      [{ exec: 'docker', args: ['compose', 'ps'] }, false],
      [{ exec: 'docker', args: ['build', '-t', 'x', '.'] }, false],
      [{ exec: 'docker', args: ['compose', 'logs'] }, false],
      [{ exec: './gradlew', args: ['up'] }, false], // not a container engine
      [{ exec: 'npm', args: ['run', 'build'] }, false],
    ])('%j → %s', (cmd, flagged) => {
      expect(isContainerLifecycleRecipe(cmd)).toBe(flagged);
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
    it('flags container-lifecycle recipes (via isContainerLifecycleRecipe)', () => {
      expect(isStateChangingRecipe({ exec: 'docker', args: ['compose', 'up', '-d'] })).toBe(true);
      expect(isStateChangingRecipe({ exec: 'podman', args: ['compose', 'down'] })).toBe(true);
      expect(isStateChangingRecipe({ exec: 'docker-compose', args: ['exec', 'db', 'sh'] })).toBe(
        true
      );
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

  describe('parseArgLine', () => {
    it('splits on runs of whitespace', () => {
      expect(parseArgLine('ps -a')).toEqual({ args: ['ps', '-a'] });
      expect(parseArgLine('  test   --watch  ')).toEqual({ args: ['test', '--watch'] });
      expect(parseArgLine('compose\tup -d')).toEqual({ args: ['compose', 'up', '-d'] });
    });
    it('honours double and single quotes for an argument with a space', () => {
      expect(parseArgLine('--filter "name=foo bar"')).toEqual({
        args: ['--filter', 'name=foo bar'],
      });
      expect(parseArgLine("-c 'SELECT * FROM t'")).toEqual({ args: ['-c', 'SELECT * FROM t'] });
      expect(parseArgLine('"two words" then one')).toEqual({
        args: ['two words', 'then', 'one'],
      });
      // empty quoted token survives as ''
      expect(parseArgLine('ps ""')).toEqual({ args: ['ps', ''] });
    });
    it('is NOT a shell — $VAR / && / | / ; / globs pass through literally', () => {
      expect(parseArgLine('ps; rm -rf x')).toEqual({ args: ['ps;', 'rm', '-rf', 'x'] });
      expect(parseArgLine('echo $HOME && echo done')).toEqual({
        args: ['echo', '$HOME', '&&', 'echo', 'done'],
      });
      expect(parseArgLine('cat *.log | grep e')).toEqual({
        args: ['cat', '*.log', '|', 'grep', 'e'],
      });
    });
    it('keeps {name} tokens intact (whole token or embedded)', () => {
      expect(parseArgLine('test --tests={class}')).toEqual({
        args: ['test', '--tests={class}'],
      });
      expect(parseArgLine('-c {sql}')).toEqual({ args: ['-c', '{sql}'] });
    });
    it('errors on an unbalanced quote', () => {
      expect(parseArgLine('--filter "name=foo')).toEqual({
        error: 'Unbalanced quote in the argument line.',
      });
      expect(parseArgLine("-c 'SELECT")).toEqual({
        error: 'Unbalanced quote in the argument line.',
      });
    });
    it('empty / whitespace-only line → empty args', () => {
      expect(parseArgLine('')).toEqual({ args: [] });
      expect(parseArgLine('   \t  ')).toEqual({ args: [] });
    });
  });

  describe('joinArgLine', () => {
    it('joins with spaces, quoting tokens that contain whitespace or are empty', () => {
      expect(joinArgLine(['ps', '-a'])).toBe('ps -a');
      expect(joinArgLine(['--filter', 'name=foo bar'])).toBe('--filter "name=foo bar"');
      expect(joinArgLine(['ps', ''])).toBe('ps ""');
      expect(joinArgLine([])).toBe('');
    });
    it('round-trips with parseArgLine for the shapes the UI produces', () => {
      for (const args of [
        ['test'],
        ['ps', '-a'],
        ['test', '--tests={class}'],
        ['-c', 'SELECT * FROM t'],
        ['compose', 'up', '-d'],
        ['ps', ''],
      ]) {
        expect(parseArgLine(joinArgLine(args))).toEqual({ args });
      }
    });
  });

  describe('HOST_EXEC_PRESETS', () => {
    it('each preset is well-formed (snake_case name, parseable argLine, valid params)', () => {
      expect(HOST_EXEC_PRESETS.length).toBeGreaterThan(0);
      for (const p of HOST_EXEC_PRESETS) {
        expect(HOST_EXEC_RECIPE_NAME_RE.test(p.name)).toBe(true);
        const parsed = parseArgLine(p.argLine);
        expect('args' in parsed).toBe(true);
        if ('args' in parsed) {
          // every {token} in the preset's args has a matching param
          const paramNames = new Set(p.params.map((x) => x.name));
          for (const a of parsed.args) {
            for (const ref of argParamRefs(a)) expect(paramNames.has(ref)).toBe(true);
          }
        }
        for (const param of p.params) {
          expect(HOST_EXEC_PARAM_NAME_RE.test(param.name)).toBe(true);
          expect(() => new RegExp(param.pattern)).not.toThrow();
        }
        expect(p.execHint.length).toBeGreaterThan(0);
        expect(p.key.length).toBeGreaterThan(0);
        expect(p.label.length).toBeGreaterThan(0);
      }
    });
    it('the named-test gradle preset ships a `test_class` param token its argLine uses', () => {
      const p = HOST_EXEC_PRESETS.find((x) => x.key === 'gradle-test-named');
      expect(p).toBeDefined();
      expect(p!.argLine).toContain('{test_class}');
      expect(p!.params.some((x) => x.name === 'test_class')).toBe(true);
    });
  });
});
