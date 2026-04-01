/**
 * Label Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, withSetupGuidance } from '@speedwave/mcp-shared';
import { createLabelTools } from './label-tools.js';
import type { GitLabClient } from '../client.js';

type MockClient = {
  listLabels: Mock;
  createLabel: Mock;
};

describe('label-tools', () => {
  const createMockClient = (): MockClient => ({
    listLabels: vi.fn(),
    createLabel: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('unconfigured client', () => {
    it('returns error for list_labels when client is null', async () => {
      const tools = createLabelTools(null);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');

      const result = await listLabelsTool!.handler({ project_id: 1 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns error for create_label when client is null', async () => {
      const tools = createLabelTools(null);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');

      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });
  });

  describe('listLabels', () => {
    it('returns labels successfully with minimal parameters', async () => {
      const mockClient = createMockClient();
      const labels = [
        { id: 1, name: 'bug', color: '#FF0000', description: 'Bug reports' },
        { id: 2, name: 'feature', color: '#00FF00', description: 'New features' },
      ];
      mockClient.listLabels.mockResolvedValue(labels);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }],
      });
      expect(mockClient.listLabels).toHaveBeenCalledWith(1, {});
    });

    it('returns labels with search parameter', async () => {
      const mockClient = createMockClient();
      const labels = [{ id: 1, name: 'bug', color: '#FF0000', description: 'Bug reports' }];
      mockClient.listLabels.mockResolvedValue(labels);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1, search: 'bug' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }],
      });
      expect(mockClient.listLabels).toHaveBeenCalledWith(1, { search: 'bug' });
    });

    it('returns labels with limit parameter', async () => {
      const mockClient = createMockClient();
      const labels = [
        { id: 1, name: 'bug', color: '#FF0000', description: 'Bug reports' },
        { id: 2, name: 'feature', color: '#00FF00', description: 'New features' },
        { id: 3, name: 'enhancement', color: '#0000FF', description: 'Enhancements' },
      ];
      mockClient.listLabels.mockResolvedValue(labels);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1, limit: 10 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }],
      });
      expect(mockClient.listLabels).toHaveBeenCalledWith(1, { limit: 10 });
    });

    it('returns labels with both search and limit parameters', async () => {
      const mockClient = createMockClient();
      const labels = [
        { id: 1, name: 'bug-critical', color: '#FF0000', description: 'Critical bugs' },
        { id: 2, name: 'bug-minor', color: '#FFA500', description: 'Minor bugs' },
      ];
      mockClient.listLabels.mockResolvedValue(labels);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1, search: 'bug', limit: 5 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }],
      });
      expect(mockClient.listLabels).toHaveBeenCalledWith(1, { search: 'bug', limit: 5 });
    });

    it('returns empty array when no labels exist', async () => {
      const mockClient = createMockClient();
      mockClient.listLabels.mockResolvedValue([]);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      });
    });

    it('works with string project_id', async () => {
      const mockClient = createMockClient();
      const labels = [{ id: 1, name: 'bug', color: '#FF0000', description: 'Bug reports' }];
      mockClient.listLabels.mockResolvedValue(labels);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 'my-group/my-project' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }],
      });
      expect(mockClient.listLabels).toHaveBeenCalledWith('my-group/my-project', {});
    });

    it('returns error when API call fails', async () => {
      const mockClient = createMockClient();
      mockClient.listLabels.mockRejectedValue(new Error('API error'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: API error' }],
        isError: true,
      });
    });

    it('returns error for 401 unauthorized', async () => {
      const mockClient = createMockClient();
      mockClient.listLabels.mockRejectedValue(new Error('401 Unauthorized'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Authentication failed. Check your GitLab token.')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns error for 403 forbidden', async () => {
      const mockClient = createMockClient();
      mockClient.listLabels.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });

    it('returns error for 404 not found', async () => {
      const mockClient = createMockClient();
      mockClient.listLabels.mockRejectedValue(new Error('404 Project not found'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('returns error for network timeout', async () => {
      const mockClient = createMockClient();
      mockClient.listLabels.mockRejectedValue(new Error('Network timeout'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const listLabelsTool = tools.find((t) => t.tool.name === 'listLabels');
      const result = await listLabelsTool!.handler({ project_id: 1 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Network error. Check your GitLab URL.')}`,
          },
        ],
        isError: true,
      });
    });
  });

  describe('createLabel', () => {
    it('creates label successfully with required parameters', async () => {
      const mockClient = createMockClient();
      const newLabel = {
        id: 1,
        name: 'bug',
        color: '#FF0000',
        description: '',
      };
      mockClient.createLabel.mockResolvedValue(newLabel);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(newLabel, null, 2) }],
      });
      expect(mockClient.createLabel).toHaveBeenCalledWith(1, {
        name: 'bug',
        color: '#FF0000',
      });
    });

    it('creates label with description parameter', async () => {
      const mockClient = createMockClient();
      const newLabel = {
        id: 2,
        name: 'feature',
        color: '#00FF00',
        description: 'New feature requests',
      };
      mockClient.createLabel.mockResolvedValue(newLabel);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'feature',
        color: '#00FF00',
        description: 'New feature requests',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(newLabel, null, 2) }],
      });
      expect(mockClient.createLabel).toHaveBeenCalledWith(1, {
        name: 'feature',
        color: '#00FF00',
        description: 'New feature requests',
      });
    });

    it('creates label with string project_id', async () => {
      const mockClient = createMockClient();
      const newLabel = {
        id: 3,
        name: 'enhancement',
        color: '#0000FF',
        description: 'Enhancements',
      };
      mockClient.createLabel.mockResolvedValue(newLabel);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 'my-group/my-project',
        name: 'enhancement',
        color: '#0000FF',
        description: 'Enhancements',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(newLabel, null, 2) }],
      });
      expect(mockClient.createLabel).toHaveBeenCalledWith('my-group/my-project', {
        name: 'enhancement',
        color: '#0000FF',
        description: 'Enhancements',
      });
    });

    it('creates label with short hex color code', async () => {
      const mockClient = createMockClient();
      const newLabel = {
        id: 4,
        name: 'urgent',
        color: '#F00',
        description: '',
      };
      mockClient.createLabel.mockResolvedValue(newLabel);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'urgent',
        color: '#F00',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(newLabel, null, 2) }],
      });
      expect(mockClient.createLabel).toHaveBeenCalledWith(1, {
        name: 'urgent',
        color: '#F00',
      });
    });

    it('creates label with special characters in name', async () => {
      const mockClient = createMockClient();
      const newLabel = {
        id: 5,
        name: 'bug::critical',
        color: '#FF0000',
        description: 'Critical bugs',
      };
      mockClient.createLabel.mockResolvedValue(newLabel);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug::critical',
        color: '#FF0000',
        description: 'Critical bugs',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(newLabel, null, 2) }],
      });
    });

    it('creates label with long description', async () => {
      const mockClient = createMockClient();
      const longDescription =
        'This is a very long description that contains multiple sentences. ' +
        'It provides detailed information about what this label represents. ' +
        'Labels are useful for categorizing and organizing issues and merge requests.';
      const newLabel = {
        id: 6,
        name: 'documentation',
        color: '#FFA500',
        description: longDescription,
      };
      mockClient.createLabel.mockResolvedValue(newLabel);

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'documentation',
        color: '#FFA500',
        description: longDescription,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(newLabel, null, 2) }],
      });
    });

    it('returns error when API call fails', async () => {
      const mockClient = createMockClient();
      mockClient.createLabel.mockRejectedValue(new Error('API error'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: API error' }],
        isError: true,
      });
    });

    it('returns error for duplicate label name', async () => {
      const mockClient = createMockClient();
      mockClient.createLabel.mockRejectedValue(new Error('Label already exists'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Label already exists' }],
        isError: true,
      });
    });

    it('returns error for invalid color format', async () => {
      const mockClient = createMockClient();
      mockClient.createLabel.mockRejectedValue(new Error('Invalid color format'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug',
        color: 'red',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Invalid color format' }],
        isError: true,
      });
    });

    it('returns error for 401 unauthorized', async () => {
      const mockClient = createMockClient();
      mockClient.createLabel.mockRejectedValue(new Error('401 Unauthorized'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Authentication failed. Check your GitLab token.')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns error for 403 forbidden', async () => {
      const mockClient = createMockClient();
      mockClient.createLabel.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });

    it('returns error for 404 project not found', async () => {
      const mockClient = createMockClient();
      mockClient.createLabel.mockRejectedValue(new Error('404 Project not found'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 999,
        name: 'bug',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('returns error for network timeout', async () => {
      const mockClient = createMockClient();
      mockClient.createLabel.mockRejectedValue(new Error('Network timeout'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: 'bug',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Network error. Check your GitLab URL.')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns error for empty label name', async () => {
      const mockClient = createMockClient();
      mockClient.createLabel.mockRejectedValue(new Error('Label name cannot be empty'));

      const tools = createLabelTools(mockClient as unknown as GitLabClient);
      const createLabelTool = tools.find((t) => t.tool.name === 'createLabel');
      const result = await createLabelTool!.handler({
        project_id: 1,
        name: '',
        color: '#FF0000',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Label name cannot be empty' }],
        isError: true,
      });
    });
  });
});
