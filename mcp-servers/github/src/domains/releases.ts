/**
 * GitHub Releases Domain - Handles tag refs (lightweight and annotated) and
 * release creation.
 * @module domains/releases
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubRelease } from '../types.js';

/**
 * Client interface for GitHub tag and release operations.
 * @interface ReleasesClient
 */
export interface ReleasesClient {
  /**
   * Creates a lightweight tag ref pointing directly at a commit.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} tag - Tag name (e.g. "v1.0.0")
   * @param {string} sha - Commit SHA the tag should point at
   * @returns {Promise<{ ref: string; sha: string }>} Created ref name and target SHA
   */
  createTagRef(
    owner: string,
    repo: string,
    tag: string,
    sha: string
  ): Promise<{ ref: string; sha: string }>;

  /**
   * Creates an annotated tag object and a ref pointing at it.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} params - Annotated tag parameters
   * @param {string} params.tag - Tag name (e.g. "v1.0.0")
   * @param {string} params.sha - Commit SHA the tag should point at
   * @param {string} params.message - Tag annotation message
   * @returns {Promise<{ tag: string; sha: string }>} Tag name and the annotated tag object SHA
   */
  createAnnotatedTag(
    owner: string,
    repo: string,
    params: { tag: string; sha: string; message: string }
  ): Promise<{ tag: string; sha: string }>;

  /**
   * Deletes a tag ref.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {string} tag - Tag name to delete
   * @returns {Promise<void>}
   */
  deleteTagRef(owner: string, repo: string, tag: string): Promise<void>;

  /**
   * Creates a release associated with a tag.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} params - Release creation parameters
   * @param {string} params.tag_name - Tag name for the release (e.g. "v1.0.0")
   * @param {string} [params.name] - Optional release name (defaults to the tag name)
   * @param {string} [params.body] - Optional release notes (Markdown)
   * @param {boolean} [params.draft] - Whether to create the release as a draft
   * @param {boolean} [params.prerelease] - Whether to mark the release as a pre-release
   * @param {string} [params.target_commitish] - Commitish the tag should point at if it does not exist yet
   * @returns {Promise<GitHubRelease>} Created release
   */
  create(
    owner: string,
    repo: string,
    params: {
      tag_name: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      target_commitish?: string;
    }
  ): Promise<GitHubRelease>;
}

/**
 * Creates a releases client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {ReleasesClient} Configured releases client
 */
export function createReleasesClient(octokit: Octokit): ReleasesClient {
  return {
    async createTagRef(owner, repo, tag, sha) {
      const { data } = await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tag}`,
        sha,
      });
      const o = data as Record<string, unknown>;
      const object = (o.object || {}) as Record<string, unknown>;
      return { ref: String(o.ref || ''), sha: String(object.sha || '') };
    },

    async createAnnotatedTag(owner, repo, params) {
      const { data: tagData } = await octokit.rest.git.createTag({
        owner,
        repo,
        tag: params.tag,
        message: params.message,
        object: params.sha,
        type: 'commit',
      });
      const tagSha = String((tagData as Record<string, unknown>).sha || params.sha);
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${params.tag}`,
        sha: tagSha,
      });
      return { tag: params.tag, sha: tagSha };
    },

    async deleteTagRef(owner, repo, tag) {
      await octokit.rest.git.deleteRef({ owner, repo, ref: `tags/${tag}` });
    },

    async create(owner, repo, params) {
      const { data } = await octokit.rest.repos.createRelease({
        owner,
        repo,
        tag_name: params.tag_name,
        name: params.name || params.tag_name,
        body: params.body,
        draft: params.draft,
        prerelease: params.prerelease,
        target_commitish: params.target_commitish,
      });
      return mapRelease(data as Record<string, unknown>);
    },
  };
}

/**
 * Normalizes a raw GitHub release object to the {@link GitHubRelease} shape.
 * @param {unknown} r - Raw release object from the GitHub API
 * @returns {GitHubRelease} Normalized release
 */
function mapRelease(r: unknown): GitHubRelease {
  const o = r as Record<string, unknown>;
  return {
    id: Number(o.id),
    tag_name: String(o.tag_name || ''),
    name: o.name ? String(o.name) : undefined,
    body: o.body ? String(o.body) : undefined,
    draft: Boolean(o.draft),
    prerelease: Boolean(o.prerelease),
    html_url: String(o.html_url || ''),
    created_at: String(o.created_at || ''),
  };
}
