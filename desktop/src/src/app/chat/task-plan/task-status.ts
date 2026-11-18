/**
 * Glyph for a task's status.
 * @param status - The task's status string (e.g. "completed", "in_progress").
 */
export function taskStatusGlyph(status: string): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '▸';
    case 'cancelled':
      return '⊘';
    default:
      return '○';
  }
}

/**
 * Tailwind color class for a task keyed by status.
 * @param status - The task's status string.
 */
export function taskStatusColor(status: string): string {
  switch (status) {
    case 'completed':
      return 'text-[var(--green)]';
    case 'in_progress':
      return 'text-[var(--accent)]';
    case 'cancelled':
      return 'text-[var(--ink-mute)] line-through';
    default:
      return 'text-[var(--ink-mute)]';
  }
}
