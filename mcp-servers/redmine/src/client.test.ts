/**
 * Comprehensive tests for Redmine API Client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError } from 'axios';
import { RedmineClient, initializeRedmineClient } from './client.js';
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

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/time_entries.json', {
        params: {
          limit: 50,
          issue_id: 123,
          project_id: 'test-project',
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

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/time_entries.json', {
        time_entry: {
          issue_id: 123,
          project_id: 'test-project',
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
      expect(result).toContain('speedwave setup redmine');
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
});
