import { invokeOr } from './tauri-invoke';

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
  return invokeOr<AnthropicCatalogEntry[]>([], 'list_anthropic_models');
}

export async function latestAnthropicModelIds(): Promise<string[]> {
  const rows = await anthropicCatalog();
  return rows.filter((r) => r.latest).map((r) => r.id);
}

export async function modelPickerRowIds(project: string): Promise<string[] | null> {
  const picker = await invokeOr<{ rows: { id: string }[] } | null>(null, 'list_model_picker', {
    project,
  });
  return picker ? picker.rows.map((r) => r.id) : null;
}

export function catalogEntryForBadgeLabel(
  catalog: AnthropicCatalogEntry[],
  label: string
): AnthropicCatalogEntry | null {
  return catalog.find((m) => m.family === label.trim()) ?? null;
}

export const ONE_MILLION_MARKER = /\[1m\]|\(1M\)/i;
