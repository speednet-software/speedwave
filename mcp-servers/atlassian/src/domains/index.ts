/**
 * Domain client exports for the Atlassian worker.
 *
 * Each factory takes the shared {@link AtlassianClient} and returns a small
 * interface of normalised operations; tool modules in `../tools/` compose them.
 * @module mcp-atlassian/domains
 */

export { createJiraIssuesClient, type JiraIssuesClient } from './jira-issues.js';
export { createJiraCommentsClient, type JiraCommentsClient } from './jira-comments.js';
export { createJiraProjectsClient, type JiraProjectsClient } from './jira-projects.js';
export { createJiraAgileClient, type JiraAgileClient } from './jira-agile.js';
export { createConfluencePagesClient, type ConfluencePagesClient } from './confluence-pages.js';
export { createConfluenceSpacesClient, type ConfluenceSpacesClient } from './confluence-spaces.js';
export {
  createConfluenceContentClient,
  type ConfluenceContentClient,
} from './confluence-content.js';
