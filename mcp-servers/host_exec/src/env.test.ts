import { describe, it, expect, afterEach } from 'vitest';
import { buildRecipeEnv, SAFE_ENV_KEYS } from './env.js';

describe('SAFE_ENV_KEYS', () => {
  it('does not include any HOST_EXEC_* key', () => {
    for (const k of SAFE_ENV_KEYS) {
      expect(k.startsWith('HOST_EXEC_')).toBe(false);
    }
  });
  it('includes the toolchain locators recipes commonly need', () => {
    for (const k of ['PATH', 'HOME', 'JAVA_HOME', 'DOCKER_HOST', 'GRADLE_USER_HOME']) {
      expect(SAFE_ENV_KEYS).toContain(k);
    }
  });
});

describe('buildRecipeEnv', () => {
  const savedEnv: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  });

  it('passes through allowlisted keys from the worker env', () => {
    setEnv('PATH', '/usr/bin:/bin');
    setEnv('JAVA_HOME', '/opt/jdk-21');
    const env = buildRecipeEnv();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.JAVA_HOME).toBe('/opt/jdk-21');
  });

  it('NEVER passes HOST_EXEC_* through, even if set in the worker env', () => {
    setEnv('HOST_EXEC_AUTH_TOKEN', 'super-secret-token');
    setEnv('HOST_EXEC_CONFIG_PATH', '/x/config.json');
    setEnv('HOST_EXEC_LOG_FILE', '/x/log');
    setEnv('PORT', '12345');
    const env = buildRecipeEnv();
    expect(env.HOST_EXEC_AUTH_TOKEN).toBeUndefined();
    expect(env.HOST_EXEC_CONFIG_PATH).toBeUndefined();
    expect(env.HOST_EXEC_LOG_FILE).toBeUndefined();
    // PORT isn't on the allowlist either.
    expect(env.PORT).toBeUndefined();
  });

  it('does not pass arbitrary worker-env keys', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-should-not-leak');
    setEnv('SOME_RANDOM_VAR', 'whatever');
    const env = buildRecipeEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
  });

  it('overlays the recipe env map on top of the allowlist', () => {
    setEnv('PATH', '/usr/bin');
    const env = buildRecipeEnv({ SPRING_PROFILES_ACTIVE: 'test', CI: 'true' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.SPRING_PROFILES_ACTIVE).toBe('test');
    expect(env.CI).toBe('true');
  });

  it('does not let a recipe env map smuggle HOST_EXEC_* (defensive)', () => {
    // The Rust validator already rejects RESERVED_ENV_KEYS, but HOST_EXEC_* is
    // not on that list — the worker drops it as a second line of defence.
    const env = buildRecipeEnv({
      HOST_EXEC_AUTH_TOKEN: 'leak',
      host_exec_x: 'leak2',
      NORMAL: 'ok',
    });
    expect(env.HOST_EXEC_AUTH_TOKEN).toBeUndefined();
    expect(env.host_exec_x).toBeUndefined();
    expect(env.NORMAL).toBe('ok');
  });
});
