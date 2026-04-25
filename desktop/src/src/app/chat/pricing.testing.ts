import { _unknownModelWarningsForTest } from './pricing';

/**
 * Test-only helper: resets the set of unknown models that have already
 * logged a warning, so subsequent calls log again. Lives in a `.testing.ts`
 * file so it stays out of the production bundle (tree-shaken under the
 * Angular production build because no production code imports it).
 *
 * Spec files should `import { _resetUnknownModelWarnings } from
 * './pricing.testing';` rather than reaching into `pricing.ts` directly.
 */
export function _resetUnknownModelWarnings(): void {
  _unknownModelWarningsForTest.clear();
}
