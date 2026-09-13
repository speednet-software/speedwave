/** Direct Tauri-bridge access to the Anthropic model catalog (SPEED-545) — a spec reads
 *  the SSOT catalog itself (`list_anthropic_models`) instead of hard-coding a model id. */

/** Mirrors `speedwave_runtime::defaults::AnthropicModelInfo` (`models/llm.ts::AnthropicModel`). */
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

/** Fetches the full Anthropic catalog via `list_anthropic_models`. */
export async function anthropicCatalog(): Promise<AnthropicCatalogEntry[]> {
  return browser.executeAsync((done: (rows: AnthropicCatalogEntry[]) => void) => {
    (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<AnthropicCatalogEntry[]> };
      }
    ).__TAURI_INTERNALS__.invoke('list_anthropic_models')
      .then((rows) => done(rows))
      .catch(() => done([]));
  });
}

/** Catalog ids marked `latest: true` — the account-default set the fresh-install
 *  scenario checks membership against (never a hard-coded specific model id). */
export async function latestAnthropicModelIds(): Promise<string[]> {
  const rows = await anthropicCatalog();
  return rows.filter((r) => r.latest).map((r) => r.id);
}

/** Maps a `composer-model-badge` label (`entry.family`, optionally suffixed ` [1m]`)
 *  back to its catalog entry, or `null` for an unrecognized/verbatim-shown value. */
export function catalogEntryForBadgeLabel(
  catalog: AnthropicCatalogEntry[],
  label: string
): AnthropicCatalogEntry | null {
  const bare = label.replace(/ \[1m\]$/, '').trim();
  return catalog.find((m) => m.family === bare) ?? null;
}
