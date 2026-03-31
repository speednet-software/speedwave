/**
 * Config Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createConfigTools } from './config-tools.js';
import { RedmineClient, RedmineMappings } from '../client.js';

type MockClient = {
  getMappings: Mock;
  getConfig: Mock;
};

const createMockClient = (): MockClient => ({
  getMappings: vi.fn(),
  getConfig: vi.fn(),
});

describe('Config Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.spyOn(RedmineClient, 'formatError').mockImplementation((error) => {
      if (error instanceof Error) return error.message;
      return String(error);
    });
  });

  describe('when client is null', () => {
    it('should return unconfigured error for get_mappings', async () => {
      const tools = createConfigTools(null);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');
      expect(getMappingsTool).toBeDefined();

      const result = await getMappingsTool!.handler({});
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('Redmine')}`,
          },
        ],
      });
    });

    it('should return unconfigured error for get_config', async () => {
      const tools = createConfigTools(null);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');
      expect(getConfigTool).toBeDefined();

      const result = await getConfigTool!.handler({});
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('Redmine')}`,
          },
        ],
      });
    });
  });

  describe('getMappings', () => {
    it('should return empty mappings when none are configured', async () => {
      const emptyMappings: RedmineMappings = {};
      mockClient.getMappings.mockReturnValue(emptyMappings);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');

      const result = await getMappingsTool!.handler({});

      expect(mockClient.getMappings).toHaveBeenCalledWith();
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(emptyMappings, null, 2) }],
      });
    });

    it('should return status mappings', async () => {
      const statusMappings: RedmineMappings = {
        status_new: 1,
        status_in_progress: 2,
        status_resolved: 3,
        status_feedback: 4,
        status_closed: 5,
        status_rejected: 6,
      };
      mockClient.getMappings.mockReturnValue(statusMappings);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');

      const result = await getMappingsTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(statusMappings, null, 2) }],
      });
    });

    it('should return priority mappings', async () => {
      const priorityMappings: RedmineMappings = {
        priority_low: 1,
        priority_normal: 2,
        priority_high: 3,
        priority_urgent: 4,
        priority_immediate: 5,
      };
      mockClient.getMappings.mockReturnValue(priorityMappings);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');

      const result = await getMappingsTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(priorityMappings, null, 2) }],
      });
    });

    it('should return tracker mappings', async () => {
      const trackerMappings: RedmineMappings = {
        tracker_bug: 1,
        tracker_feature: 2,
        tracker_task: 3,
        tracker_support: 4,
      };
      mockClient.getMappings.mockReturnValue(trackerMappings);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');

      const result = await getMappingsTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(trackerMappings, null, 2) }],
      });
    });

    it('should return activity mappings', async () => {
      const activityMappings: RedmineMappings = {
        activity_design: 8,
        activity_development: 9,
        activity_testing: 10,
        activity_documentation: 11,
        activity_support: 12,
        activity_management: 13,
        activity_devops: 14,
        activity_review: 15,
      };
      mockClient.getMappings.mockReturnValue(activityMappings);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');

      const result = await getMappingsTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(activityMappings, null, 2) }],
      });
    });

    it('should return complete mappings configuration', async () => {
      const completeMappings: RedmineMappings = {
        status_new: 1,
        status_in_progress: 2,
        status_resolved: 3,
        status_feedback: 4,
        status_closed: 5,
        status_rejected: 6,
        priority_low: 1,
        priority_normal: 2,
        priority_high: 3,
        priority_urgent: 4,
        priority_immediate: 5,
        tracker_bug: 1,
        tracker_feature: 2,
        tracker_task: 3,
        tracker_support: 4,
        activity_design: 8,
        activity_development: 9,
        activity_testing: 10,
        activity_documentation: 11,
        activity_support: 12,
        activity_management: 13,
        activity_devops: 14,
        activity_review: 15,
      };
      mockClient.getMappings.mockReturnValue(completeMappings);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');

      const result = await getMappingsTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(completeMappings, null, 2) }],
      });
    });

    it('should return partial mappings', async () => {
      const partialMappings: RedmineMappings = {
        status_new: 1,
        priority_normal: 2,
        tracker_bug: 1,
      };
      mockClient.getMappings.mockReturnValue(partialMappings);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');

      const result = await getMappingsTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(partialMappings, null, 2) }],
      });
    });

    it('should handle errors', async () => {
      mockClient.getMappings.mockImplementation(() => {
        throw new Error('Failed to load mappings');
      });

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getMappingsTool = tools.find((t) => t.tool.name === 'getMappings');

      const result = await getMappingsTool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Failed to load mappings' }],
      });
    });
  });

  describe('getConfig', () => {
    it('should return minimal config with only URL', async () => {
      const config = {
        url: 'https://redmine.example.com',
      };
      mockClient.getConfig.mockReturnValue(config);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

      const result = await getConfigTool!.handler({});

      expect(mockClient.getConfig).toHaveBeenCalledWith();
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
      });
    });

    it('should return config with project_id', async () => {
      const config = {
        project_id: 'my-project',
        url: 'https://redmine.example.com',
      };
      mockClient.getConfig.mockReturnValue(config);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

      const result = await getConfigTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
      });
    });

    it('should return config with project_name', async () => {
      const config = {
        project_id: 'my-project',
        project_name: 'My Project',
        url: 'https://redmine.example.com',
      };
      mockClient.getConfig.mockReturnValue(config);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

      const result = await getConfigTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
      });
    });

    it('should return complete config', async () => {
      const config = {
        project_id: 'speedwave-core',
        project_name: 'Speedwave Core',
        url: 'https://redmine.speedwave.io',
      };
      mockClient.getConfig.mockReturnValue(config);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

      const result = await getConfigTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
      });
    });

    it('should handle config with undefined project fields', async () => {
      const config = {
        project_id: undefined,
        project_name: undefined,
        url: 'https://redmine.example.com',
      };
      mockClient.getConfig.mockReturnValue(config);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

      const result = await getConfigTool!.handler({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
      });
    });

    it('should handle different Redmine URL formats', async () => {
      const configs = [
        { url: 'https://redmine.example.com' },
        { url: 'https://redmine.example.com/' },
        { url: 'http://localhost:3000' },
        { url: 'https://example.com/redmine' },
      ];

      for (const config of configs) {
        mockClient.getConfig.mockReturnValue(config);

        const tools = createConfigTools(mockClient as unknown as RedmineClient);
        const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

        const result = await getConfigTool!.handler({});

        expect(result).toEqual({
          content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
        });
      }
    });

    it('should handle errors', async () => {
      mockClient.getConfig.mockImplementation(() => {
        throw new Error('Failed to load config');
      });

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

      const result = await getConfigTool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Failed to load config' }],
      });
    });

    it('should handle unexpected errors', async () => {
      mockClient.getConfig.mockImplementation(() => {
        throw new Error('Unexpected error occurred');
      });

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

      const result = await getConfigTool!.handler({});

      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Error: Unexpected error occurred' }],
      });
    });

    it('should return project_name fetched at init (getConfig remains sync)', async () => {
      const config = {
        project_id: 'my-project',
        project_name: 'Auto-Fetched Name',
        url: 'https://redmine.example.com',
      };
      mockClient.getConfig.mockReturnValue(config);

      const tools = createConfigTools(mockClient as unknown as RedmineClient);
      const getConfigTool = tools.find((t) => t.tool.name === 'getConfig');

      const result = await getConfigTool!.handler({});

      expect(mockClient.getConfig).toHaveBeenCalledWith();
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
      });

      const parsed = JSON.parse((result as any).content[0].text);
      expect(parsed.project_name).toBe('Auto-Fetched Name');
    });
  });
});
