/**
 \* GitLab Releases Domain - Handles tag and release operations
 * @module domains/releases
 */

import { Gitlab } from '@gitbeaker/rest';

/**
 * Client interface for GitLab tag and release operations.
 * Provides methods to create tags and releases.
 * @interface ReleasesClient
 */
export interface ReleasesClient {
  /**
   * Creates a new Git tag in the repository.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} options - Tag creation options
   * @param {string} options.tag_name - Name for the new tag
   * @param {string} options.ref - Branch name or commit SHA to tag
   * @param {string} [options.message] - Optional tag message/annotation
   * @returns {Promise<unknown>} Created tag object
   */
  createTag(
    projectId: string | number,
    options: {
      tag_name: string;
      ref: string;
      message?: string;
    }
  ): Promise<unknown>;

  /**
   * Creates a new release from an existing tag.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} options - Release creation options
   * @param {string} options.tag_name - Tag name (must already exist)
   * @param {string} [options.name] - Release name (defaults to tag name)
   * @param {string} [options.description] - Release notes/description (markdown supported)
   * @returns {Promise<unknown>} Created release object
   */
  createRelease(
    projectId: string | number,
    options: {
      tag_name: string;
      name?: string;
      description?: string;
    }
  ): Promise<unknown>;
}

/**
 * Creates a releases client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {ReleasesClient} Configured releases client
 */
export function createReleasesClient(gitlab: InstanceType<typeof Gitlab>): ReleasesClient {
  return {
    async createTag(projectId, options) {
      return await gitlab.Tags.create(projectId, options.tag_name, options.ref, {
        message: options.message,
      });
    },

    async createRelease(projectId, options) {
      return await gitlab.ProjectReleases.create(projectId, {
        tagName: options.tag_name,
        name: options.name || options.tag_name,
        description: options.description,
      });
    },
  };
}
