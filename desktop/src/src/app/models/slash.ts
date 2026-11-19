/** Classification of a slash-menu entry, used by the UI to render the badge. */
export type SlashKind = 'Builtin' | 'Skill' | 'Command' | 'Plugin' | 'Agent';

/** One entry in the slash popover, mirrored from Rust `SlashCommand`. */
export interface SlashCommand {
  readonly name: string;
  readonly description: string | null;
  readonly argument_hint: string | null;
  readonly kind: SlashKind;
  readonly plugin: string | null;
}
