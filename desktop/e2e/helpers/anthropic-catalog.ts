export interface AnthropicCatalogEntry {
  id: string;
  family: string;
  context_tokens: number;
  latest: boolean;
  premium: boolean;
  effort_levels: string[];
  default_effort: string | null;
}

export async function anthropicCatalog(): Promise<AnthropicCatalogEntry[]> {
  return browser.executeAsync((done: (rows: AnthropicCatalogEntry[]) => void) => {
    (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<AnthropicCatalogEntry[]> };
      }
    ).__TAURI_INTERNALS__
      .invoke('list_anthropic_models')
      .then((rows) => done(rows))
      .catch(() => done([]));
  });
}

export async function latestAnthropicModelIds(): Promise<string[]> {
  const rows = await anthropicCatalog();
  return rows.filter((r) => r.latest).map((r) => r.id);
}

export async function modelPickerRowIds(project: string): Promise<string[] | null> {
  return browser.executeAsync((proj: string, done: (ids: string[] | null) => void) => {
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: unknown) => Promise<{ rows: { id: string }[] } | null>;
        };
      }
    ).__TAURI_INTERNALS__
      .invoke('list_model_picker', { project: proj })
      .then((picker) => done(picker ? picker.rows.map((r) => r.id) : null))
      .catch(() => done(null));
  }, project);
}

export function catalogEntryForBadgeLabel(
  catalog: AnthropicCatalogEntry[],
  label: string
): AnthropicCatalogEntry | null {
  return catalog.find((m) => m.family === label.trim()) ?? null;
}

export const ONE_MILLION_MARKER = /\[1m\]|\(1M\)/i;
