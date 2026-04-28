/**
 * Auto-discovered mock for `@tauri-apps/plugin-dialog` consumed by every
 * spec in this workspace.
 *
 * Per Vitest docs: when a spec calls `vi.mock('@tauri-apps/plugin-dialog')`
 * without a factory, Vitest looks for `__mocks__/@tauri-apps/plugin-dialog.ts`
 * (relative to project root) and uses that file as the replacement
 * module. Centralising the mock here avoids the hoist race that two
 * sibling specs would otherwise trigger by each declaring their own
 * `vi.fn()` factory under the Angular unit-test builder's `isolate: false`
 * configuration.
 *
 * Specs that need to assert on `open` invocations import the same `vi.fn()`
 * via `import { open } from '@tauri-apps/plugin-dialog'` — the import is
 * rewritten by Vitest to the mock module, so every consumer (spec,
 * component-under-test, transitively imported component) sees the same
 * function instance.
 */
import { vi } from 'vitest';

export const open = vi.fn();
