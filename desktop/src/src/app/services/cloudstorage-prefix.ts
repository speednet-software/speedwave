/**
 * SSOT coupling helper for the CloudStorage TCC prefix string.
 *
 * Must stay in sync with `crates/speedwave-runtime/src/consts.rs::CLOUDSTORAGE_TCC_PREFIX`.
 * Asserted by `cloudstorage_tcc_prefix_matches_rust_constant` in the Angular test suite.
 */
export const CLOUDSTORAGE_TCC_PREFIX = 'CloudStorage TCC required: ';

/**
 * Maps a CloudStorage stable identifier to its display name.
 * SSOT coupling — must stay in sync with `CloudStorageProvider::display_name`
 * and `CloudStorageProvider::stable_id` in `crates/speedwave-runtime/src/cloudstorage.rs`.
 * @param stableId - lowercase identifier embedded in the TCC prefix (e.g. `"one_drive"`)
 * @returns the human-readable provider name, or `undefined` for unknown ids
 */
export function cloudstorageProviderDisplayName(stableId: string): string | undefined {
  switch (stableId) {
    case 'one_drive':
      return 'OneDrive';
    case 'dropbox':
      return 'Dropbox';
    case 'google_drive':
      return 'Google Drive';
    default:
      return undefined;
  }
}
