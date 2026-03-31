/**
 * Comprehensive tests for Redmine API Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSetupGuidance } from '@speedwave/mcp-shared';
import axios, { AxiosError } from 'axios';
import { RedmineClient, initializeRedmineClient, ProjectScopeError } from './client.js';
import type {
  RedmineConfig,
  RedmineIssue,
  RedmineTimeEntry,
  RedmineJournal,
  RedmineUser,
  RedmineMappings,
  RedmineProjectConfig,
} from './client.js';
import fs from 'fs/promises';

// Mock axios
vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

// Mock fs/promises
vi.mock('fs/promises');
const mockedFs = vi.mocked(fs, true);

describe('RedmineClient', () => {
  let client: RedmineClient;
  let mockAxiosInstance: any;
  let config: RedmineConfig;
  let mockInterceptors: any;

  beforeEach(() => {
    // Setup mock axios instance
    mockInterceptors = {
      response: {
        use: vi.fn(),
      },
    };

    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: mockInterceptors,
    };

    mockedAxios.create = vi.fn().mockReturnValue(mockAxiosInstance);

    config = {
      url: 'https://redmine.example.com',
      apiKey: 'test-api-key-123',
    };

    client = new RedmineClient(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Constructor and Initialization
  //═══════════════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('should create axios instance with correct config', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://redmine.example.com',
        timeout: 30000,
        headers: {
          'X-Redmine-API-Key': 'test-api-key-123',
          'Content-Type': 'application/json',
        },
      });
    });

    it('should store config and mappings from projectConfig', () => {
      const projectConfig: RedmineProjectConfig = {
        host_url: 'https://redmine.example.com',
        mappings: {
          status_new: 1,
          status_in_progress: 2,
          priority_high: 3,
        },
      };

      const clientWithMappings = new RedmineClient(config, projectConfig);
      expect(clientWithMappings.getMappings()).toEqual(projectConfig.mappings);
    });

    it('should setup retry interceptor', () => {
      expect(mockInterceptors.response.use).toHaveBeenCalled();
    });
  });

  describe('getMappings', () => {
    it('should return empty mappings when none provided', () => {
      expect(client.getMappings()).toEqual({});
    });

    it('should return provided mappings', () => {
      const projectConfig: RedmineProjectConfig = {
        host_url: 'https://redmine.example.com',
        mappings: {
          status_new: 1,
          tracker_bug: 2,
        },
      };
      const clientWithMappings = new RedmineClient(config, projectConfig);
      expect(clientWithMappings.getMappings()).toEqual(projectConfig.mappings);
    });
  });

  describe('getConfig', () => {
    it('should return config with URL from constructor', () => {
      const result = client.getConfig();
      expect(result.url).toBe('https://redmine.example.com');
    });

    it('should return config with project info from projectConfig', () => {
      const projectConfig: RedmineProjectConfig = {
        host_url: 'https://redmine.example.com',
        project_id: 'test-project',
        project_name: 'Test Project',
      };
      const clientWithProject = new RedmineClient(config, projectConfig);

      const result = clientWithProject.getConfig();
      expect(result.project_id).toBe('test-project');
      expect(result.project_name).toBe('Test Project');
      expect(result.url).toBe('https://redmine.example.com');
    });

    it('should handle missing project config', () => {
      const result = client.getConfig();
      expect(result.project_id).toBeUndefined();
      expect(result.project_name).toBeUndefined();
      expect(result.url).toBe('https://redmine.example.com');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Issue Operations
  //═══════════════════════════════════════════════════════════════════════════════

  describe('listIssues', () => {
    it('should fetch issues with default parameters', async () => {
      const mockResponse = {
        data: {
          issues: [
            {
              id: 1,
              subject: 'Test Issue',
              project: { id: 1, name: 'Test Project' },
            },
          ],
          total_count: 1,
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await client.listIssues();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues.json', {
        params: {
          limit: 25,
          offset: 0,
        },
      });
      expect(result).toEqual(mockResponse.data);
    });

    it('should fetch issues with custom parameters', async () => {
      const mockResponse = {
        data: {
          issues: [],
          total_count: 0,
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      await client.listIssues({
        project_id: 'test-project',
        assigned_to_id: 123,
        status_id: 'open',
        parent_id: 456,
        limit: 50,
        offset: 100,
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues.json', {
        params: {
          limit: 50,
          offset: 100,
          project_id: 'test-project',
          assigned_to_id: 123,
          status_id: 'open',
          parent_id: 456,
        },
      });
    });

    it('should handle pagination', async () => {
      const mockResponse = {
        data: {
          issues: Array(25).fill({ id: 1, subject: 'Test' }),
          total_count: 100,
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await client.listIssues({ limit: 25, offset: 50 });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues.json', {
        params: {
          limit: 25,
          offset: 50,
        },
      });
      expect(result.issues).toHaveLength(25);
      expect(result.total_count).toBe(100);
    });
  });

  describe('showIssue', () => {
    it('should fetch single issue without journals', async () => {
      const mockIssue: Partial<RedmineIssue> = {
        id: 1,
        subject: 'Test Issue',
        project: { id: 1, name: 'Test Project' },
        tracker: { id: 1, name: 'Bug' },
        status: { id: 1, name: 'New' },
        priority: { id: 2, name: 'Normal' },
        author: { id: 1, name: 'Test User' },
        created_on: '2024-01-01T00:00:00Z',
        updated_on: '2024-01-01T00:00:00Z',
      };

      mockAxiosInstance.get.mockResolvedValue({
        data: { issue: mockIssue },
      });

      const result = await client.showIssue(1);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues/1.json', {
        params: {},
      });
      expect(result).toEqual(mockIssue);
    });

    it('should fetch single issue with journals', async () => {
      const mockIssue: Partial<RedmineIssue> = {
        id: 1,
        subject: 'Test Issue',
        journals: [
          {
            id: 1,
            user: { id: 1, name: 'Test User' },
            notes: 'Test note',
            created_on: '2024-01-01T00:00:00Z',
            details: [],
          },
        ],
      };

      mockAxiosInstance.get.mockResolvedValue({
        data: { issue: mockIssue },
      });

      const result = await client.showIssue(1, { include: ['journals'] });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues/1.json', {
        params: { include: 'journals' },
      });
      expect(result.journals).toHaveLength(1);
    });

    it('should fetch issue with multiple includes', async () => {
      const mockIssue: Partial<RedmineIssue> = {
        id: 1,
        subject: 'Test Issue',
        journals: [
          { id: 1, user: { id: 1, name: 'Test User' }, notes: '', created_on: '', details: [] },
        ],
        children: [{ id: 2, subject: 'Child Issue' }],
        relations: [{ id: 1, issue_id: 1, issue_to_id: 3, relation_type: 'relates' }],
      };

      mockAxiosInstance.get.mockResolvedValue({
        data: { issue: mockIssue },
      });

      const result = await client.showIssue(1, { include: ['journals', 'children', 'relations'] });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues/1.json', {
        params: { include: 'journals,children,relations' },
      });
      expect(result.journals).toHaveLength(1);
      expect(result.children).toHaveLength(1);
      expect(result.relations).toHaveLength(1);
    });

    it('should not send include param when array is empty', async () => {
      const mockIssue: Partial<RedmineIssue> = {
        id: 1,
        subject: 'Test Issue',
      };

      mockAxiosInstance.get.mockResolvedValue({
        data: { issue: mockIssue },
      });

      await client.showIssue(1, { include: [] });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues/1.json', {
        params: {},
      });
    });

    it('should handle undefined include the same as omitted', async () => {
      const mockIssue: Partial<RedmineIssue> = {
        id: 1,
        subject: 'Test Issue',
      };

      mockAxiosInstance.get.mockResolvedValue({
        data: { issue: mockIssue },
      });

      await client.showIssue(1, { include: undefined });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues/1.json', {
        params: {},
      });
    });

    it('should support all valid Redmine include values', async () => {
      const allIncludes = [
        'journals',
        'attachments',
        'relations',
        'children',
        'watchers',
        'changesets',
      ];

      mockAxiosInstance.get.mockResolvedValue({
        data: { issue: { id: 1, subject: 'Test' } },
      });

      await client.showIssue(1, { include: allIncludes });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues/1.json', {
        params: { include: 'journals,attachments,relations,children,watchers,changesets' },
      });
    });
  });

  describe('searchIssues', () => {
    it('should search issues with query', async () => {
      const mockResponse = {
        data: {
          results: [{ id: 1, title: 'Test Result' }],
          total_count: 1,
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await client.searchIssues('test query');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/search.json', {
        params: {
          q: 'test query',
          issues: 1,
          limit: 25,
        },
      });
      expect(result).toEqual(mockResponse.data);
    });

    it('should search issues with project scope', async () => {
      const mockResponse = {
        data: {
          results: [],
          total_count: 0,
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      await client.searchIssues('bug', { project_id: 'my-project', limit: 10 });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/search.json', {
        params: {
          q: 'bug',
          issues: 1,
          limit: 10,
          scope: 'project:my-project',
        },
      });
    });
  });

  describe('createIssue', () => {
    it('should create issue with required fields only', async () => {
      const mockIssue: Partial<RedmineIssue> = {
        id: 1,
        subject: 'New Issue',
        project: { id: 1, name: 'Test Project' },
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: mockIssue },
      });

      const result = await client.createIssue({
        project_id: 'test-project',
        subject: '  New Issue  ',
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/issues.json', {
        issue: {
          project_id: 'test-project',
          subject: 'New Issue',
        },
      });
      expect(result).toEqual(mockIssue);
    });

    it('should create issue with all optional fields', async () => {
      const mockIssue: Partial<RedmineIssue> = {
        id: 1,
        subject: 'New Issue',
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: mockIssue },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'New Issue',
        description: 'Test description',
        tracker_id: 1,
        status_id: 2,
        priority_id: 3,
        assigned_to_id: 4,
        parent_issue_id: 5,
        estimated_hours: 8.5,
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/issues.json', {
        issue: {
          project_id: 'test-project',
          subject: 'New Issue',
          description: 'Test description',
          tracker_id: 1,
          status_id: 2,
          priority_id: 3,
          assigned_to_id: 4,
          parent_issue_id: 5,
          estimated_hours: 8.5,
        },
      });
    });

    it('should sanitize description', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'Test',
        description: '<script>alert("xss")</script>Safe text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('<script>');
      expect(call[1].issue.description).toContain('Safe text');
    });

    it('should sanitize multiline script tags', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'Test',
        description: '<script type="text/javascript">\nalert("xss")\n</script >Safe text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('alert');
      expect(call[1].issue.description).toContain('Safe text');
    });

    it('should sanitize event handler attributes', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'Test',
        description: '<img src="x" onerror="alert(1)">Safe text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('onerror');
      expect(call[1].issue.description).toContain('Safe text');
    });

    it('should sanitize vbscript: and data: URI schemes', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'Test',
        description:
          '<a href="vbscript:MsgBox">click</a> <img src="data:text/html;base64,PHNjcml">Safe',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('vbscript:');
      expect(call[1].issue.description).not.toContain('data:');
      expect(call[1].issue.description).toContain('Safe');
    });

    it('should handle nested dangerous tag payloads', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'Test',
        description: '<scr<script>ipt>alert(1)</script>Safe text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('<script');
      expect(call[1].issue.description).toContain('Safe text');
    });

    it('should sanitize closing tags with junk before >', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'Test',
        description: '<script>alert(1)</script\t\n bar>Safe text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('<script');
      expect(call[1].issue.description).not.toContain('alert');
      expect(call[1].issue.description).toContain('Safe text');
    });

    it('should sanitize data: URIs in plain text', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'Test',
        description: '"Click":data:text/html,<img onerror="alert(1)"> Safe text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('data:');
      expect(call[1].issue.description).toContain('Safe text');
    });

    it('should sanitize form tags', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test-project',
        subject: 'Test',
        description: '<form action="evil"><input type="submit"></form>Safe text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('<form');
      expect(call[1].issue.description).toContain('Safe text');
    });
  });

  describe('updateIssue', () => {
    const mockUpdatedIssue = {
      id: 1,
      subject: 'Updated Subject',
      status: { id: 2, name: 'In Progress' },
      assigned_to: { id: 5, name: 'Test User' },
      project: { id: 1, name: 'Test Project' },
    };

    it('should update issue with provided fields', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({ data: { issue: mockUpdatedIssue } });

      const result = await client.updateIssue(1, {
        subject: '  Updated Subject  ',
        status_id: 2,
        priority_id: 3,
      });

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/issues/1.json', {
        issue: {
          subject: 'Updated Subject',
          status_id: 2,
          priority_id: 3,
        },
      });
      expect(result.id).toBe(1);
    });

    it('should handle undefined values correctly', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({ data: { issue: mockUpdatedIssue } });

      await client.updateIssue(1, {
        description: '',
        assigned_to_id: 0,
        parent_issue_id: 0,
        estimated_hours: 0,
      });

      const call = mockAxiosInstance.put.mock.calls[0];
      expect(call[1].issue).toHaveProperty('description');
      expect(call[1].issue).toHaveProperty('assigned_to_id');
      expect(call[1].issue).toHaveProperty('parent_issue_id');
      expect(call[1].issue).toHaveProperty('estimated_hours');
    });

    it('should sanitize notes and description', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({ data: { issue: mockUpdatedIssue } });

      await client.updateIssue(1, {
        description: '<iframe src="evil"></iframe>Good text',
        notes: '<object data="bad"></object>Safe note',
      });

      const call = mockAxiosInstance.put.mock.calls[0];
      expect(call[1].issue.description).not.toContain('<iframe>');
      expect(call[1].issue.notes).not.toContain('<object>');
    });

    it('should update with notes only', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({ data: { issue: mockUpdatedIssue } });

      await client.updateIssue(1, {
        notes: 'Adding a comment',
      });

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/issues/1.json', {
        issue: {
          notes: 'Adding a comment',
        },
      });
    });

    it('should move issue to another project', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({
        data: { issue: { ...mockUpdatedIssue, id: 123, project: { id: 2, name: 'app' } } },
      });

      const result = await client.updateIssue(123, {
        project_id: 'app',
      });

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/issues/123.json', {
        issue: {
          project_id: 'app',
        },
      });
      expect(result.project.name).toBe('app');
    });

    it('should return updated issue for verification', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          issue: {
            id: 123,
            subject: 'Test Issue',
            status: { id: 6, name: 'Odrzucony' },
            assigned_to: null, // Redmine rejected assignment for closed issue
            project: { id: 1, name: 'Test' },
          },
        },
      });

      const result = await client.updateIssue(123, {
        assigned_to_id: 5,
      });

      // Caller can now verify if assignment was actually applied
      expect(result.assigned_to).toBeNull();
    });
  });

  describe('commentIssue', () => {
    it('should add comment to issue', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });

      await client.commentIssue(1, 'This is a comment');

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/issues/1.json', {
        issue: { notes: 'This is a comment' },
      });
    });

    it('should sanitize comment', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });

      await client.commentIssue(1, '<embed src="malicious">Good comment');

      const call = mockAxiosInstance.put.mock.calls[0];
      expect(call[1].issue.notes).not.toContain('<embed>');
      expect(call[1].issue.notes).toContain('Good comment');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Time Entry Operations
  //═══════════════════════════════════════════════════════════════════════════════

  describe('listTimeEntries', () => {
    it('should fetch time entries with default parameters', async () => {
      const mockResponse = {
        data: {
          time_entries: [
            {
              id: 1,
              hours: 4.5,
              project: { id: 1, name: 'Test' },
            },
          ],
          total_count: 1,
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await client.listTimeEntries();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/time_entries.json', {
        params: { limit: 25 },
      });
      expect(result).toEqual(mockResponse.data);
    });

    it('should fetch time entries with all filters', async () => {
      const mockResponse = {
        data: {
          time_entries: [],
          total_count: 0,
        },
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      await client.listTimeEntries({
        issue_id: 123,
        project_id: 'test-project',
        user_id: 456,
        from: '2024-01-01',
        to: '2024-01-31',
        limit: 50,
      });

      // When issue_id is present, project_id is not sent to API (issue_id filter is sufficient)
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/time_entries.json', {
        params: {
          limit: 50,
          issue_id: 123,
          user_id: 456,
          from: '2024-01-01',
          to: '2024-01-31',
        },
      });
    });
  });

  describe('createTimeEntry', () => {
    it('should create time entry with required fields', async () => {
      const mockTimeEntry: Partial<RedmineTimeEntry> = {
        id: 1,
        hours: 4.5,
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { time_entry: mockTimeEntry },
      });

      const result = await client.createTimeEntry({ hours: 4.5 });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/time_entries.json', {
        time_entry: { hours: 4.5 },
      });
      expect(result).toEqual(mockTimeEntry);
    });

    it('should create time entry with all optional fields', async () => {
      const mockTimeEntry: Partial<RedmineTimeEntry> = {
        id: 1,
        hours: 8,
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { time_entry: mockTimeEntry },
      });

      await client.createTimeEntry({
        issue_id: 123,
        project_id: 'test-project',
        hours: 8,
        activity_id: 9,
        comments: 'Development work',
        spent_on: '2024-01-15',
      });

      // When issue_id is present, project_id is not sent to Redmine (Redmine derives project from issue)
      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/time_entries.json', {
        time_entry: {
          issue_id: 123,
          hours: 8,
          activity_id: 9,
          comments: 'Development work',
          spent_on: '2024-01-15',
        },
      });
    });
  });

  describe('updateTimeEntry', () => {
    it('should update time entry fields', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });

      await client.updateTimeEntry(1, {
        hours: 6,
        activity_id: 5,
        comments: 'Updated comments',
      });

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/time_entries/1.json', {
        time_entry: {
          hours: 6,
          activity_id: 5,
          comments: 'Updated comments',
        },
      });
    });

    it('should handle zero and empty values', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });

      await client.updateTimeEntry(1, {
        hours: 0,
        comments: '',
      });

      const call = mockAxiosInstance.put.mock.calls[0];
      expect(call[1].time_entry).toHaveProperty('hours', 0);
      expect(call[1].time_entry).toHaveProperty('comments', '');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Journal Operations
  //═══════════════════════════════════════════════════════════════════════════════

  describe('listJournals', () => {
    it('should fetch journals for an issue', async () => {
      const mockJournals: RedmineJournal[] = [
        {
          id: 1,
          user: { id: 1, name: 'Test User' },
          notes: 'Journal note',
          created_on: '2024-01-01T00:00:00Z',
          details: [],
        },
      ];

      mockAxiosInstance.get.mockResolvedValue({
        data: {
          issue: {
            id: 1,
            journals: mockJournals,
          },
        },
      });

      const result = await client.listJournals(1);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues/1.json', {
        params: { include: 'journals' },
      });
      expect(result).toEqual(mockJournals);
    });

    it('should return empty array when no journals', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          issue: {
            id: 1,
          },
        },
      });

      const result = await client.listJournals(1);
      expect(result).toEqual([]);
    });
  });

  describe('updateJournal', () => {
    it('should update journal notes', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });

      await client.updateJournal(1, 2, 'Updated notes');

      expect(mockAxiosInstance.put).toHaveBeenCalledWith('/issues/1/journals/2.json', {
        journal: { notes: 'Updated notes' },
      });
    });

    it('should sanitize journal notes', async () => {
      mockAxiosInstance.put.mockResolvedValue({ data: {} });

      await client.updateJournal(1, 2, 'javascript:alert("xss")Good notes');

      const call = mockAxiosInstance.put.mock.calls[0];
      expect(call[1].journal.notes).not.toContain('javascript:');
      expect(call[1].journal.notes).toContain('Good notes');
    });
  });

  describe('deleteJournal', () => {
    it('should delete journal', async () => {
      mockAxiosInstance.delete.mockResolvedValue({ data: {} });

      await client.deleteJournal(1, 2);

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/issues/1/journals/2.json');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // User Operations
  //═══════════════════════════════════════════════════════════════════════════════

  describe('getCurrentUser', () => {
    it('should fetch current user', async () => {
      const mockUser: RedmineUser = {
        id: 1,
        login: 'testuser',
        firstname: 'Test',
        lastname: 'User',
        mail: 'test@example.com',
        created_on: '2024-01-01T00:00:00Z',
        updated_on: '2024-01-01T00:00:00Z',
      };

      mockAxiosInstance.get.mockResolvedValue({
        data: { user: mockUser },
      });

      const result = await client.getCurrentUser();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users/current.json');
      expect(result).toEqual(mockUser);
    });
  });

  describe('listUsers', () => {
    it('should fetch all users when no project specified', async () => {
      const mockUsers: RedmineUser[] = [
        {
          id: 1,
          login: 'user1',
          firstname: 'User',
          lastname: 'One',
          created_on: '2024-01-01T00:00:00Z',
          updated_on: '2024-01-01T00:00:00Z',
        },
      ];

      mockAxiosInstance.get.mockResolvedValue({
        data: { users: mockUsers },
      });

      const result = await client.listUsers();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users.json');
      expect(result).toEqual(mockUsers);
    });

    it('should fetch project members when project specified', async () => {
      const mockMemberships = [
        {
          user: {
            id: 1,
            login: 'user1',
            firstname: 'User',
            lastname: 'One',
          },
        },
        {
          user: {
            id: 2,
            login: 'user2',
            firstname: 'User',
            lastname: 'Two',
          },
        },
      ];

      mockAxiosInstance.get.mockResolvedValue({
        data: { memberships: mockMemberships },
      });

      const result = await client.listUsers('test-project');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/projects/test-project/memberships.json');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(2);
    });
  });

  describe('resolveUser', () => {
    it('should resolve "me" to current user id', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          user: {
            id: 123,
            login: 'currentuser',
          },
        },
      });

      const result = await client.resolveUser('me');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users/current.json');
      expect(result).toBe(123);
    });

    it('should resolve numeric string to number', async () => {
      const result = await client.resolveUser('456');
      expect(result).toBe(456);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('should search for user by name', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          users: [
            {
              id: 789,
              login: 'johndoe',
              firstname: 'John',
              lastname: 'Doe',
            },
          ],
        },
      });

      const result = await client.resolveUser('John Doe');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users.json', {
        params: { name: 'John Doe' },
      });
      expect(result).toBe(789);
    });

    it('should return null when user not found', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { users: [] },
      });

      const result = await client.resolveUser('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null when users array is missing', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {},
      });

      const result = await client.resolveUser('nonexistent');
      expect(result).toBeNull();
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Relation Operations
  //═══════════════════════════════════════════════════════════════════════════════

  describe('listRelations', () => {
    it('should list relations for an issue', async () => {
      const mockRelations = [
        { id: 1, issue_id: 100, issue_to_id: 101, relation_type: 'blocks' },
        { id: 2, issue_id: 100, issue_to_id: 102, relation_type: 'relates' },
      ];

      mockAxiosInstance.get.mockResolvedValue({
        data: { relations: mockRelations },
      });

      const result = await client.listRelations(100);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues/100/relations.json');
      expect(result.relations).toHaveLength(2);
      expect(result.relations[0].relation_type).toBe('blocks');
    });

    it('should return empty array when no relations exist', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { relations: [] },
      });

      const result = await client.listRelations(999);

      expect(result.relations).toEqual([]);
    });

    it('should handle missing relations array in response', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: {},
      });

      const result = await client.listRelations(999);

      expect(result.relations).toEqual([]);
    });
  });

  describe('createRelation', () => {
    it('should create relation with minimal params', async () => {
      const mockRelation = {
        id: 1,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'relates',
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { relation: mockRelation },
      });

      const result = await client.createRelation({
        issue_id: 100,
        issue_to_id: 101,
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/issues/100/relations.json', {
        relation: { issue_to_id: 101 },
      });
      expect(result.relation.id).toBe(1);
    });

    it('should create relation with type', async () => {
      const mockRelation = {
        id: 2,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'blocks',
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { relation: mockRelation },
      });

      const result = await client.createRelation({
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'blocks',
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/issues/100/relations.json', {
        relation: { issue_to_id: 101, relation_type: 'blocks' },
      });
      expect(result.relation.relation_type).toBe('blocks');
    });

    it('should create relation with type and delay', async () => {
      const mockRelation = {
        id: 3,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: 3,
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { relation: mockRelation },
      });

      const result = await client.createRelation({
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: 3,
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/issues/100/relations.json', {
        relation: { issue_to_id: 101, relation_type: 'precedes', delay: 3 },
      });
      expect(result.relation.delay).toBe(3);
    });

    it('should handle zero delay', async () => {
      const mockRelation = {
        id: 4,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: 0,
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { relation: mockRelation },
      });

      await client.createRelation({
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: 0,
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].relation).toHaveProperty('delay', 0);
    });
  });

  describe('deleteRelation', () => {
    it('should delete relation by id', async () => {
      mockAxiosInstance.delete.mockResolvedValue({ status: 204 });

      await client.deleteRelation(123);

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/relations/123.json');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Relation Error Handling
  //═══════════════════════════════════════════════════════════════════════════════

  describe('listRelations - error handling', () => {
    it('should throw when issue does not exist (404)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 404, data: {} },
        message: 'Request failed with status code 404',
      };
      mockAxiosInstance.get.mockRejectedValue(axiosError);

      await expect(client.listRelations(99999)).rejects.toBeDefined();
    });

    it('should throw on permission denied (403)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 403, data: {} },
        message: 'Request failed with status code 403',
      };
      mockAxiosInstance.get.mockRejectedValue(axiosError);

      await expect(client.listRelations(100)).rejects.toBeDefined();
    });

    it('should throw on authentication failure (401)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 401, data: {} },
        message: 'Request failed with status code 401',
      };
      mockAxiosInstance.get.mockRejectedValue(axiosError);

      await expect(client.listRelations(100)).rejects.toBeDefined();
    });

    it('should throw on network error', async () => {
      const networkError = new Error('Network Error');
      mockAxiosInstance.get.mockRejectedValue(networkError);

      await expect(client.listRelations(100)).rejects.toThrow('Network Error');
    });
  });

  describe('createRelation - error handling', () => {
    it('should throw on duplicate relation (422)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 422, data: { errors: ['Relation already exists'] } },
        message: 'Request failed with status code 422',
      };
      mockAxiosInstance.post.mockRejectedValue(axiosError);

      await expect(
        client.createRelation({
          issue_id: 100,
          issue_to_id: 101,
        })
      ).rejects.toBeDefined();
    });

    it('should throw when creating self-referential relation', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 422, data: { errors: ['Cannot relate to itself'] } },
        message: 'Request failed with status code 422',
      };
      mockAxiosInstance.post.mockRejectedValue(axiosError);

      await expect(
        client.createRelation({
          issue_id: 100,
          issue_to_id: 100,
        })
      ).rejects.toBeDefined();
    });

    it('should throw when issue not found (404)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 404, data: {} },
        message: 'Request failed with status code 404',
      };
      mockAxiosInstance.post.mockRejectedValue(axiosError);

      await expect(
        client.createRelation({
          issue_id: 99999,
          issue_to_id: 100,
        })
      ).rejects.toBeDefined();
    });

    it('should throw on permission denied (403)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 403, data: {} },
        message: 'Request failed with status code 403',
      };
      mockAxiosInstance.post.mockRejectedValue(axiosError);

      await expect(
        client.createRelation({
          issue_id: 100,
          issue_to_id: 101,
          relation_type: 'blocks',
        })
      ).rejects.toBeDefined();
    });

    it('should throw on network error', async () => {
      const networkError = new Error('Network Error');
      mockAxiosInstance.post.mockRejectedValue(networkError);

      await expect(
        client.createRelation({
          issue_id: 100,
          issue_to_id: 101,
        })
      ).rejects.toThrow('Network Error');
    });

    it('should handle negative delay', async () => {
      const mockRelation = {
        id: 1,
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: -1,
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: { relation: mockRelation },
      });

      const result = await client.createRelation({
        issue_id: 100,
        issue_to_id: 101,
        relation_type: 'precedes',
        delay: -1,
      });

      expect(result.relation.delay).toBe(-1);
    });
  });

  describe('deleteRelation - error handling', () => {
    it('should throw when relation not found (404)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 404, data: {} },
        message: 'Request failed with status code 404',
      };
      mockAxiosInstance.delete.mockRejectedValue(axiosError);

      await expect(client.deleteRelation(99999)).rejects.toBeDefined();
    });

    it('should throw on permission denied (403)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 403, data: {} },
        message: 'Request failed with status code 403',
      };
      mockAxiosInstance.delete.mockRejectedValue(axiosError);

      await expect(client.deleteRelation(123)).rejects.toBeDefined();
    });

    it('should throw on authentication failure (401)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { status: 401, data: {} },
        message: 'Request failed with status code 401',
      };
      mockAxiosInstance.delete.mockRejectedValue(axiosError);

      await expect(client.deleteRelation(123)).rejects.toBeDefined();
    });

    it('should throw on network error', async () => {
      const networkError = new Error('Network Error');
      mockAxiosInstance.delete.mockRejectedValue(networkError);

      await expect(client.deleteRelation(123)).rejects.toThrow('Network Error');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Error Handling
  //═══════════════════════════════════════════════════════════════════════════════

  describe('formatError', () => {
    beforeEach(() => {
      // Mock axios.isAxiosError to return true for our test errors
      vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    });

    it('should format 401 authentication error', () => {
      const error = {
        isAxiosError: true,
        response: {
          status: 401,
          data: {},
        },
        message: 'Unauthorized',
      } as AxiosError;

      const result = RedmineClient.formatError(error);
      expect(result).toContain('Authentication failed');
      expect(result).toBe(withSetupGuidance('Authentication failed. Check your Redmine API key.'));
    });

    it('should format 403 permission error', () => {
      const error = {
        isAxiosError: true,
        response: {
          status: 403,
          data: {},
        },
        message: 'Forbidden',
      } as AxiosError;

      const result = RedmineClient.formatError(error);
      expect(result).toContain('Permission denied');
    });

    it('should format 404 not found error', () => {
      const error = {
        isAxiosError: true,
        response: {
          status: 404,
          data: {},
        },
        message: 'Not Found',
      } as AxiosError;

      const result = RedmineClient.formatError(error);
      expect(result).toContain('Resource not found');
    });

    it('should format 422 validation error with details', () => {
      const error = {
        isAxiosError: true,
        response: {
          status: 422,
          data: {
            errors: ['Subject cannot be blank', 'Priority is invalid'],
          },
        },
        message: 'Unprocessable Entity',
      } as AxiosError;

      const result = RedmineClient.formatError(error);
      expect(result).toContain('Validation error');
      expect(result).toContain('Subject cannot be blank');
    });

    it('should format generic HTTP error with status', () => {
      const error = {
        isAxiosError: true,
        response: {
          status: 500,
          data: {},
        },
        message: 'Internal Server Error',
      } as AxiosError;

      const result = RedmineClient.formatError(error);
      expect(result).toContain('HTTP 500');
      expect(result).toContain('Internal Server Error');
    });

    it('should format network error', () => {
      // Create an error without response (network error)
      const error = {
        isAxiosError: true,
        request: {},
        response: undefined,
        message: 'Network Error',
      } as any as AxiosError;

      const result = RedmineClient.formatError(error);
      expect(result).toContain('Network error');
      expect(result).toContain('Redmine URL');
    });

    it('should format errors with error details in response', () => {
      const error = {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            errors: { base: ['Invalid request'] },
          },
        },
        message: 'Bad Request',
      } as AxiosError;

      const result = RedmineClient.formatError(error);
      expect(result).toContain('Error:');
      expect(result).toContain('Invalid request');
    });

    it('should format non-axios errors', () => {
      vi.spyOn(axios, 'isAxiosError').mockReturnValue(false);
      const error = new Error('Generic error');
      const result = RedmineClient.formatError(error);
      expect(result).toBe('Generic error');
    });

    it('should handle errors without message', () => {
      vi.spyOn(axios, 'isAxiosError').mockReturnValue(false);
      const error = { toString: () => 'Error object' };
      const result = RedmineClient.formatError(error);
      expect(result).toBe('Unknown error');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Retry Mechanism
  //═══════════════════════════════════════════════════════════════════════════════

  describe('retry interceptor', () => {
    it('should retry failed requests up to 3 times', async () => {
      // Get the interceptor
      const interceptorCall = mockInterceptors.response.use.mock.calls[0];
      const errorHandler = interceptorCall[1];

      const mockError = {
        config: {} as Record<string, unknown>,
        message: 'Network error',
      };

      // First retry
      void errorHandler(mockError);
      expect(mockError.config.__retryCount).toBe(1);

      // Second retry
      mockError.config.__retryCount = 2;
      void errorHandler(mockError);
      expect(mockError.config.__retryCount).toBe(3);

      // Third retry should reject
      mockError.config.__retryCount = 3;
      await expect(errorHandler(mockError)).rejects.toEqual(mockError);
    });

    it('should not retry when config is missing', async () => {
      const interceptorCall = mockInterceptors.response.use.mock.calls[0];
      const errorHandler = interceptorCall[1];

      const mockError = {
        message: 'Network error',
      };

      await expect(errorHandler(mockError)).rejects.toEqual(mockError);
    });

    it('should set retry count and call axios instance on retry', async () => {
      const interceptorCall = mockInterceptors.response.use.mock.calls[0];
      const errorHandler = interceptorCall[1];

      const mockError = {
        config: { url: '/test' } as Record<string, unknown>,
        message: 'Network error',
      };

      // Start the retry (but don't await - it has a delay)
      void errorHandler(mockError);

      // The retry count should be set
      expect(mockError.config.__retryCount).toBe(1);

      // Note: We can't easily test the setTimeout delay without useFakeTimers
      // which vitest handles differently. The important part is the retry count logic.
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Input Sanitization
  //═══════════════════════════════════════════════════════════════════════════════

  describe('input sanitization', () => {
    it('should remove script tags from input', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test',
        subject: 'Test',
        description: 'Before <script>alert("xss")</script> After',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).toBe('Before  After');
    });

    it('should remove iframe tags from input', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test',
        subject: 'Test',
        description: '<iframe src="evil.com">content</iframe>safe',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('iframe');
      expect(call[1].issue.description).toContain('safe');
    });

    it('should remove object tags from input', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test',
        subject: 'Test',
        description: '<object data="bad.swf"></object>clean',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('object');
    });

    it('should remove embed tags from input', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test',
        subject: 'Test',
        description: '<embed src="evil.swf">text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('embed');
    });

    it('should remove javascript: protocol from input', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test',
        subject: 'Test',
        description: 'Link: javascript:alert("xss") safe text',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('javascript:');
    });

    it('should handle case-insensitive tag matching', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: { issue: { id: 1 } },
      });

      await client.createIssue({
        project_id: 'test',
        subject: 'Test',
        description: '<SCRIPT>alert()</SCRIPT><iFrAmE></iFrAmE>safe',
      });

      const call = mockAxiosInstance.post.mock.calls[0];
      expect(call[1].issue.description).not.toContain('SCRIPT');
      expect(call[1].issue.description).not.toContain('iFrAmE');
      expect(call[1].issue.description).toContain('safe');
    });
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Project Scoping
  //═══════════════════════════════════════════════════════════════════════════════

  describe('Project Scoping', () => {
    const scopedProjectConfig: RedmineProjectConfig = {
      host_url: 'https://redmine.example.com',
      project_id: 'my-project',
    };

    const scopedProject = {
      id: 42,
      identifier: 'my-project',
      name: 'My Project',
      status: 1,
      is_public: true,
      created_on: '2024-01-01T00:00:00Z',
      updated_on: '2024-01-01T00:00:00Z',
    };

    const inScopeIssue = {
      id: 1,
      subject: 'In-scope issue',
      project: { id: 42, name: 'My Project' },
      tracker: { id: 1, name: 'Bug' },
      status: { id: 1, name: 'New' },
      priority: { id: 2, name: 'Normal' },
      author: { id: 1, name: 'Test User' },
      created_on: '2024-01-01T00:00:00Z',
      updated_on: '2024-01-01T00:00:00Z',
    };

    const outOfScopeIssue = {
      id: 2,
      subject: 'Out-of-scope issue',
      project: { id: 99, name: 'Other Project' },
      tracker: { id: 1, name: 'Bug' },
      status: { id: 1, name: 'New' },
      priority: { id: 2, name: 'Normal' },
      author: { id: 1, name: 'Test User' },
      created_on: '2024-01-01T00:00:00Z',
      updated_on: '2024-01-01T00:00:00Z',
    };

    /** Route mockAxiosInstance.get by URL for scoped tests. */
    function setupScopedGetMock(overrides?: Record<string, any>) {
      mockAxiosInstance.get.mockImplementation((url: string) => {
        if (overrides?.[url] !== undefined) {
          const v = overrides[url];
          if (v instanceof Error) return Promise.reject(v);
          return Promise.resolve(v);
        }
        if (url === '/projects/my-project.json') {
          return Promise.resolve({ data: { project: scopedProject } });
        }
        if (url === `/issues/${inScopeIssue.id}.json`) {
          return Promise.resolve({ data: { issue: inScopeIssue } });
        }
        if (url === `/issues/${outOfScopeIssue.id}.json`) {
          return Promise.resolve({ data: { issue: outOfScopeIssue } });
        }
        return Promise.reject(new Error(`Unexpected GET ${url}`));
      });
    }

    // ─── getProjectScope() ───────────────────────────────────────────────

    describe('getProjectScope()', () => {
      it('should return null when projectConfig is null', () => {
        const c = new RedmineClient(config, null);
        expect(c.getProjectScope()).toBeNull();
      });

      it('should return null when projectConfig has no project_id', () => {
        const c = new RedmineClient(config, { host_url: 'https://redmine.example.com' });
        expect(c.getProjectScope()).toBeNull();
      });

      it('should return null when project_id is empty string', () => {
        const c = new RedmineClient(config, {
          host_url: 'https://redmine.example.com',
          project_id: '',
        });
        expect(c.getProjectScope()).toBeNull();
      });

      it('should return null when project_id is whitespace-only', () => {
        const c = new RedmineClient(config, {
          host_url: 'https://redmine.example.com',
          project_id: '   ',
        });
        expect(c.getProjectScope()).toBeNull();
      });

      it('should return trimmed project_id when set', () => {
        const c = new RedmineClient(config, {
          host_url: 'https://redmine.example.com',
          project_id: ' my-project ',
        });
        expect(c.getProjectScope()).toBe('my-project');
      });
    });

    // ─── _enforceProjectId() via listIssues() ────────────────────────────

    describe('_enforceProjectId() via listIssues()', () => {
      it('should throw ProjectScopeError when scoped and project_id mismatches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();

        await expect(scopedClient.listIssues({ project_id: 'other-project' })).rejects.toThrow(
          ProjectScopeError
        );
      });

      it('should pass through any project_id when unscoped', async () => {
        mockAxiosInstance.get.mockResolvedValue({
          data: { issues: [], total_count: 0 },
        });

        await client.listIssues({ project_id: 'any-project' });

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues.json', {
          params: expect.objectContaining({ project_id: 'any-project' }),
        });
      });

      it('should force scope when scoped and project_id is undefined', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { issues: [], total_count: 0 },
        });

        await scopedClient.listIssues();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues.json', {
          params: expect.objectContaining({ project_id: 'my-project' }),
        });
      });

      it('should succeed when scoped and project_id matches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { issues: [], total_count: 0 },
        });

        await scopedClient.listIssues({ project_id: 'my-project' });

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues.json', {
          params: expect.objectContaining({ project_id: 'my-project' }),
        });
      });
    });

    // ─── _resolveProjectNumericId() cache via showIssue() ────────────────

    describe('_resolveProjectNumericId() cache via showIssue()', () => {
      it('should cache the numeric ID after the first call', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();

        await scopedClient.showIssue(1);

        // First call: GET /issues/1.json (showIssue fetch) + GET /projects/my-project.json (resolve numeric ID)
        expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
        const firstCallUrls = mockAxiosInstance.get.mock.calls.map((c: any[]) => c[0]);
        expect(firstCallUrls).toContain('/projects/my-project.json');
        expect(firstCallUrls).toContain('/issues/1.json');

        mockAxiosInstance.get.mockClear();
        setupScopedGetMock();

        await scopedClient.showIssue(1);

        // Second call: only GET /issues/1.json (cache hit for project numeric ID)
        expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
        expect(mockAxiosInstance.get.mock.calls[0][0]).toBe('/issues/1.json');
      });

      it('should throw ProjectScopeError when project returns 404', async () => {
        const scopedClient = new RedmineClient(config, {
          host_url: 'https://redmine.example.com',
          project_id: 'nonexistent',
        });

        // Create a plain error with response.status to simulate Axios 404
        const axiosLikeError = Object.assign(new Error('Not Found'), {
          isAxiosError: true,
          response: { status: 404, statusText: 'Not Found', headers: {}, config: {}, data: {} },
        });
        vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);

        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/nonexistent.json') {
            return Promise.reject(axiosLikeError);
          }
          if (url === '/issues/1.json') {
            return Promise.resolve({ data: { issue: inScopeIssue } });
          }
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.showIssue(1)).rejects.toThrow(ProjectScopeError);
        await expect(scopedClient.showIssue(1)).rejects.toThrow('not found');
      });

      it('should retry after rejection (cache cleared on failure)', async () => {
        const scopedClient = new RedmineClient(config, {
          host_url: 'https://redmine.example.com',
          project_id: 'flaky',
        });

        const networkError = new Error('Network error');

        // First call: fails
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/flaky.json') {
            return Promise.reject(networkError);
          }
          return Promise.resolve({
            data: { issue: { ...inScopeIssue, project: { id: 42, name: 'Flaky' } } },
          });
        });

        await expect(scopedClient.showIssue(1)).rejects.toThrow('Network error');

        // Second call: succeeds (cache was cleared)
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/flaky.json') {
            return Promise.resolve({ data: { project: { id: 42, identifier: 'flaky' } } });
          }
          return Promise.resolve({
            data: { issue: { ...inScopeIssue, project: { id: 42, name: 'Flaky' } } },
          });
        });

        const issue = await scopedClient.showIssue(1);
        expect(issue.project.id).toBe(42);
      });
    });

    // ─── showProject() scoping ──────────────────────────────────────────

    describe('showProject() scoping', () => {
      it('should succeed when scoped and identifier matches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.showProject('my-project');
        expect(result.identifier).toBe('my-project');
      });

      it('should succeed when scoped and numeric ID resolves to matching identifier', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.showProject(42);
        expect(result.id).toBe(42);
      });

      it('should throw when scoped and numeric ID resolves to different identifier', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: {
            project: { ...scopedProject, id: 42, identifier: 'other-project' },
          },
        });

        await expect(scopedClient.showProject(42)).rejects.toThrow(ProjectScopeError);
      });

      it('should throw when scoped and identifier is different', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: {
            project: {
              ...scopedProject,
              identifier: 'other-project',
              name: 'Other Project',
            },
          },
        });

        await expect(scopedClient.showProject('other-project')).rejects.toThrow(ProjectScopeError);
      });

      it('should succeed when Redmine returns lowercase identifier matching scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        // Request "My-Project" but Redmine canonicalizes to "my-project"
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.showProject('My-Project');
        expect(result.identifier).toBe('my-project');
      });

      it('should return any project when unscoped', async () => {
        mockAxiosInstance.get.mockResolvedValue({
          data: {
            project: {
              ...scopedProject,
              id: 99,
              identifier: 'any-project',
              name: 'Any Project',
            },
          },
        });

        const result = await client.showProject('any-project');
        expect(result.identifier).toBe('any-project');
      });

      it('should succeed when scope is a numeric string matching project.id', async () => {
        const numericScopeConfig: RedmineProjectConfig = {
          host_url: 'https://redmine.example.com',
          project_id: '42',
        };
        const numericScopeClient = new RedmineClient(config, numericScopeConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject }, // project.id=42, identifier='my-project'
        });

        const result = await numericScopeClient.showProject('42');
        expect(result.id).toBe(42);
      });

      it('should throw when scope is numeric string not matching project.id', async () => {
        const numericScopeConfig: RedmineProjectConfig = {
          host_url: 'https://redmine.example.com',
          project_id: '99',
        };
        const numericScopeClient = new RedmineClient(config, numericScopeConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject }, // project.id=42, identifier='my-project'
        });

        await expect(numericScopeClient.showProject('99')).rejects.toThrow(ProjectScopeError);
      });
    });

    // ─── listProjects() scoping ─────────────────────────────────────────

    describe('listProjects() scoping', () => {
      it('should return only configured project when scoped', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.listProjects();

        expect(result.projects).toHaveLength(1);
        expect(result.projects[0].identifier).toBe('my-project');
        expect(result.total_count).toBe(1);
      });

      it('should return project when scoped and status filter matches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: { ...scopedProject, status: 1 } },
        });

        const result = await scopedClient.listProjects({ status: 'active' });

        expect(result.projects).toHaveLength(1);
      });

      it('should return empty when scoped and status filter does not match', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: { ...scopedProject, status: 1 } },
        });

        const result = await scopedClient.listProjects({ status: 'closed' });

        expect(result.projects).toHaveLength(0);
        expect(result.total_count).toBe(0);
      });

      it('should still return single project when scoped with limit/offset', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.listProjects({ limit: 10, offset: 5 });

        expect(result.projects).toHaveLength(1);
        expect(result.total_count).toBe(1);
      });

      it('should call /projects.json when unscoped', async () => {
        mockAxiosInstance.get.mockResolvedValue({
          data: {
            projects: [scopedProject],
            total_count: 1,
          },
        });

        await client.listProjects();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/projects.json', {
          params: { limit: 100, offset: 0 },
        });
      });
    });

    // ─── searchProjects() scoping ───────────────────────────────────────

    describe('searchProjects() scoping', () => {
      it('should return project when scoped and query matches name', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.searchProjects('My Project');

        expect(result.projects).toHaveLength(1);
        expect(result.total_count).toBe(1);
      });

      it('should return project when scoped and query partially matches name', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.searchProjects('my');

        expect(result.projects).toHaveLength(1);
      });

      it('should return project when scoped and query matches identifier', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.searchProjects('my-project');

        expect(result.projects).toHaveLength(1);
      });

      it('should return project when scoped and query matches description', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: {
            project: { ...scopedProject, description: 'A sample project for testing' },
          },
        });

        const result = await scopedClient.searchProjects('sample');

        expect(result.projects).toHaveLength(1);
      });

      it('should return empty when scoped and query does not match', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { project: scopedProject },
        });

        const result = await scopedClient.searchProjects('nonexistent');

        expect(result.projects).toHaveLength(0);
        expect(result.total_count).toBe(0);
      });

      it('should handle undefined description without TypeError when scoped', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: {
            project: { ...scopedProject, description: undefined },
          },
        });

        const result = await scopedClient.searchProjects('nonexistent');

        expect(result.projects).toHaveLength(0);
      });

      it('should search all projects when unscoped', async () => {
        mockAxiosInstance.get.mockResolvedValue({
          data: {
            projects: [
              { id: 1, identifier: 'alpha', name: 'Alpha', description: '' },
              { id: 2, identifier: 'beta', name: 'Beta', description: '' },
            ],
            total_count: 2,
          },
        });

        const result = await client.searchProjects('alpha');

        expect(result.projects).toHaveLength(1);
        expect(result.projects[0].identifier).toBe('alpha');
      });
    });

    // ─── listIssues() / searchIssues() scoping ──────────────────────────

    describe('listIssues() / searchIssues() scoping', () => {
      it('should force scope in params when scoped and no project_id', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { issues: [], total_count: 0 },
        });

        await scopedClient.listIssues();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues.json', {
          params: expect.objectContaining({ project_id: 'my-project' }),
        });
      });

      it('should succeed when scoped and project_id matches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { issues: [], total_count: 0 },
        });

        await scopedClient.listIssues({ project_id: 'my-project' });

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/issues.json', {
          params: expect.objectContaining({ project_id: 'my-project' }),
        });
      });

      it('should throw when scoped and project_id differs', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);

        await expect(scopedClient.listIssues({ project_id: 'other-project' })).rejects.toThrow(
          ProjectScopeError
        );
      });

      it('should force scope in searchIssues when scoped', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { results: [], total_count: 0 },
        });

        await scopedClient.searchIssues('test query');

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/search.json', {
          params: expect.objectContaining({ scope: 'project:my-project' }),
        });
      });

      it('should throw in searchIssues when scoped and project_id differs', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);

        await expect(
          scopedClient.searchIssues('test', { project_id: 'other-project' })
        ).rejects.toThrow(ProjectScopeError);
      });
    });

    // ─── showIssue() scoping ────────────────────────────────────────────

    describe('showIssue() scoping', () => {
      it('should succeed when scoped and issue.project.id matches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();

        const result = await scopedClient.showIssue(1);

        expect(result.id).toBe(1);
      });

      it('should throw when scoped and issue.project.id differs', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();

        await expect(scopedClient.showIssue(2)).rejects.toThrow(ProjectScopeError);
      });

      it('should return any issue when unscoped', async () => {
        mockAxiosInstance.get.mockResolvedValue({
          data: { issue: outOfScopeIssue },
        });

        const result = await client.showIssue(2);

        expect(result.id).toBe(2);
        expect(result.project.id).toBe(99);
      });
    });

    // ─── updateIssue() scoping ──────────────────────────────────────────

    describe('updateIssue() scoping', () => {
      it('should validate issue scope before PUT when scoped', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();
        mockAxiosInstance.put.mockResolvedValue({ data: {} });

        await scopedClient.updateIssue(1, { subject: 'Updated' });

        expect(mockAxiosInstance.put).toHaveBeenCalledWith('/issues/1.json', expect.anything());
      });

      it('should throw when scoped and issue is out of scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();

        await expect(scopedClient.updateIssue(2, { subject: 'Updated' })).rejects.toThrow(
          ProjectScopeError
        );
      });

      it('should succeed when scoped and options.project_id matches scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();
        mockAxiosInstance.put.mockResolvedValue({ data: {} });

        await scopedClient.updateIssue(1, { project_id: 'my-project' });

        expect(mockAxiosInstance.put).toHaveBeenCalled();
      });

      it('should throw when scoped and options.project_id differs', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();

        await expect(scopedClient.updateIssue(1, { project_id: 'other-project' })).rejects.toThrow(
          ProjectScopeError
        );
      });
    });

    // ─── listTimeEntries() scoping ──────────────────────────────────────

    describe('listTimeEntries() scoping', () => {
      it('should force project_id when scoped and no issue_id or project_id', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { time_entries: [], total_count: 0 },
        });

        await scopedClient.listTimeEntries();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/time_entries.json', {
          params: expect.objectContaining({ project_id: 'my-project' }),
        });
      });

      it('should validate issue and omit project_id when scoped with issue_id only', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock({
          '/time_entries.json': { data: { time_entries: [], total_count: 0 } },
        });

        await scopedClient.listTimeEntries({ issue_id: 1 });

        const getCall = mockAxiosInstance.get.mock.calls.find(
          (c: any[]) => c[0] === '/time_entries.json'
        );
        expect(getCall).toBeDefined();
        expect(getCall![1].params).not.toHaveProperty('project_id');
        expect(getCall![1].params).toHaveProperty('issue_id', 1);
      });

      it('should throw when scoped and project_id mismatches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);

        await expect(scopedClient.listTimeEntries({ project_id: 'other-project' })).rejects.toThrow(
          ProjectScopeError
        );
      });
    });

    // ─── createTimeEntry() scoping ──────────────────────────────────────

    describe('createTimeEntry() scoping', () => {
      it('should validate issue and omit project_id when scoped with issue_id only', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();
        mockAxiosInstance.post.mockResolvedValue({
          data: {
            time_entry: {
              id: 10,
              hours: 2,
              project: { id: 42, name: 'My Project' },
              user: { id: 1, name: 'Test User' },
              activity: { id: 1, name: 'Development' },
              spent_on: '2024-01-01',
              created_on: '2024-01-01T00:00:00Z',
              updated_on: '2024-01-01T00:00:00Z',
            },
          },
        });

        await scopedClient.createTimeEntry({ issue_id: 1, hours: 2 });

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/time_entries.json',
          expect.objectContaining({
            time_entry: expect.not.objectContaining({ project_id: expect.anything() }),
          })
        );
      });

      it('should inject scope when scoped and no issue_id or project_id', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.post.mockResolvedValue({
          data: {
            time_entry: {
              id: 10,
              hours: 2,
              project: { id: 42, name: 'My Project' },
              user: { id: 1, name: 'Test User' },
              activity: { id: 1, name: 'Development' },
              spent_on: '2024-01-01',
              created_on: '2024-01-01T00:00:00Z',
              updated_on: '2024-01-01T00:00:00Z',
            },
          },
        });

        await scopedClient.createTimeEntry({ hours: 2 });

        expect(mockAxiosInstance.post).toHaveBeenCalledWith(
          '/time_entries.json',
          expect.objectContaining({
            time_entry: expect.objectContaining({ project_id: 'my-project' }),
          })
        );
      });

      it('should validate issue and omit project_id when scoped with issue_id + matching project_id', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();
        mockAxiosInstance.post.mockResolvedValue({
          data: {
            time_entry: {
              id: 10,
              hours: 2,
              project: { id: 42, name: 'My Project' },
              user: { id: 1, name: 'Test User' },
              activity: { id: 1, name: 'Development' },
              spent_on: '2024-01-01',
              created_on: '2024-01-01T00:00:00Z',
              updated_on: '2024-01-01T00:00:00Z',
            },
          },
        });

        await scopedClient.createTimeEntry({
          issue_id: 1,
          project_id: 'my-project',
          hours: 2,
        });

        // issue_id present -> project_id omitted from payload (Redmine derives it)
        const postPayload = mockAxiosInstance.post.mock.calls[0][1].time_entry;
        expect(postPayload.issue_id).toBe(1);
        expect(postPayload).not.toHaveProperty('project_id');
      });
    });

    // ─── updateTimeEntry() scoping ──────────────────────────────────────

    describe('updateTimeEntry() scoping', () => {
      it('should succeed when scoped and time entry belongs to scoped project', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/time_entries/10.json') {
            return Promise.resolve({
              data: {
                time_entry: { id: 10, project: { id: 42, name: 'My Project' }, hours: 2 },
              },
            });
          }
          if (url === '/projects/my-project.json') {
            return Promise.resolve({ data: { project: scopedProject } });
          }
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });
        mockAxiosInstance.put.mockResolvedValue({ data: {} });

        await scopedClient.updateTimeEntry(10, { hours: 3 });

        expect(mockAxiosInstance.put).toHaveBeenCalledWith(
          '/time_entries/10.json',
          expect.anything()
        );
      });

      it('should throw when scoped and time entry belongs to different project', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/time_entries/10.json') {
            return Promise.resolve({
              data: {
                time_entry: { id: 10, project: { id: 99, name: 'Other Project' }, hours: 2 },
              },
            });
          }
          if (url === '/projects/my-project.json') {
            return Promise.resolve({ data: { project: scopedProject } });
          }
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.updateTimeEntry(10, { hours: 3 })).rejects.toThrow(
          ProjectScopeError
        );
      });
    });

    // ─── listUsers() scoping ────────────────────────────────────────────

    describe('listUsers() scoping', () => {
      it('should use memberships endpoint with scope when scoped and no projectId', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: {
            memberships: [{ user: { id: 1, login: 'user1', firstname: 'U', lastname: 'One' } }],
          },
        });

        const result = await scopedClient.listUsers();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/projects/my-project/memberships.json');
        expect(result).toHaveLength(1);
      });

      it('should throw when scoped and projectId mismatches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);

        await expect(scopedClient.listUsers('other-project')).rejects.toThrow(ProjectScopeError);
      });

      it('should use /users.json when unscoped and no projectId', async () => {
        mockAxiosInstance.get.mockResolvedValue({
          data: { users: [] },
        });

        await client.listUsers();

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/users.json');
      });
    });

    // ─── createRelation() scoping ───────────────────────────────────────

    describe('createRelation() scoping', () => {
      it('should succeed when scoped and both issues are in scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        const inScopeIssue2 = { ...inScopeIssue, id: 3 };
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json') {
            return Promise.resolve({ data: { project: scopedProject } });
          }
          if (url === '/issues/1.json') {
            return Promise.resolve({ data: { issue: inScopeIssue } });
          }
          if (url === '/issues/3.json') {
            return Promise.resolve({ data: { issue: inScopeIssue2 } });
          }
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });
        mockAxiosInstance.post.mockResolvedValue({
          data: {
            relation: {
              id: 1,
              issue_id: 1,
              issue_to_id: 3,
              relation_type: 'relates',
            },
          },
        });

        const result = await scopedClient.createRelation({
          issue_id: 1,
          issue_to_id: 3,
        });

        expect(result.relation.issue_id).toBe(1);
        expect(result.relation.issue_to_id).toBe(3);
      });

      it('should throw when scoped and source issue is out of scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();

        await expect(scopedClient.createRelation({ issue_id: 2, issue_to_id: 1 })).rejects.toThrow(
          ProjectScopeError
        );
      });

      it('should throw when scoped and target issue is out of scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        setupScopedGetMock();

        await expect(scopedClient.createRelation({ issue_id: 1, issue_to_id: 2 })).rejects.toThrow(
          ProjectScopeError
        );
      });
    });

    // ─── deleteRelation() scoping ───────────────────────────────────────

    // ─── createIssue() scoping ──────────────────────────────────────────

    describe('createIssue() scoping', () => {
      it('should succeed when scoped and project_id matches', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        const createdIssue = { ...inScopeIssue, id: 10, subject: 'New issue' };
        mockAxiosInstance.post.mockResolvedValue({ data: { issue: createdIssue } });

        const result = await scopedClient.createIssue({
          project_id: 'my-project',
          subject: 'New issue',
        });
        expect(result.id).toBe(10);
      });

      it('should throw when scoped and project_id differs', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);

        await expect(
          scopedClient.createIssue({ project_id: 'other-project', subject: 'Test' })
        ).rejects.toThrow(ProjectScopeError);
        expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      });
    });

    // ─── commentIssue() scoping ──────────────────────────────────────────

    describe('commentIssue() scoping', () => {
      it('should succeed when scoped and issue is in scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/1.json') return Promise.resolve({ data: { issue: inScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });
        mockAxiosInstance.put.mockResolvedValue({ data: {} });

        await scopedClient.commentIssue(1, 'A comment');
        expect(mockAxiosInstance.put).toHaveBeenCalledWith('/issues/1.json', {
          issue: { notes: 'A comment' },
        });
      });

      it('should throw when scoped and issue is out of scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/2.json')
            return Promise.resolve({ data: { issue: outOfScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.commentIssue(2, 'A comment')).rejects.toThrow(ProjectScopeError);
        expect(mockAxiosInstance.put).not.toHaveBeenCalled();
      });
    });

    // ─── listJournals() transitive scoping ───────────────────────────────

    describe('listJournals() transitive scoping', () => {
      it('should throw when scoped and issue is out of scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/2.json')
            return Promise.resolve({
              data: { issue: { ...outOfScopeIssue, journals: [] } },
            });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.listJournals(2)).rejects.toThrow(ProjectScopeError);
      });
    });

    // ─── updateJournal()/deleteJournal() scoping ─────────────────────────

    describe('updateJournal()/deleteJournal() scoping', () => {
      it('should validate issue scope before updating journal', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/1.json') return Promise.resolve({ data: { issue: inScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });
        mockAxiosInstance.put.mockResolvedValue({ data: {} });

        await scopedClient.updateJournal(1, 5, 'Updated notes');
        expect(mockAxiosInstance.put).toHaveBeenCalledWith('/issues/1/journals/5.json', {
          journal: { notes: 'Updated notes' },
        });
      });

      it('should throw when issue is out of scope for updateJournal', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/2.json')
            return Promise.resolve({ data: { issue: outOfScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.updateJournal(2, 5, 'notes')).rejects.toThrow(ProjectScopeError);
        expect(mockAxiosInstance.put).not.toHaveBeenCalled();
      });

      it('should validate issue scope before deleting journal', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/1.json') return Promise.resolve({ data: { issue: inScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });
        mockAxiosInstance.delete.mockResolvedValue({ data: {} });

        await scopedClient.deleteJournal(1, 5);
        expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/issues/1/journals/5.json');
      });

      it('should throw when issue is out of scope for deleteJournal', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/2.json')
            return Promise.resolve({ data: { issue: outOfScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.deleteJournal(2, 5)).rejects.toThrow(ProjectScopeError);
        expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
      });

      it('should return 404 when journal belongs to different issue (Redmine server-side)', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/1.json') return Promise.resolve({ data: { issue: inScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });
        // Redmine returns 404 when journalId doesn't belong to issueId
        const notFoundError = Object.assign(new Error('Not Found'), {
          response: { status: 404 },
          isAxiosError: true,
        });
        mockAxiosInstance.put.mockRejectedValue(notFoundError);

        await expect(scopedClient.updateJournal(1, 999, 'notes')).rejects.toThrow();
      });
    });

    // ─── listRelations() scoping ─────────────────────────────────────────

    describe('listRelations() scoping', () => {
      it('should validate issue scope before listing relations', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/1.json') return Promise.resolve({ data: { issue: inScopeIssue } });
          if (url === '/issues/1/relations.json')
            return Promise.resolve({ data: { relations: [] } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        const result = await scopedClient.listRelations(1);
        expect(result.relations).toEqual([]);
      });

      it('should throw when issue is out of scope for listRelations', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/2.json')
            return Promise.resolve({ data: { issue: outOfScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.listRelations(2)).rejects.toThrow(ProjectScopeError);
      });
    });

    // ─── Additional listTimeEntries() scoping variants ───────────────────

    describe('listTimeEntries() additional scoping', () => {
      it('should succeed when scoped + matching project_id, no issue_id', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { time_entries: [], total_count: 0 },
        });

        await scopedClient.listTimeEntries({ project_id: 'my-project' });
        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/time_entries.json', {
          params: { limit: 25, project_id: 'my-project' },
        });
      });

      it('should validate both issue and project when both present', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/1.json') return Promise.resolve({ data: { issue: inScopeIssue } });
          if (url === '/time_entries.json')
            return Promise.resolve({ data: { time_entries: [], total_count: 0 } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await scopedClient.listTimeEntries({
          issue_id: 1,
          project_id: 'my-project',
        });
        // project_id NOT in params when issue_id is present
        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/time_entries.json', {
          params: { limit: 25, issue_id: 1 },
        });
      });
    });

    // ─── Additional createTimeEntry() scoping variants ───────────────────

    describe('createTimeEntry() additional scoping', () => {
      it('should throw when scoped + mismatching project_id, no issue_id', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);

        await expect(
          scopedClient.createTimeEntry({ project_id: 'other-project', hours: 2 })
        ).rejects.toThrow(ProjectScopeError);
        expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      });

      it('should throw when scoped + issue_id from wrong project', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json')
            return Promise.resolve({ data: { project: scopedProject } });
          if (url === '/issues/2.json')
            return Promise.resolve({ data: { issue: outOfScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.createTimeEntry({ issue_id: 2, hours: 2 })).rejects.toThrow(
          ProjectScopeError
        );
        expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      });

      it('should inject scope as project_id when scoped + matching project_id, no issue_id', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        const mockEntry = { id: 1, hours: 2, project: { id: 42, name: 'My Project' } };
        mockAxiosInstance.post.mockResolvedValue({ data: { time_entry: mockEntry } });

        await scopedClient.createTimeEntry({ project_id: 'my-project', hours: 2 });
        expect(mockAxiosInstance.post).toHaveBeenCalledWith('/time_entries.json', {
          time_entry: expect.objectContaining({ project_id: 'my-project', hours: 2 }),
        });
      });
    });

    // ─── updateTimeEntry() unscoped ──────────────────────────────────────

    describe('updateTimeEntry() unscoped', () => {
      it('should update without validation when unscoped', async () => {
        // client is unscoped (created in beforeEach without projectConfig)
        mockAxiosInstance.put.mockResolvedValue({ data: {} });

        await client.updateTimeEntry(1, { hours: 5 });
        expect(mockAxiosInstance.put).toHaveBeenCalledWith('/time_entries/1.json', {
          time_entry: { hours: 5 },
        });
        // No GET to /time_entries/1.json (no scope validation)
        expect(mockAxiosInstance.get).not.toHaveBeenCalled();
      });
    });

    // ─── listUsers() additional scoping ──────────────────────────────────

    describe('listUsers() additional scoping', () => {
      it('should succeed when scoped + explicit matching projectId', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockResolvedValue({
          data: { memberships: [{ user: { id: 1, login: 'user1' } }] },
        });

        await scopedClient.listUsers('my-project');
        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/projects/my-project/memberships.json');
      });
    });

    // ─── deleteRelation() unscoped ───────────────────────────────────────

    describe('deleteRelation() unscoped', () => {
      it('should delete without validation when unscoped', async () => {
        mockAxiosInstance.delete.mockResolvedValue({ data: {} });

        await client.deleteRelation(5);
        expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/relations/5.json');
        // No GET to /relations/5.json (no scope validation)
        expect(mockAxiosInstance.get).not.toHaveBeenCalled();
      });
    });

    // ─── _resolveProjectNumericId() concurrent deduplication ─────────────

    describe('_resolveProjectNumericId() concurrent deduplication', () => {
      it('should share the same promise for concurrent calls', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        let resolveProject: ((value: unknown) => void) | undefined;
        const projectPromise = new Promise((resolve) => {
          resolveProject = resolve;
        });

        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/projects/my-project.json') return projectPromise;
          if (url.startsWith('/issues/')) return Promise.resolve({ data: { issue: inScopeIssue } });
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        // Start two concurrent showIssue calls
        const p1 = scopedClient.showIssue(1);
        const p2 = scopedClient.showIssue(1);

        // Resolve the project fetch
        resolveProject!({ data: { project: scopedProject } });

        await Promise.all([p1, p2]);

        // Only ONE GET to /projects/my-project.json despite two concurrent calls
        const projectCalls = mockAxiosInstance.get.mock.calls.filter(
          (call: string[]) => call[0] === '/projects/my-project.json'
        );
        expect(projectCalls).toHaveLength(1);
      });
    });

    describe('deleteRelation() scoping', () => {
      it('should succeed when scoped and relation source issue is in scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/relations/5.json') {
            return Promise.resolve({
              data: {
                relation: {
                  id: 5,
                  issue_id: 1,
                  issue_to_id: 3,
                  relation_type: 'relates',
                },
              },
            });
          }
          if (url === '/projects/my-project.json') {
            return Promise.resolve({ data: { project: scopedProject } });
          }
          if (url === '/issues/1.json') {
            return Promise.resolve({ data: { issue: inScopeIssue } });
          }
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });
        mockAxiosInstance.delete.mockResolvedValue({ data: {} });

        await scopedClient.deleteRelation(5);

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/relations/5.json');
      });

      it('should throw when scoped and relation source issue is out of scope', async () => {
        const scopedClient = new RedmineClient(config, scopedProjectConfig);
        mockAxiosInstance.get.mockImplementation((url: string) => {
          if (url === '/relations/5.json') {
            return Promise.resolve({
              data: {
                relation: {
                  id: 5,
                  issue_id: 2,
                  issue_to_id: 3,
                  relation_type: 'relates',
                },
              },
            });
          }
          if (url === '/projects/my-project.json') {
            return Promise.resolve({ data: { project: scopedProject } });
          }
          if (url === '/issues/2.json') {
            return Promise.resolve({ data: { issue: outOfScopeIssue } });
          }
          return Promise.reject(new Error(`Unexpected GET ${url}`));
        });

        await expect(scopedClient.deleteRelation(5)).rejects.toThrow(ProjectScopeError);
      });
    });
  });
});

//═══════════════════════════════════════════════════════════════════════════════
// Client Factory Tests
//═══════════════════════════════════════════════════════════════════════════════

describe('initializeRedmineClient', () => {
  let mockAxiosInstance: any;

  beforeEach(() => {
    mockAxiosInstance = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: {
        response: {
          use: vi.fn(),
        },
      },
    };

    mockedAxios.create = vi.fn().mockReturnValue(mockAxiosInstance);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should initialize client with config.json from /tokens/', async () => {
    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return 'valid-api-key-123';
      }
      if (path.includes('config.json')) {
        return JSON.stringify({
          host_url: 'https://redmine.example.com',
          project_id: 'test-project',
          project_name: 'Test Project',
          mappings: {
            status_new: 1,
          },
        });
      }
      throw new Error('File not found');
    });

    const client = await initializeRedmineClient();

    expect(client).not.toBeNull();
    expect(mockedFs.readFile).toHaveBeenCalledWith(expect.stringContaining('api_key'), 'utf-8');
    expect(mockedFs.readFile).toHaveBeenCalledWith(expect.stringContaining('config.json'), 'utf-8');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('✅ Redmine: API key loaded'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('URL configured'));
  });

  it('should load mappings from config.json', async () => {
    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return 'valid-api-key-123';
      }
      if (path.includes('config.json')) {
        return JSON.stringify({
          host_url: 'https://redmine.example.com',
          mappings: {
            priority_high: 3,
          },
        });
      }
      throw new Error('File not found');
    });

    const client = await initializeRedmineClient();

    expect(client).not.toBeNull();
    expect(client?.getMappings()).toEqual({ priority_high: 3 });
  });

  it('should fall back to REDMINE_URL env var when config.json missing', async () => {
    process.env.REDMINE_URL = 'https://redmine-env.example.com';

    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return 'valid-api-key-123';
      }
      throw new Error('ENOENT');
    });

    const client = await initializeRedmineClient();

    expect(client).not.toBeNull();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('REDMINE_URL env'));

    delete process.env.REDMINE_URL;
  });

  it('should return null when API key is empty', async () => {
    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return '   \n  '; // Empty after trim
      }
      throw new Error('Should not reach here');
    });

    const result = await initializeRedmineClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('should return null when API key file is missing', async () => {
    mockedFs.readFile.mockRejectedValue(new Error('ENOENT: file not found'));

    const result = await initializeRedmineClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('should return null when no Redmine URL available', async () => {
    delete process.env.REDMINE_URL;

    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return 'valid-api-key-123';
      }
      throw new Error('ENOENT');
    });

    const result = await initializeRedmineClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No Redmine URL found'));
  });

  it('should return null when config.json has no host_url and no env var', async () => {
    delete process.env.REDMINE_URL;

    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return 'valid-api-key-123';
      }
      if (path.includes('config.json')) {
        return JSON.stringify({
          project_id: 'test',
        });
      }
      throw new Error('File not found');
    });

    const result = await initializeRedmineClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('should handle invalid JSON in config.json gracefully', async () => {
    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return 'valid-api-key-123';
      }
      if (path.includes('config.json')) {
        return 'invalid json {';
      }
      throw new Error('File not found');
    });

    // config.json parse error returns null config, then no URL => null
    const result = await initializeRedmineClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('should read from tokens directory for api_key and config', async () => {
    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return 'test-api-key';
      }
      if (path.includes('config.json')) {
        return JSON.stringify({
          host_url: 'https://redmine.example.com',
        });
      }
      throw new Error('File not found');
    });

    const client = await initializeRedmineClient();

    expect(client).not.toBeNull();
    expect(mockedFs.readFile).toHaveBeenCalledWith(expect.stringContaining('api_key'), 'utf-8');
    expect(mockedFs.readFile).toHaveBeenCalledWith(expect.stringContaining('config.json'), 'utf-8');
  });

  it('should initialize with empty mappings when not provided in config', async () => {
    mockedFs.readFile.mockImplementation(async (path: any) => {
      if (path.includes('api_key')) {
        return 'valid-api-key-123';
      }
      if (path.includes('config.json')) {
        return JSON.stringify({
          host_url: 'https://redmine.example.com',
        });
      }
      throw new Error('File not found');
    });

    const client = await initializeRedmineClient();

    expect(client).not.toBeNull();
    expect(client?.getMappings()).toEqual({});
  });

  //═══════════════════════════════════════════════════════════════════════════════
  // Eager project_name fetch
  //═══════════════════════════════════════════════════════════════════════════════

  describe('eager project_name fetch', () => {
    it('should fetch project_name when project_id is set but project_name is absent', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: 'my-project',
          });
        }
        throw new Error('File not found');
      });

      mockAxiosInstance.get.mockResolvedValue({
        data: { project: { id: 42, name: 'My Project', identifier: 'my-project' } },
      });

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/projects/my-project.json', {
        params: {},
      });
      expect(client?.getConfig().project_name).toBe('My Project');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('project name fetched: "My Project"')
      );
    });

    it('should use existing project_name when both project_id and project_name are present', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: 'my-project',
            project_name: 'Existing Name',
          });
        }
        throw new Error('File not found');
      });

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
      expect(client?.getConfig().project_name).toBe('Existing Name');
    });

    it('should handle network error from showProject gracefully', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: 'my-project',
          });
        }
        throw new Error('File not found');
      });

      mockAxiosInstance.get.mockRejectedValue(new Error('Network error'));

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(client?.getConfig().project_name).toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not fetch project name')
      );
    });

    it('should handle 404 from showProject gracefully', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: 'nonexistent-project',
          });
        }
        throw new Error('File not found');
      });

      const axiosError = new AxiosError('Not Found', '404', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        headers: {},
        config: {} as any,
        data: {},
      });
      mockAxiosInstance.get.mockRejectedValue(axiosError);

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(client?.getConfig().project_name).toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not fetch project name')
      );
    });

    it('should handle non-Error thrown by showProject gracefully', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: 'my-project',
          });
        }
        throw new Error('File not found');
      });

      mockAxiosInstance.get.mockRejectedValue('string error');

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(client?.getConfig().project_name).toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('string error'));
    });

    it('should not fetch when project_id is absent and project_name is absent', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
          });
        }
        throw new Error('File not found');
      });

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
      expect(client?.getConfig().project_name).toBeUndefined();
    });

    it('should not fetch when project_id is empty string', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: '',
          });
        }
        throw new Error('File not found');
      });

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('should not fetch when project_id is null', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: null,
          });
        }
        throw new Error('File not found');
      });

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('should fetch when project_id is "0" (valid slug, falsy in JS)', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: '0',
          });
        }
        throw new Error('File not found');
      });

      mockAxiosInstance.get.mockResolvedValue({
        data: { project: { id: 0, name: 'Zero Project', identifier: '0' } },
      });

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/projects/0.json', { params: {} });
      expect(client?.getConfig().project_name).toBe('Zero Project');
    });

    it('should pass project_id with special characters to showProject as-is', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: 'proj/with&special chars',
          });
        }
        throw new Error('File not found');
      });

      mockAxiosInstance.get.mockResolvedValue({
        data: {
          project: {
            id: 99,
            name: 'Special Project',
            identifier: 'proj/with&special chars',
          },
        },
      });

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/projects/proj/with&special chars.json', {
        params: {},
      });
      expect(client?.getConfig().project_name).toBe('Special Project');
    });

    it('should pass project_id with Unicode to showProject as-is', async () => {
      mockedFs.readFile.mockImplementation(async (path: any) => {
        if (path.includes('api_key')) {
          return 'valid-api-key-123';
        }
        if (path.includes('config.json')) {
          return JSON.stringify({
            host_url: 'https://redmine.example.com',
            project_id: 'проект-юникод',
          });
        }
        throw new Error('File not found');
      });

      mockAxiosInstance.get.mockResolvedValue({
        data: {
          project: { id: 100, name: 'Unicode Project', identifier: 'проект-юникод' },
        },
      });

      const client = await initializeRedmineClient();

      expect(client).not.toBeNull();
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/projects/проект-юникод.json', {
        params: {},
      });
      expect(client?.getConfig().project_name).toBe('Unicode Project');
    });
  });
});
