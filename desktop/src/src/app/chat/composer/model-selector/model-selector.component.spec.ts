import { describe, it, expect } from 'vitest';
import type { ActiveProviderSummary } from '../../../models/llm';

describe('ActiveProviderSummary', () => {
  it('shape matches the Rust mirror fields, including base_url', () => {
    const sample: ActiveProviderSummary = {
      provider_id: 'my-ollama',
      kind: 'local',
      model: 'my-ollama/llama3.3',
      base_url: 'http://host.docker.internal:11434',
    };
    expect(sample.base_url).toBe('http://host.docker.internal:11434');
  });
});
