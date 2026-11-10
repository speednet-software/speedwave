/** Id of the Settings section with the project read-only switch, the target of links to it. */
export const READ_ONLY_SECTION_ID = 'section-access';

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
