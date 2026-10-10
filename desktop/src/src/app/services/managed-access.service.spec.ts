import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ManagedAccessService } from './managed-access.service';
import { TauriService } from './tauri.service';
import type { ManagedAccess } from '../models/management';

const POLICY: ManagedAccess = {
  managed: true,
  provider: 'Auditor',
  error: null,
  projects: { default: 'deny', rules: { billing: 'allow' } },
  services: { default: 'allow', rules: { slack: 'deny', 'plugin:crm': 'allow' } },
  agents: null,
};

describe('ManagedAccessService', () => {
  let listeners: Record<string, () => void>;
  let answer: ManagedAccess;

  beforeEach(() => {
    listeners = {};
    answer = POLICY;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: TauriService,
          useValue: {
            invoke: vi.fn(async () => answer),
            listen: vi.fn(async (event: string, handler: () => void) => {
              listeners[event] = handler;
              return () => undefined;
            }),
          },
        },
      ],
    });
  });

  async function make(): Promise<ManagedAccessService> {
    const s = TestBed.inject(ManagedAccessService);
    await s.load();
    return s;
  }

  it('marks each project, service and plugin by the policy', async () => {
    const s = await make();
    expect(s.managed()).toBe(true);
    expect(s.provider()).toBe('Auditor');
    expect(s.project('billing')).toBe('allowed');
    expect(s.project('scratch')).toBe('not-allowed');
    expect(s.service('slack')).toBe('not-allowed');
    expect(s.service('github')).toBe('allowed');
    expect(s.service('plugin:crm')).toBe('allowed');
  });

  it('marks nothing the policy says nothing about, nor anything without a policy', async () => {
    const s = await make();
    expect(s.agent('reviewer')).toBeNull();
    expect(s.project(null)).toBeNull();
    answer = { ...POLICY, managed: false };
    await s.load();
    expect(s.project('billing')).toBeNull();
    expect(s.service('slack')).toBeNull();
  });

  it('reads the policy again when it changes', async () => {
    const s = await make();
    answer = { ...POLICY, agents: { default: 'deny', rules: { reviewer: 'allow' } } };
    listeners['managed_policy_changed']?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.agent('reviewer')).toBe('allowed');
    expect(s.agent('other')).toBe('not-allowed');
  });
});
