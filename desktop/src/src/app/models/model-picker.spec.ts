import { canonicalModelId } from './model-picker';

const CANONICAL_CASES: ReadonlyArray<readonly [string, string]> = [
  ['claude-opus-5', 'claude-opus-5'],
  ['claude-opus-5[1m]', 'claude-opus-5'],
  ['claude-opus-5[1m][1m]', 'claude-opus-5'],
  ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
  ['claude-haiku-4-5-20251001[1m]', 'claude-haiku-4-5'],
  [' claude-sonnet-5[1m] ', 'claude-sonnet-5'],
  ['claude-fable-5-1', 'claude-fable-5-1'],
  ['claude-opus-5[1M]', 'claude-opus-5[1M]'],
  ['claude-opus-4-8-2025100', 'claude-opus-4-8-2025100'],
  ['default', 'default'],
  ['opus[1m]', 'opus'],
  ['local/qwen3', 'local/qwen3'],
  ['-20251001', ''],
  ['[1m]', ''],
  ['', ''],
];

describe('canonicalModelId', () => {
  it.each(CANONICAL_CASES)('maps %j to %j', (wire, canonical) => {
    expect(canonicalModelId(wire)).toBe(canonical);
  });

  it('renders a bare and a 1M session of one model as the same identity', () => {
    expect(canonicalModelId('claude-opus-5[1m]')).toBe(canonicalModelId('claude-opus-5'));
  });
});
