import { defineWorkspace } from 'vitest/config';

const workspaces = [
  'shared',
  'hub',
  'slack',
  'gitlab',
  'github',
  'atlassian',
  'redmine',
  'sharepoint',
  'os',
  'host_exec',
];

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
