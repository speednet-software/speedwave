import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLabelsClient } from './labels.js';

// Create inline mock
function createMockGitlab() {
  return {
    ProjectLabels: {
      all: vi.fn(),
      create: vi.fn(),
    },
  };
}

describe('LabelsClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ReturnType<typeof createLabelsClient>;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createLabelsClient(mockGitlab as any);
  });

  describe('list', () => {
    it('should list all labels for a project', async () => {
      const mockLabels = [
        {
          id: 1,
          name: 'bug',
          color: '#FF0000',
          description: 'Bug reports',
          textColor: '#FFFFFF',
        },
        {
          id: 2,
          name: 'feature',
          color: '#00FF00',
          description: 'New features',
          text_color: '#000000',
        },
      ];
      mockGitlab.ProjectLabels.all.mockResolvedValue(mockLabels);

      const result = await client.list('project-123');

      expect(mockGitlab.ProjectLabels.all).toHaveBeenCalledWith('project-123');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 1,
        name: 'bug',
        color: '#FF0000',
        description: 'Bug reports',
        text_color: '#FFFFFF',
      });
      expect(result[1]).toMatchObject({
        id: 2,
        name: 'feature',
        color: '#00FF00',
        description: 'New features',
        text_color: '#000000',
      });
    });

    it('should handle labels without optional fields', async () => {
      const mockLabels = [
        {
          id: 3,
          name: 'urgent',
          color: '#FF9900',
        },
      ];
      mockGitlab.ProjectLabels.all.mockResolvedValue(mockLabels);

      const result = await client.list('project-123');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 3,
        name: 'urgent',
        color: '#FF9900',
      });
      expect(result[0].description).toBeUndefined();
      expect(result[0].text_color).toBeUndefined();
    });

    it('should handle empty label list', async () => {
      mockGitlab.ProjectLabels.all.mockResolvedValue([]);

      const result = await client.list('project-123');

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('should create a label with name and color', async () => {
      const mockLabel = {
        id: 4,
        name: 'enhancement',
        color: '#0000FF',
        textColor: '#FFFFFF',
      };
      mockGitlab.ProjectLabels.create.mockResolvedValue(mockLabel);

      const result = await client.create('project-123', 'enhancement', '#0000FF');

      expect(mockGitlab.ProjectLabels.create).toHaveBeenCalledWith(
        'project-123',
        'enhancement',
        '#0000FF',
        { description: undefined }
      );
      expect(result).toMatchObject({
        id: 4,
        name: 'enhancement',
        color: '#0000FF',
        text_color: '#FFFFFF',
      });
    });

    it('should create a label with description', async () => {
      const mockLabel = {
        id: 5,
        name: 'documentation',
        color: '#FFFF00',
        description: 'Documentation improvements',
        text_color: '#000000',
      };
      mockGitlab.ProjectLabels.create.mockResolvedValue(mockLabel);

      const result = await client.create(
        'project-123',
        'documentation',
        '#FFFF00',
        'Documentation improvements'
      );

      expect(mockGitlab.ProjectLabels.create).toHaveBeenCalledWith(
        'project-123',
        'documentation',
        '#FFFF00',
        { description: 'Documentation improvements' }
      );
      expect(result).toMatchObject({
        id: 5,
        name: 'documentation',
        color: '#FFFF00',
        description: 'Documentation improvements',
        text_color: '#000000',
      });
    });

    it('should handle numeric project IDs', async () => {
      const mockLabel = {
        id: 6,
        name: 'priority-high',
        color: '#FF0000',
      };
      mockGitlab.ProjectLabels.create.mockResolvedValue(mockLabel);

      const result = await client.create(12345, 'priority-high', '#FF0000');

      expect(mockGitlab.ProjectLabels.create).toHaveBeenCalledWith(
        12345,
        'priority-high',
        '#FF0000',
        { description: undefined }
      );
      expect(result.name).toBe('priority-high');
    });

    it('should handle labels with special characters in name', async () => {
      const mockLabel = {
        id: 7,
        name: 'needs-review::urgent',
        color: '#FF6600',
        description: 'Scoped label for urgent reviews',
      };
      mockGitlab.ProjectLabels.create.mockResolvedValue(mockLabel);

      const result = await client.create(
        'project-123',
        'needs-review::urgent',
        '#FF6600',
        'Scoped label for urgent reviews'
      );

      expect(result.name).toBe('needs-review::urgent');
      expect(result.description).toBe('Scoped label for urgent reviews');
    });
  });
});
