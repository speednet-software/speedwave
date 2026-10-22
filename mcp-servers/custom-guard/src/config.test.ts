import { describe, it, expect } from 'vitest';
import {
  authTokenEnvFor,
  DEFAULT_POLICY_FILE,
  DEFAULT_RELAY_DIR,
  GuardConfigError,
  isValidServerName,
  readGuardConfig,
} from './config.js';

const npmEnv = {
  SPW_CUSTOM_SERVER: 'figma',
  SPW_CUSTOM_MODE: 'npm',
  SPW_UPSTREAM_URL: 'http://mcp-custom-figma-up:3000/',
  SPW_UPSTREAM_AUTH_TOKEN: 'upstream-secret',
};

const hostEnv = {
  SPW_CUSTOM_SERVER: 'figma-desk',
  SPW_CUSTOM_MODE: 'host',
  SPW_HOST_PROJECT_DIR: '/Users/a/proj',
  SPW_HOST_PATH_STYLE: 'posix',
};

describe('authTokenEnvFor', () => {
  it('derives the bearer env name the compose renderer writes', () => {
    expect(authTokenEnvFor('custom-figma')).toBe('MCP_CUSTOM_FIGMA_AUTH_TOKEN');
    expect(authTokenEnvFor('custom-figma-desk')).toBe('MCP_CUSTOM_FIGMA_DESK_AUTH_TOKEN');
  });
});

describe('isValidServerName', () => {
  it.each(['a', 'figma', 'figma-desk', 'x1', `a${'b'.repeat(30)}`])('accepts %s', (name) => {
    expect(isValidServerName(name)).toBe(true);
  });

  it.each([
    '',
    '1abc',
    'Figma',
    'fig_ma',
    'figma.desk',
    `a${'b'.repeat(31)}`,
    'figma-up',
    'figma-egress',
    'żółw',
  ])('rejects %j', (name) => {
    expect(isValidServerName(name)).toBe(false);
  });
});

describe('readGuardConfig', () => {
  it('reads an npm-mode configuration with defaults', () => {
    expect(readGuardConfig(npmEnv)).toEqual({
      serverName: 'figma',
      serviceId: 'custom-figma',
      authTokenEnv: 'MCP_CUSTOM_FIGMA_AUTH_TOKEN',
      policyFile: DEFAULT_POLICY_FILE,
      upstream: {
        mode: 'npm',
        url: 'http://mcp-custom-figma-up:3000/',
        authToken: 'upstream-secret',
      },
    });
  });

  it('reads a host-mode configuration with defaults', () => {
    expect(readGuardConfig(hostEnv)).toEqual({
      serverName: 'figma-desk',
      serviceId: 'custom-figma-desk',
      authTokenEnv: 'MCP_CUSTOM_FIGMA_DESK_AUTH_TOKEN',
      policyFile: DEFAULT_POLICY_FILE,
      upstream: {
        mode: 'host',
        relayDir: DEFAULT_RELAY_DIR,
        hostDir: '/Users/a/proj',
        pathStyle: 'posix',
      },
    });
  });

  it('honours explicit policy file and relay directory', () => {
    const config = readGuardConfig({
      ...hostEnv,
      SPW_HOST_PATH_STYLE: 'unc',
      SPW_HOST_PROJECT_DIR: '\\\\wsl.localhost\\Ubuntu\\home\\a\\proj',
      POLICY_FILE: '/elsewhere/policy.json',
      SPW_RELAY_DIR: '/relay',
    });
    expect(config.policyFile).toBe('/elsewhere/policy.json');
    expect(config.upstream).toEqual({
      mode: 'host',
      relayDir: '/relay',
      hostDir: '\\\\wsl.localhost\\Ubuntu\\home\\a\\proj',
      pathStyle: 'unc',
    });
  });

  it.each([
    [{ ...npmEnv, SPW_CUSTOM_SERVER: undefined }, /SPW_CUSTOM_SERVER is required/],
    [{ ...npmEnv, SPW_CUSTOM_SERVER: '  ' }, /SPW_CUSTOM_SERVER is required/],
    [{ ...npmEnv, SPW_CUSTOM_SERVER: 'Bad' }, /must match/],
    [{ ...npmEnv, SPW_CUSTOM_SERVER: 'figma-up' }, /must not end in -up/],
    [{ ...npmEnv, SPW_CUSTOM_MODE: undefined }, /SPW_CUSTOM_MODE is required/],
    [{ ...npmEnv, SPW_CUSTOM_MODE: 'stdio' }, /must be npm or host/],
    [{ ...npmEnv, SPW_UPSTREAM_URL: undefined }, /SPW_UPSTREAM_URL is required/],
    [{ ...npmEnv, SPW_UPSTREAM_URL: 'https://evil.example/' }, /must be an http/],
    [{ ...npmEnv, SPW_UPSTREAM_URL: 'http://127.0.0.1:3000/' }, /must be an http/],
    [{ ...npmEnv, SPW_UPSTREAM_AUTH_TOKEN: '' }, /SPW_UPSTREAM_AUTH_TOKEN is required/],
    [{ ...hostEnv, SPW_HOST_PROJECT_DIR: undefined }, /SPW_HOST_PROJECT_DIR is required/],
    [{ ...hostEnv, SPW_HOST_PATH_STYLE: undefined }, /SPW_HOST_PATH_STYLE is required/],
    [{ ...hostEnv, SPW_HOST_PATH_STYLE: 'mac' }, /posix, windows or unc/],
  ])('rejects %j', (env, message) => {
    expect(() => readGuardConfig(env)).toThrow(GuardConfigError);
    expect(() => readGuardConfig(env)).toThrow(message);
  });

  it('never puts a secret value in an error message', () => {
    try {
      readGuardConfig({ ...npmEnv, SPW_UPSTREAM_URL: 'http://user:secret-pass@mcp-x:1/' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-pass');
      expect((error as Error).name).toBe('GuardConfigError');
    }
  });
});
