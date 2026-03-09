/**
 \* GitLab Labels Domain - Handles label operations including listing and creation
 * @module domains/labels
 */

import { Gitlab } from '@gitbeaker/rest';
import type { GitLabLabel } from '../types.js';

/**
 * Client interface for GitLab label operations.
 * Provides methods to manage project labels.
 * @interface LabelsClient
 */
export interface LabelsClient {
  /**
   * Lists all labels in a project.
   * @param {string | number} projectId - Project ID or path
   * @returns {Promise<GitLabLabel[]>} Array of labels
   */
  list(projectId: string | number): Promise<GitLabLabel[]>;

  /**
   * Creates a new label in a project.
   * @param {string | number} projectId - Project ID or path
   * @param {string} name - Label name
   * @param {string} color - Label color in hex format (e.g., #FF0000)
   * @param {string} [description] - Optional label description
   * @returns {Promise<GitLabLabel>} Created label
   */
  create(
    projectId: string | number,
    name: string,
    color: string,
    description?: string
  ): Promise<GitLabLabel>;
}

/**
 * Creates a labels client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {LabelsClient} Configured labels client
 */
export function createLabelsClient(gitlab: InstanceType<typeof Gitlab>): LabelsClient {
  return {
    async list(projectId) {
      const labels = (await gitlab.ProjectLabels.all(projectId)) as unknown as Array<
        Record<string, unknown>
      >;
      return labels.map(mapLabel);
    },

    async create(projectId, name, color, description) {
      const label = await gitlab.ProjectLabels.create(projectId, name, color, {
        description,
      });
      return mapLabel(label);
    },
  };
}

/**
 * Maps GitLab API response to standardized GitLabLabel type.
 * Handles both camelCase and snake_case field names from API.
 * @param {unknown} l - Raw label object from GitLab API
 * @returns {GitLabLabel} Normalized label object
 */
function mapLabel(l: unknown): GitLabLabel {
  const label = l as Record<string, unknown>;

  return {
    id: Number(label.id),
    name: String(label.name || ''),
    color: String(label.color || ''),
    description: label.description ? String(label.description) : undefined,
    text_color:
      label.textColor || label.text_color ? String(label.textColor || label.text_color) : undefined,
  };
}
