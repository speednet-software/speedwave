import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration consumed via `ng test --runner-config vitest.config.ts`.
 *
 * Currently empty — the Angular `@angular/build:unit-test` builder
 * provides the rest of the configuration. Kept as the seam for future
 * Vitest-specific options without modifying the builder.
 *
 * Cross-spec module mocking (e.g. `@tauri-apps/plugin-dialog`) lives in
 * `__mocks__/<module-path>.ts` files at the project root — Vitest auto-
 * discovers them when a spec calls `vi.mock(<path>)` without a factory.
 * That avoids the hoist race that two factory-style mocks would trigger
 * under the builder's `isolate: false` setting.
 */
export default defineConfig({
  test: {},
});
