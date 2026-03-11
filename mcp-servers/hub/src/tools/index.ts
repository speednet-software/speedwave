/**
 * Tools Index
 * @module tools
 *
 * Central export for all service tool metadata.
 * Used by search_tools handler for progressive discovery.
 *
 * Tool counts are dynamically computed from toolMetadata exports.
 * See each service's index.ts for the source of truth.
 */

import { toolMetadata as slackTools } from './slack/index.js';
import { toolMetadata as sharepointTools } from './sharepoint/index.js';
import { toolMetadata as redmineTools } from './redmine/index.js';
import { toolMetadata as gitlabTools } from './gitlab/index.js';

export * as slack from './slack/index.js';
export * as sharepoint from './sharepoint/index.js';
export * as redmine from './redmine/index.js';
export * as gitlab from './gitlab/index.js';

/**
 * Service metadata including tool count and description
 */
interface ServiceMetadata {
  /** Number of tools provided by this service */
  count: number;
  /** Human-readable description of the service */
  description: string;
}

/**
 * All services with their tool counts and descriptions
 * Counts are dynamically computed from toolMetadata exports
 */
export const services: Record<string, ServiceMetadata> = {
  slack: {
    count: Object.keys(slackTools).length,
    description: 'Slack messaging and channel management',
  },
  sharepoint: {
    count: Object.keys(sharepointTools).length,
    description: 'SharePoint file sync and management',
  },
  redmine: {
    count: Object.keys(redmineTools).length,
    description: 'Redmine issue tracking, time management, and projects',
  },
  gitlab: {
    count: Object.keys(gitlabTools).length,
    description: 'GitLab repository, MR, and CI/CD management',
  },
} as const;

/**
 * Type representing a valid service name
 * Union type of all available service names
 */
export type ServiceName = keyof typeof services;

/**
 * Total tool count across all services
 * Computed by summing the count property from all services
 */
export const totalToolCount = Object.values(services).reduce((sum, s) => sum + s.count, 0);
