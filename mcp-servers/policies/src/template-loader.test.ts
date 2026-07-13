import { describe, it, expect } from 'vitest';
import { loadTemplate, loadAllTemplates, SHIPPED_TEMPLATE_IDS } from './template-loader.js';
import { resolvedPolicyFromTemplate, defaultResolvedPolicy } from './resolved-policy.js';

describe('loadTemplate', () => {
  it('loads and validates the "strict" template', () => {
    const template = loadTemplate('strict');
    expect(template.id).toBe('strict');
    expect(template.version).toBe(2);
    expect(Object.values(template.categories).every((v) => v === true)).toBe(true);
  });

  it('loads "gdpr-art32" with API_KEY off', () => {
    const template = loadTemplate('gdpr-art32');
    expect(template.categories.API_KEY).toBe(false);
    expect(template.categories.EMAIL).toBe(true);
  });

  it('loads "eu-ai-act-art5" with NIP and API_KEY off', () => {
    const template = loadTemplate('eu-ai-act-art5');
    expect(template.categories.NIP).toBe(false);
    expect(template.categories.API_KEY).toBe(false);
    expect(template.categories.EMAIL).toBe(true);
  });

  it('resolving "strict" deep-equals the compiled default (cross-checked again via the loader)', () => {
    expect(resolvedPolicyFromTemplate(loadTemplate('strict'))).toEqual(defaultResolvedPolicy());
  });

  it('throws a descriptive error for an unknown template id', () => {
    expect(() => loadTemplate('does-not-exist')).toThrow(/does-not-exist/);
  });
});

describe('loadAllTemplates', () => {
  it('loads every shipped template, keyed by id', () => {
    const all = loadAllTemplates();
    expect(Object.keys(all).sort()).toEqual([...SHIPPED_TEMPLATE_IDS].sort());
    for (const id of SHIPPED_TEMPLATE_IDS) {
      expect(all[id].id).toBe(id);
    }
  });
});
