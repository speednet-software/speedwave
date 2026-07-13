/**
 * Path Utilities Module - Common path manipulation functions
 * @module sharepoint/path-utils
 */

/**
 * Result of splitting a path into parent directory and name
 * @interface SplitPathResult
 */
export interface SplitPathResult {
  /** Parent directory path */
  parentDir: string;
  /** File or folder name */
  name: string;
}

/**
 * Split a path into parent directory and name.
 * @param fullPath - full path to split
 * @returns parent directory and name
 */
export function splitPath(fullPath: string): SplitPathResult {
  const parts = fullPath.split('/');
  const name = parts.pop() || '';
  return { parentDir: parts.join('/'), name };
}

/**
 * Parse error message from a Graph API response; falls back to defaultMessage if unparsable.
 * @param response - fetch response object
 * @param defaultMessage - default message if parsing fails
 * @returns error message
 */
export async function parseGraphErrorMessage(
  response: Response,
  defaultMessage: string
): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return defaultMessage;
    }
    try {
      const data = JSON.parse(text) as { error?: { message?: string } };
      return data.error?.message || defaultMessage;
    } catch {
      // JSON parsing failed, return raw text
      return text;
    }
  } catch {
    return defaultMessage;
  }
}
