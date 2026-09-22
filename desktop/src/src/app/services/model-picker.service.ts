import { Injectable, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { AnthropicModelsService } from './anthropic-models.service';
import {
  canonicalModelId,
  withoutOneMillionSuffix,
  type ModelPicker,
  type ModelPickerRow,
} from '../models/model-picker';

const DEFAULT_ALIAS = 'default';

/**
 * Anthropic model picker rows per project (`list_model_picker`) and the one display-label
 * function shared by the picker, the composer pill, message metadata and the `/model` chip.
 */
@Injectable({ providedIn: 'root' })
export class ModelPickerService {
  private readonly tauri = inject(TauriService);
  private readonly log = inject(LoggerService);
  private readonly models = inject(AnthropicModelsService);
  private readonly pickers = signal<ReadonlyMap<string, ModelPicker>>(new Map());

  /** Loads the catalog the labels are keyed by. */
  constructor() {
    void this.models.list();
  }

  /**
   * Last fetched picker of a project (signal read), or `null` before the first fetch.
   * @param project - Project the rows belong to.
   */
  picker(project: string): ModelPicker | null {
    return this.pickers().get(project) ?? null;
  }

  /**
   * Re-reads the rows and returns the rows held afterwards: a session that has not reported its
   * models yet (`null` from the backend) and a failed call both keep the previous rows.
   * @param project - Project the rows belong to.
   */
  async refresh(project: string): Promise<ModelPicker | null> {
    try {
      const picker = await this.tauri.invoke<ModelPicker | null>('list_model_picker', {
        project,
      });
      if (picker) {
        const next = new Map(this.pickers());
        next.set(project, picker);
        this.pickers.set(next);
      }
    } catch (e: unknown) {
      this.log.warn(`list_model_picker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.picker(project);
  }

  /**
   * Row the given wire, pinned or observed model id belongs to (signal read).
   * @param project - Project whose rows are searched.
   * @param modelId - Any spelling of the model id, or the `default` alias.
   */
  rowFor(project: string, modelId: string): ModelPickerRow | null {
    const rows = this.picker(project)?.rows ?? [];
    if (modelId === DEFAULT_ALIAS) return rows.find((r) => r.is_default) ?? null;
    const id = canonicalModelId(modelId);
    return rows.find((r) => r.id === id) ?? null;
  }

  /**
   * User-visible name of a model: the catalog family, else Claude Code's cleaned display name,
   * else the id without the `claude-` prefix, snapshot date and 1M suffix (signal read).
   * @param modelId - Any spelling of the model id; non-Anthropic ids pass through.
   * @param project - Project whose picker rows may name a model the catalog lacks.
   */
  label(modelId: string, project: string | null): string {
    if (!modelId) return '';
    if (modelId === DEFAULT_ALIAS) {
      const row = project ? this.rowFor(project, modelId) : null;
      return row ? this.label(row.id, project) : DEFAULT_ALIAS;
    }
    const family = this.models.familyLabelFor(modelId);
    if (family) return family;
    const named = project ? this.rowFor(project, modelId)?.display_name : null;
    if (named) return named;
    if (!modelId.trim().startsWith('claude-')) return withoutOneMillionSuffix(modelId);
    return canonicalModelId(modelId)
      .replace(/^claude-/, '')
      .replace(/-(\d+)-(\d+)$/, '-$1.$2');
  }
}
