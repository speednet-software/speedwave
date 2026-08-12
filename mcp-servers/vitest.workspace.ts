import { defineWorkspace } from 'vitest/config';

const workspaces = [
  'shared',
  'policies',
  'hub',
  'slack',
  'gitlab',
  'github',
  'atlassian',
  'office',
  'redmine',
  'sharepoint',
  'os',
  'oauth',
  'context7',
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
