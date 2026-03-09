/**
 * Domain Exports
 *
 * Re-exports all domain clients and their interfaces
 */

export { createProjectsClient, type ProjectsClient } from './projects.js';
export { createMergeRequestsClient, type MergeRequestsClient } from './merge-requests.js';
export { createCommitsClient, type CommitsClient } from './commits.js';
export { createPipelinesClient, type PipelinesClient } from './pipelines.js';
export { createReleasesClient, type ReleasesClient } from './releases.js';
export { createIssuesClient, type IssuesClient } from './issues.js';
export { createLabelsClient, type LabelsClient } from './labels.js';
export { createBranchesClient, type BranchesClient } from './branches.js';
export { createRepositoryClient, type RepositoryClient } from './repository.js';
export { createArtifactsClient, type ArtifactsClient } from './artifacts.js';
