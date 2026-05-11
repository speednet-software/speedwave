import { defineWorkspace } from 'vitest/config';

const workspaces = ['shared', 'hub', 'slack', 'gitlab', 'github', 'redmine', 'sharepoint', 'os'];

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
