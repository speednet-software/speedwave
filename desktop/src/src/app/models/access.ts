/** Read-only settings of a project and its integrations. */
export interface AccessSettingsView {
  read_only: boolean;
  read_only_locked: boolean;
}

/** Access mode of an integration. */
export type AccessMode = 'full' | 'read_only';

/** Access of one integration. */
export interface IntegrationAccessView {
  mode: AccessMode;
  global_read_only: boolean;
  global_locked: boolean;
}
