/**
 * Bridge-Executor Parity Tests (SSOT Architecture)
 *
 * With the Single Source of Truth (SSOT) refactoring:
 * - Both http-bridge and executor are generated from TOOL_REGISTRY
 * - Parity is GUARANTEED BY DESIGN
 * - No more manual sync needed between files
 *
 * These tests verify:
 * 1. Registry contains all expected methods
 * 2. Bridges are correctly generated from registry
 * 3. Registry consistency with tool files
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSlackBridge,
  createSharePointBridge,
  createRedmineBridge,
  createGitLabBridge,
  createOsBridge,
} from './http-bridge.js';
import {
  TOOL_REGISTRY,
  SERVICE_NAMES,
  getServiceMethods,
  validateRegistry,
  stopBackgroundRefresh,
} from './tool-registry.js';
import { populateRegistryFromPolicies, _resetRegistryForTesting } from './test-helpers.js';

/**
 * Extract method names from a bridge object
 */
function getBridgeMethods(bridge: Record<string, unknown>): string[] {
  return Object.keys(bridge).filter((key) => typeof bridge[key] === 'function');
}

describe('Bridge-Executor Parity (SSOT)', () => {
  beforeAll(() => {
    _resetRegistryForTesting();
    populateRegistryFromPolicies();
  });

  afterAll(() => {
    stopBackgroundRefresh();
  });

  describe('Registry Validation', () => {
    it('should have no validation errors', () => {
      const errors = validateRegistry();
      expect(errors).toEqual([]);
    });

    it('should contain all expected services', () => {
      const expectedServices = ['slack', 'sharepoint', 'redmine', 'gitlab', 'os'];
      for (const service of expectedServices) {
        expect(SERVICE_NAMES).toContain(service);
        expect(TOOL_REGISTRY[service]).toBeDefined();
      }
    });
  });

  describe('Bridge Generation', () => {
    it('Slack bridge should match registry', () => {
      const bridgeMethods = getBridgeMethods(createSlackBridge()).sort();
      const registryMethods = getServiceMethods('slack').sort();
      expect(bridgeMethods).toEqual(registryMethods);
    });

    it('SharePoint bridge should match registry', () => {
      const bridgeMethods = getBridgeMethods(createSharePointBridge()).sort();
      const registryMethods = getServiceMethods('sharepoint').sort();
      expect(bridgeMethods).toEqual(registryMethods);
    });

    it('Redmine bridge should match registry', () => {
      const bridgeMethods = getBridgeMethods(createRedmineBridge()).sort();
      const registryMethods = getServiceMethods('redmine').sort();
      expect(bridgeMethods).toEqual(registryMethods);
    });

    it('GitLab bridge should match registry', () => {
      const bridgeMethods = getBridgeMethods(createGitLabBridge()).sort();
      const registryMethods = getServiceMethods('gitlab').sort();
      expect(bridgeMethods).toEqual(registryMethods);
    });

    it('OS bridge should match registry', () => {
      const bridgeMethods = getBridgeMethods(createOsBridge()).sort();
      const registryMethods = getServiceMethods('os').sort();
      expect(bridgeMethods).toEqual(registryMethods);
    });
  });

  describe('Critical Methods (Regression Tests)', () => {
    it('Redmine should include relation methods', () => {
      const redmineMethods = getServiceMethods('redmine');
      expect(redmineMethods).toContain('listRelations');
      expect(redmineMethods).toContain('createRelation');
      expect(redmineMethods).toContain('deleteRelation');
    });

    it('GitLab should include branch methods', () => {
      const gitlabMethods = getServiceMethods('gitlab');
      expect(gitlabMethods).toContain('listBranches');
      expect(gitlabMethods).toContain('createBranch');
      expect(gitlabMethods).toContain('deleteBranch');
    });

    it('GitLab should include MR methods', () => {
      const gitlabMethods = getServiceMethods('gitlab');
      expect(gitlabMethods).toContain('listMrIds');
      expect(gitlabMethods).toContain('getMrFull');
      expect(gitlabMethods).toContain('createMergeRequest');
      expect(gitlabMethods).toContain('approveMergeRequest');
      expect(gitlabMethods).toContain('mergeMergeRequest');
    });
  });

  describe('SSOT Architecture', () => {
    it('should have same methods in bridge and registry for all services', () => {
      const bridges = {
        slack: createSlackBridge(),
        sharepoint: createSharePointBridge(),
        redmine: createRedmineBridge(),
        gitlab: createGitLabBridge(),
        os: createOsBridge(),
      };

      const mismatches: { service: string; bridge: string[]; registry: string[] }[] = [];

      for (const service of SERVICE_NAMES) {
        const bridgeMethods = getBridgeMethods(
          bridges[service as keyof typeof bridges] as Record<string, unknown>
        ).sort();
        const registryMethods = getServiceMethods(service).sort();

        if (JSON.stringify(bridgeMethods) !== JSON.stringify(registryMethods)) {
          mismatches.push({
            service,
            bridge: bridgeMethods,
            registry: registryMethods,
          });
        }
      }

      if (mismatches.length > 0) {
        console.error('\n🚨 Bridge-Registry mismatch detected:');
        for (const m of mismatches) {
          console.error(`\n${m.service}:`);
          console.error(`  Bridge:   ${m.bridge.join(', ')}`);
          console.error(`  Registry: ${m.registry.join(', ')}`);
        }
      }

      expect(mismatches).toEqual([]);
    });
  });
});
