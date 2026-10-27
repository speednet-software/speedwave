import type { ToolDefinition } from '@speedwave/mcp-shared';

/**
 * Sorted property names of an object schema.
 * @param schema - A JSON schema with `properties`.
 * @returns The property names, sorted.
 */
export function schemaKeys(schema: unknown): string[] {
  return Object.keys((schema as { properties: Record<string, unknown> }).properties).sort();
}

/**
 * Sorted field names an outputSchema declares for one result key (the item shape for arrays).
 * @param tools - The tool definitions.
 * @param toolName - The tool to inspect.
 * @param key - The result key.
 * @returns The declared field names, sorted.
 */
export function declaredFields(tools: ToolDefinition[], toolName: string, key: string): string[] {
  const tool = tools.find((d) => d.tool.name === toolName)!.tool;
  const prop = (tool.outputSchema!.properties as Record<string, Record<string, unknown>>)[key];
  return schemaKeys(prop.items ?? prop);
}
