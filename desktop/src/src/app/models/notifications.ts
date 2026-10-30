/** Event the backend emits when the user clicks a notification; mirrors Rust `notifications::ACTIVATED_EVENT`. */
export const NOTIFICATION_ACTIVATED_EVENT = 'notification_activated';

/** Event the backend emits for every chat-session event; mirrors Rust `notifications::SESSION_EVENT`. */
export const CHAT_SESSION_EVENT = 'chat_session_event';

/** What happened in a chat session; mirrors Rust `notifications::SessionEvent`. */
export type ChatSessionEventKind = 'turn_finished' | 'awaiting_input' | 'session_error';

/** Whether the OS lets Speedwave show notifications; mirrors Rust `NotificationPermission`. */
export type NotificationPermission =
  'granted' | 'undetermined' | 'denied' | 'suppressed' | 'unavailable';

/** Notification switches; mirrors Rust `config::NotificationPrefs`. */
export interface NotificationPrefs {
  enabled: boolean;
  turn_finished: boolean;
  awaiting_input: boolean;
  session_error: boolean;
}

/** Switches plus OS permission; mirrors Rust `notifications::NotificationSettings`. */
export interface NotificationSettings {
  prefs: NotificationPrefs;
  permission: NotificationPermission;
}

/** The tab a clicked notification belongs to; mirrors Rust `notifications::NotificationTarget`. */
export interface NotificationTarget {
  project: string;
  tab_id: string;
}

/** A session event of one tab; mirrors Rust `notifications::SessionEventNotice`. */
export interface ChatSessionEvent {
  project: string;
  tab_id: string;
  kind: ChatSessionEventKind;
}
