/**
 * Gemini Tools Index
 * @module tools/gemini
 *
 * Exports all Gemini tool metadata for progressive discovery.
 * Tools are loaded dynamically by the search_tools handler.
 *
 * Available tools (1):
 * - chat: Analyze arbitrary text content
 */

import { ToolMetadata } from '../../hub-types.js';
import { metadata as chat } from './gemini_chat.js';

/**
 * All Gemini tools metadata (keyed by tool name)
 * Used by search_tools for progressive discovery
 */
export const toolMetadata: Record<string, ToolMetadata> = {
  chat,
};

/**
 * All Gemini tool names
 */
export const tools = Object.keys(toolMetadata) as (keyof typeof toolMetadata)[];

/**
 * Type representing a valid Gemini tool name
 */
export type GeminiToolName = keyof typeof toolMetadata;
