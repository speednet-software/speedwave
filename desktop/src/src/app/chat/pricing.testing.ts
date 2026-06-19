import { _unknownModelWarningsForTest } from './pricing';

/** Test-only: resets the unknown-model warning set so subsequent calls log again. */
export function _resetUnknownModelWarnings(): void {
  _unknownModelWarningsForTest.clear();
}
