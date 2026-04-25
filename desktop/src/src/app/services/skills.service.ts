import { Injectable, signal } from '@angular/core';

/** Where a slash command/skill originated. */
export type SkillSource = 'built-in' | 'skill' | 'cmd' | 'agent' | 'plugin' | 'fallback';

/** Kind of slash entry (matches the backend SlashKind when available). */
export type SkillKind = 'builtin' | 'skill' | 'command' | 'plugin' | 'agent';

/** A single discovered slash command, skill, or agent entry. */
export interface Skill {
  /** Stable identifier — slug form, e.g. `help`, `review`, `code-review-pack:kiss-check`. */
  readonly id: string;
  /** Display name — may include a plugin prefix for plugin-injected skills. */
  readonly name: string;
  /** Source badge shown in the UI. */
  readonly source: SkillSource;
  /** Kind hint used for grouping and badge colors. */
  readonly kind: SkillKind;
  /** One-line human description, or empty string when no frontmatter was available. */
  readonly description: string;
  /** Optional argument hint, e.g. `<name>` for `/model`. */
  readonly argumentHint: string | null;
  /** Plugin slug if this skill was injected by a plugin. */
  readonly plugin: string | null;
}

/**
 * Minimum set of built-ins to show when backend discovery is unavailable.
 * Mirrors Feature 1 fallback in the terminal-minimal implementation prompt so
 * the UI always has something to render before the real discovery lands.
 */
const HARDCODED_FALLBACK: readonly Skill[] = [
  {
    id: 'help',
    name: 'help',
    source: 'built-in',
    kind: 'builtin',
    description: 'Show available commands and keyboard shortcuts.',
    argumentHint: null,
    plugin: null,
  },
  {
    id: 'clear',
    name: 'clear',
    source: 'built-in',
    kind: 'builtin',
    description: 'Clear the current conversation.',
    argumentHint: null,
    plugin: null,
  },
  {
    id: 'compact',
    name: 'compact',
    source: 'built-in',
    kind: 'builtin',
    description: 'Summarize and compact conversation history.',
    argumentHint: null,
    plugin: null,
  },
  {
    id: 'resume',
    name: 'resume',
    source: 'built-in',
    kind: 'builtin',
    description: 'Resume a previous conversation.',
    argumentHint: null,
    plugin: null,
  },
  {
    id: 'cost',
    name: 'cost',
    source: 'built-in',
    kind: 'builtin',
    description: 'Show token usage and session cost.',
    argumentHint: null,
    plugin: null,
  },
  {
    id: 'context',
    name: 'context',
    source: 'built-in',
    kind: 'builtin',
    description: 'Inspect the current conversation context.',
    argumentHint: null,
    plugin: null,
  },
  {
    id: 'memory',
    name: 'memory',
    source: 'built-in',
    kind: 'builtin',
    description: 'Open the project memory panel.',
    argumentHint: null,
    plugin: null,
  },
];

/**
 * Catalog of slash commands, skills, and agents available to the current project.
 *
 * Until Feature 1 / Unit 13 lands the slash-discovery backend, this service
 * returns a hardcoded fallback list. When the real `list_slash_commands`
 * Tauri command ships, the body of `refresh()` can be swapped for a live call
 * without any consumer change.
 */
@Injectable({ providedIn: 'root' })
export class SkillsService {
  private readonly _discovered = signal<readonly Skill[]>([]);

  /** Skills/commands currently known. Empty until `refresh()` is called. */
  readonly discovered = this._discovered.asReadonly();

  /**
   * Fetches the latest catalog. The current implementation returns the
   * hardcoded fallback; Unit 13 will replace the body with the real
   * `list_slash_commands` Tauri call without changing the public shape.
   */
  async refresh(): Promise<readonly Skill[]> {
    this._discovered.set(HARDCODED_FALLBACK);
    return HARDCODED_FALLBACK;
  }
}
