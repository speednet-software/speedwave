/**
 * SSOT coupling helper for the CloudStorage TCC prefix; must match
 * `consts.rs::CLOUDSTORAGE_TCC_PREFIX` (see `cloudstorage_tcc_prefix_matches_rust_constant`).
 */
export const CLOUDSTORAGE_TCC_PREFIX = 'CloudStorage TCC required: ';

/**
 * Maps a CloudStorage stable identifier to its display name; SSOT coupling — must stay in
 * sync with `CloudStorageProvider::display_name`/`stable_id` in `cloudstorage.rs`.
 * @param stableId - Lowercase identifier embedded in the TCC prefix (e.g. `"one_drive"`).
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
