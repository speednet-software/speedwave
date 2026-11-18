import { Injectable } from '@angular/core';
import type { NormalizedToolInput } from '../models/chat';
import { normalizeToolInput } from '../models/tool-input';

/** Parses raw tool input JSON into typed display models based on tool name. */
@Injectable({ providedIn: 'root' })
export class ToolNormalizerService {
  /**
   * Parses raw tool input JSON into a typed display model.
   * @param toolName - The Claude tool name (e.g. "Bash", "Read").
   * @param inputJson - The raw JSON string of tool input parameters.
   */
  normalize(toolName: string, inputJson: string): NormalizedToolInput {
    return normalizeToolInput(toolName, inputJson);
  }
}
