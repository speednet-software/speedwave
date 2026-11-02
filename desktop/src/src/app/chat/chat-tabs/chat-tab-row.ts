import type { ChatSessionEventKind } from '../../models/notifications';
import { blocksToPlainText, type ChatSessionStore } from '../../services/chat-session-store';

const TITLE_MAX_CHARS = 24;

const UNSEEN_LABELS: Readonly<Record<ChatSessionEventKind, string>> = {
  turn_finished: 'Finished',
  awaiting_input: 'Waiting for your answer',
  session_error: 'Error',
};

/** What a chat tab shows, in the tab strip and in the Ctrl+Tab switcher. */
export interface ChatTabRow {
  readonly id: string;
  readonly title: string;
  readonly fullTitle: string;
  readonly streaming: boolean;
  readonly ended: boolean;
  readonly unseen: ChatSessionEventKind | null;
  readonly active: boolean;
  readonly tooltip: string | null;
  readonly ariaLabel: string;
}

/**
 * Builds what a tab shows from its store.
 * @param id - The tab's id.
 * @param store - The tab's session store.
 * @param active - Whether it is the active tab.
 * @returns The tab's row.
 */
export function chatTabRow(id: string, store: ChatSessionStore, active: boolean): ChatTabRow {
  const fullTitle = tabTitle(store).trim();
  const title = truncateTitle(fullTitle);
  const unseen = store.unseenEvent();
  const streaming = store.isStreamingFromState() && unseen !== 'awaiting_input';
  const ended = store.sessionEnded();
  return {
    id,
    title,
    fullTitle,
    streaming,
    ended,
    unseen,
    active,
    tooltip: tabTooltip(fullTitle, title, unseen),
    ariaLabel: tabAriaLabel(title, streaming, ended, unseen),
  };
}

function tabTitle(store: ChatSessionStore): string {
  const title = store.title();
  if (title) return title;
  const firstUser = store.messagesFromState().find((m) => m.role === 'user');
  if (!firstUser) return 'New chat';
  const text = blocksToPlainText(firstUser.blocks);
  return text ? text : 'New chat';
}

function truncateTitle(text: string): string {
  const points = Array.from(text);
  if (points.length <= TITLE_MAX_CHARS) return text;
  return `${points.slice(0, TITLE_MAX_CHARS).join('').trimEnd()}…`;
}

function tabTooltip(
  fullTitle: string,
  title: string,
  unseen: ChatSessionEventKind | null
): string | null {
  const truncated = fullTitle !== title ? fullTitle : null;
  if (unseen && truncated) return `${UNSEEN_LABELS[unseen]}: ${truncated}`;
  if (unseen) return UNSEEN_LABELS[unseen];
  return truncated;
}

function tabAriaLabel(
  title: string,
  streaming: boolean,
  ended: boolean,
  unseen: ChatSessionEventKind | null
): string {
  const states = [
    unseen ? UNSEEN_LABELS[unseen].toLowerCase() : '',
    ended ? 'session ended' : streaming ? 'streaming' : '',
  ].filter((state) => state !== '');
  return `Switch to tab: ${[title, ...states].join(', ')}`;
}
