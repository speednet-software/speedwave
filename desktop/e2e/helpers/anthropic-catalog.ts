export interface AnthropicCatalogEntry {
  id: string;
  family: string;
  context_tokens: number;
  latest: boolean;
  premium: boolean;
  selectable: boolean;
  has_1m: boolean;
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

export function catalogEntryForBadgeLabel(
  catalog: AnthropicCatalogEntry[],
  label: string
): AnthropicCatalogEntry | null {
  const bare = label.replace(/ \[1m\]$/, '').trim();
  return catalog.find((m) => m.family === bare) ?? null;
}
