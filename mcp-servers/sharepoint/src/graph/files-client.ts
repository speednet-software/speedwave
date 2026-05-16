/**
 * File-domain Graph operations — current home: `SharePointClient` methods.
 *
 * The plan that introduced this directory (PR4) split the SharePoint Graph
 * surface into one module per resource family: pages, lists, columns, files.
 * Page / list / column URL building moved into their respective siblings
 * here. File operations stayed on `SharePointClient` because they are tightly
 * coupled to the OAuth-refresh / mutex / retry machinery (`callGraphAPI`)
 * that the facade owns, and untangling them is a non-trivial refactor that
 * delivers no behavioural change.
 *
 * Methods that currently live on `SharePointClient`:
 *   - `listFiles`           — paginated drive enumeration
 *   - `getFileMetadata`     — by file id
 *   - `uploadFile`          — with CAS overwrite semantics
 *   - `downloadFile`        — streaming
 *   - `createRemoteFolder`  — idempotent (409-tolerant)
 *   - `ensureParentFolders` — recursive folder provisioning
 *   - `getCurrentUser`      — `/me` for diagnostics
 *
 * When the next change touches the file path, move it onto a `FilesClient`
 * class here using the same `GraphRequester` pattern as `pages-client.ts` /
 * `lists-client.ts`. Until then, this module is the documented contract
 * surface for "files" so the {@link ./site-client.ts} → domain-clients
 * topology is complete and a future contributor knows where to land the
 * extracted logic.
 */

// Re-export the shared interface so callers can refer to a single import
// surface (`graph/files-client.js`) for files-related types in the future.
export type { GraphRequester } from './site-client.js';
