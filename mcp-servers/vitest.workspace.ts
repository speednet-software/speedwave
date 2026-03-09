import { defineWorkspace } from 'vitest/config';

const workspaces = ['shared', 'hub', 'slack', 'gitlab', 'gemini', 'redmine', 'sharepoint', 'os'];

export default defineWorkspace(
  workspaces.map((name) => ({
    extends: `./${name}/vitest.config.ts`,
    test: {
      name,
      root: `./${name}`,
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**'],
    },
  }))
);
