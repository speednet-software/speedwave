import { describe, it, expect } from 'vitest';
import { normalizeObserved, wireModelId } from './wire-model-id';

describe('wireModelId', () => {
  it('returns the catalog id unchanged for an anthropic entry', () => {
    expect(wireModelId('anthropic_oauth', 'anthropic', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(wireModelId('anthropic_api_key', 'anthropic', 'claude-sonnet-5[1m]')).toBe(
      'claude-sonnet-5[1m]'
    );
  });

  it('prefixes with the entry id for local and open_router providers', () => {
    expect(wireModelId('local', 'my-ollama', 'llama3.3')).toBe('my-ollama/llama3.3');
    expect(wireModelId('open_router', 'openrouter', 'anthropic/claude-sonnet-5')).toBe(
      'openrouter/anthropic/claude-sonnet-5'
    );
  });

  it('never collapses an entry id that itself contains no slash with a catalog id that does', () => {
    // Regression: OpenRouter's catalog id ("anthropic/claude-sonnet-5") must never be sent bare -
    // the entry_id prefix must always be present and only ONE prefix segment added.
    const wire = wireModelId('open_router', 'my-or', 'anthropic/claude-sonnet-5');
    expect(wire).toBe('my-or/anthropic/claude-sonnet-5');
    expect(wire.split('/')[0]).toBe('my-or');
  });

  it('does not double-prefix a catalog id that already carries the entry id prefix', () => {
    // Mirrors Rust wire_model_id's guard: a catalog id observed back from the
    // wire (e.g. re-selected from an already-normalized option) must not
    // collect a second "<entryId>/" segment.
    expect(wireModelId('local', 'my-ollama', 'my-ollama/llama3.3')).toBe('my-ollama/llama3.3');
    expect(wireModelId('open_router', 'openrouter', 'openrouter/anthropic/claude-sonnet-5')).toBe(
      'openrouter/anthropic/claude-sonnet-5'
    );
  });
});

describe('normalizeObserved', () => {
  it('strips only an exact leading `<entryId>/` prefix', () => {
    expect(normalizeObserved('openrouter/anthropic/claude-sonnet-5', 'openrouter')).toBe(
      'anthropic/claude-sonnet-5'
    );
    expect(normalizeObserved('my-ollama/llama3.3', 'my-ollama')).toBe('llama3.3');
  });

  it('passes an anthropic id (no slash) through unchanged', () => {
    expect(normalizeObserved('claude-sonnet-5', 'anthropic')).toBe('claude-sonnet-5');
    expect(normalizeObserved('claude-sonnet-5[1m]', 'anthropic')).toBe('claude-sonnet-5[1m]');
  });

  it('does not mis-strip a first segment that is not the entry id', () => {
    // Regression: naive first-`/` slicing would wrongly drop `unsloth/` here.
    expect(normalizeObserved('unsloth/Qwen2.5-Coder-32B', 'my-ollama')).toBe(
      'unsloth/Qwen2.5-Coder-32B'
    );
    // Pathological near-miss: prefix must match exactly, `localhost/` is not `local/`.
    expect(normalizeObserved('localhost/x', 'local')).toBe('localhost/x');
  });
});
