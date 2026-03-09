/**
 * Vitest configuration for direct `npx vitest run` usage.
 *
 * This is the SSOT for Angular test configuration including coverage thresholds.
 * The Makefile and CI both call `npx vitest run --coverage` which reads this file.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Vitest plugin that inlines Angular external `templateUrl` and `styleUrl`
 * references so components with external files work without the Angular
 * build plugin. Only needed for the few components that use external files.
 */
function angularInlinePlugin(): Plugin {
  return {
    name: 'angular-inline-templates',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.endsWith('.ts') || id.includes('node_modules')) return null;
      if (!code.includes('templateUrl') && !code.includes('styleUrl')) return null;

      const dir = dirname(id);
      let result = code;

      result = result.replace(
        /templateUrl:\s*['"](.+?)['"]/g,
        (_match: string, url: string) => {
          const filePath = resolve(dir, url);
          try {
            const content = readFileSync(filePath, 'utf-8');
            return `template: ${JSON.stringify(content)}`;
          } catch (err) {
            throw new Error(
              `angularInlinePlugin: failed to read templateUrl "${url}" (resolved to "${filePath}") in ${id}: ${err}`,
            );
          }
        },
      );

      result = result.replace(
        /styleUrl:\s*['"](.+?)['"]/g,
        (_match: string, url: string) => {
          const filePath = resolve(dir, url);
          try {
            const content = readFileSync(filePath, 'utf-8');
            return `styles: [${JSON.stringify(content)}]`;
          } catch (err) {
            throw new Error(
              `angularInlinePlugin: failed to read styleUrl "${url}" (resolved to "${filePath}") in ${id}: ${err}`,
            );
          }
        },
      );

      return result === code ? null : { code: result, map: null };
    },
  };
}

export default defineConfig({
  plugins: [angularInlinePlugin()],
  test: {
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/app/**/*.ts'],
      exclude: ['src/app/testing/**', 'src/**/*.spec.ts'],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 30,
        statements: 40,
      },
    },
  },
});
