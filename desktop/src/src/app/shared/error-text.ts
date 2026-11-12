/**
 * Message of a thrown value.
 * @param e - Thrown value.
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
